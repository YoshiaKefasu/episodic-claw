package ai

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"
)

// EmbeddingProvider provides an interface for converting text into vector embeddings.
type EmbeddingProvider interface {
	EmbedContent(ctx context.Context, text string) ([]float32, error)
}

// LLMProvider provides an interface for performing text generation tasks.
type LLMProvider interface {
	GenerateText(ctx context.Context, prompt string) (string, error)
}

// APIError represents an HTTP error from an API provider.
// Callers can type-assert to inspect the status code and decide whether to retry.
type APIError struct {
	StatusCode    int
	Body          string
	// RetryAfterDur is the server-mandated wait duration from the Retry-After response header.
	// Set exclusively via WithRetryAfter() by google_studio.go; callers should use RetryAfter() method.
	// Exported (P3) to allow direct field inspection in tests and structured logging.
	RetryAfterDur time.Duration
}

// ErrEmptyEmbedInput marks a validation failure, not a transient provider outage.
// Callers should treat it as non-retryable and skip or reject the request.
var ErrEmptyEmbedInput = errors.New("embed input is empty")

func (e *APIError) Error() string {
	return fmt.Sprintf("API error (status %d): %s", e.StatusCode, e.Body)
}

// IsRetryable returns true for transient errors (429 rate limit, 5xx server errors).
func (e *APIError) IsRetryable() bool {
	return e.StatusCode == 429 || e.StatusCode >= 500
}

// RetryAfter returns the Retry-After duration parsed from the API response header.
// Returns 0 if the header was not present or could not be parsed.
func (e *APIError) RetryAfter() time.Duration {
	return e.RetryAfterDur
}

// IsRateLimitError returns true if err is (or wraps) an APIError with HTTP 429.
// Use this in Circuit Breaker logic to distinguish quota exhaustion from
// unrelated failures (parse errors, timeouts, network drops).
func IsRateLimitError(err error) bool {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == http.StatusTooManyRequests // 429
	}
	return false
}

// WithRetryAfter returns a copy of the APIError with RetryAfterDur set to d.
// Called exclusively by google_studio.go after reading the response header.
func (e *APIError) WithRetryAfter(d time.Duration) *APIError {
	copy := *e
	copy.RetryAfterDur = d
	return &copy
}

// --- Retry Decorators ---
// These wrap concrete providers with retry logic, coordinating with
// the caller's rate.Limiter so retried requests are properly throttled.

// RetryEmbedder wraps an EmbeddingProvider with retry-on-429/5xx.
type RetryEmbedder struct {
	Inner      EmbeddingProvider
	Limiter    *rate.Limiter
	MaxRetries int
	BaseDelay  time.Duration
}

func (r *RetryEmbedder) EmbedContent(ctx context.Context, text string) ([]float32, error) {
	normalized, err := normalizeEmbedText(text)
	if err != nil {
		return nil, err
	}

	backoff := r.BaseDelay
	for attempt := 0; ; attempt++ {
		// Coordinate with the caller's rate limiter before each attempt
		if r.Limiter != nil {
			waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := r.Limiter.Wait(waitCtx); err != nil {
				cancel()
				return nil, fmt.Errorf("rate limiter wait failed: %w", err)
			}
			cancel()
		}

		result, err := r.Inner.EmbedContent(ctx, normalized)
		if err == nil {
			return result, nil
		}

		apiErr, ok := err.(*APIError)
		if !ok || !apiErr.IsRetryable() || attempt >= r.MaxRetries {
			return nil, err
		}

		wait := backoff
		if ra := apiErr.RetryAfter(); ra > 0 {
			wait = ra
		}
		fmt.Fprintf(os.Stderr, "[RetryEmbedder] HTTP %d (attempt %d/%d), retrying after %v\n",
			apiErr.StatusCode, attempt+1, r.MaxRetries, wait)

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
			backoff *= 2
		}
	}
}

// RetryLLM wraps an LLMProvider with retry-on-429/5xx.
type RetryLLM struct {
	Inner      LLMProvider
	Limiter    *rate.Limiter
	MaxRetries int
	BaseDelay  time.Duration
}

func (r *RetryLLM) GenerateText(ctx context.Context, prompt string) (string, error) {
	backoff := r.BaseDelay
	for attempt := 0; ; attempt++ {
		if r.Limiter != nil {
			waitCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			if err := r.Limiter.Wait(waitCtx); err != nil {
				cancel()
				return "", fmt.Errorf("rate limiter wait failed: %w", err)
			}
			cancel()
		}

		result, err := r.Inner.GenerateText(ctx, prompt)
		if err == nil {
			return result, nil
		}

		apiErr, ok := err.(*APIError)
		if !ok || !apiErr.IsRetryable() || attempt >= r.MaxRetries {
			return "", err
		}

		wait := backoff
		if ra := apiErr.RetryAfter(); ra > 0 {
			wait = ra
		}
		fmt.Fprintf(os.Stderr, "[RetryLLM] HTTP %d (attempt %d/%d), retrying after %v\n",
			apiErr.StatusCode, attempt+1, r.MaxRetries, wait)

		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(wait):
			backoff *= 2
		}
	}
}

// NewRetryPair creates a RetryEmbedder and RetryLLM from concrete providers,
// reusing the caller's rate limiters. This is the standard way to add retry
// in consolidation.go — no retry logic needed in the provider or the caller.
func NewRetryPair(
	llm LLMProvider, embed EmbeddingProvider,
	llmLimiter, embedLimiter *rate.Limiter,
) (LLMProvider, EmbeddingProvider) {
	return &RetryLLM{
			Inner:      llm,
			Limiter:    llmLimiter,
			MaxRetries: 3,
			BaseDelay:  2 * time.Second,
		}, &RetryEmbedder{
			Inner:      embed,
			Limiter:    embedLimiter,
			MaxRetries: 3,
			BaseDelay:  2 * time.Second,
		}
}

// ParseRetryAfterHeader parses a Retry-After header value (seconds).
// Exported for use by providers that can access HTTP headers.
func ParseRetryAfterHeader(value string) time.Duration {
	if secs, err := strconv.Atoi(value); err == nil {
		return time.Duration(secs) * time.Second
	}
	return 0
}

func normalizeEmbedText(text string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", ErrEmptyEmbedInput
	}

	runes := []rune(text)
	if len(runes) > MaxEmbedRunes {
		text = string(runes[:MaxEmbedRunes])
	}
	return text, nil
}
