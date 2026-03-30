package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type GoogleStudioProvider struct {
	APIKey string
	Model  string
	client *http.Client
}

func NewGoogleStudioProvider(apiKey string, model string) *GoogleStudioProvider {
	return &GoogleStudioProvider{
		APIKey: apiKey,
		Model:  model,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
	}
}

// --- Payload structs for Gemini API ---

type Part struct {
	Text string `json:"text"`
}

type Content struct {
	Role  string `json:"role,omitempty"`
	Parts []Part `json:"parts"`
}

type embedContentRequest struct {
	Model   string  `json:"model"`
	Content Content `json:"content"`
}

type embedContentResponse struct {
	Embedding struct {
		Values []float32 `json:"values"`
	} `json:"embedding"`
}

type batchEmbedContentRequest struct {
	Requests []embedContentRequest `json:"requests"`
}

type batchEmbedContentResponse struct {
	Embeddings []struct {
		Values []float32 `json:"values"`
	} `json:"embeddings"`
}

type generateContentRequest struct {
	Contents []Content `json:"contents"`
}

type generateContentResponse struct {
	Candidates []struct {
		Content Content `json:"content"`
	} `json:"candidates"`
}

// --- Implementation ---

// MaxEmbedRunes is the rune-based truncation limit for EmbedContent input.
// Gemini Embedding 2 accepts ~8,192 tokens; Japanese is ~1 token/char, English is ~1 token/4 chars.
// 8,000 runes is a conservative safe limit that fits both scripts.
// Using rune-based (not byte-based) slicing to avoid invalid UTF-8 on multi-byte characters.
const MaxEmbedRunes = 8000

func (p *GoogleStudioProvider) EmbedContent(ctx context.Context, text string) ([]float32, error) {
	var err error
	text, err = normalizeEmbedText(text)
	if err != nil {
		return nil, err
	}

	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:embedContent?key=%s", p.Model, p.APIKey)

	reqBody := embedContentRequest{
		Model:   "models/" + p.Model,
		Content: Content{Parts: []Part{{Text: text}}},
	}
	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal embed request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		apiErr := &APIError{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
		// Case 4 / HIGH-3: propagate Retry-After header so RetryEmbedder can
		// honour the server-mandated wait instead of guessing with exponential backoff.
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			apiErr = apiErr.WithRetryAfter(ParseRetryAfterHeader(ra))
		}
		return nil, apiErr
	}

	var res embedContentResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return res.Embedding.Values, nil
}

func (p *GoogleStudioProvider) GenerateText(ctx context.Context, prompt string) (string, error) {
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:generateContent?key=%s", p.Model, p.APIKey)

	reqBody := generateContentRequest{
		Contents: []Content{
			{Role: "user", Parts: []Part{{Text: prompt}}},
		},
	}
	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("failed to marshal generate request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		apiErr := &APIError{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			apiErr = apiErr.WithRetryAfter(ParseRetryAfterHeader(ra))
		}
		return "", apiErr
	}

	var res generateContentResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", fmt.Errorf("failed to decode response: %w", err)
	}

	if len(res.Candidates) == 0 || len(res.Candidates[0].Content.Parts) == 0 {
		return "", fmt.Errorf("empty response from API")
	}

	return res.Candidates[0].Content.Parts[0].Text, nil
}

// EmbedContentBatch sends multiple texts in a single batchEmbedContents request.
// Each text is truncated to MaxEmbedRunes before sending (same as EmbedContent).
// Returns one embedding vector per input text, in the same order.
// Use this in rebuild paths to reduce RPM: N files → 1 HTTP request.
func (p *GoogleStudioProvider) EmbedContentBatch(ctx context.Context, texts []string) ([][]float32, error) {
	reqs := make([]embedContentRequest, len(texts))
	for i, text := range texts {
		var err error
		text, err = normalizeEmbedText(text)
		if err != nil {
			return nil, fmt.Errorf("batch embed: empty text at index %d: %w", i, err)
		}
		reqs[i] = embedContentRequest{
			Model:   "models/" + p.Model,
			Content: Content{Parts: []Part{{Text: text}}},
		}
	}

	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:batchEmbedContents?key=%s", p.Model, p.APIKey)

	reqBody := batchEmbedContentRequest{Requests: reqs}
	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal batch embed request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("failed to create batch request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("batch request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		apiErr := &APIError{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			apiErr = apiErr.WithRetryAfter(ParseRetryAfterHeader(ra))
		}
		return nil, apiErr
	}

	var res batchEmbedContentResponse
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, fmt.Errorf("failed to decode batch response: %w", err)
	}

	results := make([][]float32, len(res.Embeddings))
	for i, emb := range res.Embeddings {
		results[i] = emb.Values
	}
	return results, nil
}
