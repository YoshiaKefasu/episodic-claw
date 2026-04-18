/**
 * OpenRouter Chat Completion API client.
 * KISS: Uses Node 18+ built-in fetch(). No external HTTP library dependency.
 *
 * v0.4.19d: Typed error classification (OpenRouterError), 200+error detection,
 * retriable/non-retriable classification, exponential backoff with Retry-After support.
 */

// ─── Error Classification ────────────────────────────────────────────────────

/** OpenRouter error classification for observability and retry logic. */
export type OpenRouterErrorClass =
  | "missing_choices"        // 200 but choices array missing/empty
  | "empty_content"          // 200 but content is empty string
  | "non_string_content"    // 200 but content is non-string (object, null, etc.)
  | "error_wrapped_200"     // 200 but data.error present (generic)
  | "provider_503"          // 200 + data.error.code=503 (provider temporary failure)
  | "provider_429"          // 200 + data.error.code=429 (provider rate limit)
  | "provider_400_policy"   // 200 + data.error.code=400 (model mismatch / policy)
  | "http_429"              // HTTP 429 (OpenRouter rate limit)
  | "http_5xx"              // HTTP 5xx (server error)
  | "http_400"               // HTTP 400 (bad request)
  | "http_401"              // HTTP 401 (auth error)
  | "http_403"              // HTTP 403 (forbidden)
  | "timeout"               // AbortController timeout
  | "network"               // network error
  | "circuit_open"          // circuit breaker open
  | "http_unknown";         // other HTTP error

/** Classify an error code from data.error.code (wrapped in HTTP 200). */
function classifyErrorCode(code: number | string): OpenRouterErrorClass {
  const numCode = typeof code === "string" ? parseInt(code, 10) : code;
  if (numCode === 503) return "provider_503";
  if (numCode === 429) return "provider_429";
  if (numCode === 400) return "provider_400_policy"; // 200-wrapped 400 = policy error
  return "error_wrapped_200"; // generic
}

/** Determine if a 200-wrapped error code is retriable. */
function isRetriableErrorCode(code: number | string): boolean {
  const numCode = typeof code === "string" ? parseInt(code, 10) : code;
  // 503 = temporary provider failure, 429 = rate limit → retriable
  // 400 = policy/model mismatch → NOT retriable (fallback target)
  return numCode === 503 || numCode === 429;
}

/**
 * Typed error for OpenRouter API responses.
 * Replaces `(err as any)` casts with structured error metadata.
 */
export class OpenRouterError extends Error {
  readonly openRouterErrorClass: OpenRouterErrorClass;
  readonly retriable: boolean;
  readonly retryAfterSeconds: number;
  readonly providerErrorCode?: number;
  readonly providerName?: string;

  constructor(params: {
    message: string;
    errorClass: OpenRouterErrorClass;
    retriable: boolean;
    retryAfterSeconds?: number;
    providerErrorCode?: number;
    providerName?: string;
  }) {
    super(params.message);
    this.name = "OpenRouterError";
    this.openRouterErrorClass = params.errorClass;
    this.retriable = params.retriable;
    this.retryAfterSeconds = params.retryAfterSeconds ?? 0;
    this.providerErrorCode = params.providerErrorCode;
    this.providerName = params.providerName;
  }
}

// ─── Circuit Breaker ──────────────────────────────────────────────────────────

/**
 * Simple circuit breaker for per-model failure tracking.
 * After `threshold` consecutive failures, enters OPEN state and blocks requests
 * for `resetTimeoutMs`. After the timeout, transitions to HALF-OPEN and allows
 * one probe request. On success, returns to CLOSED; on failure, back to OPEN.
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly threshold: number = 5,
    private readonly resetTimeoutMs: number = 300_000, // 5 min
  ) {}

  get currentState(): string { return this.state; }

  recordSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
    }
  }

  canAttempt(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = "half-open";
        return true; // allow one probe
      }
      return false;
    }
    // half-open: allow one probe request
    return true;
  }
}

// ─── Config & Client ──────────────────────────────────────────────────────────

export interface OpenRouterConfig {
  apiKey: string;
  model: string;           // default: "openrouter/free"
  maxTokens?: number;      // undefined = let OpenRouter/model decide (recommended)
  temperature: number;     // default: 0.4
  baseUrl: string;         // default: "https://openrouter.ai/api/v1"
  timeoutMs: number;       // default: 30000
  maxRetries: number;      // default: 3 (transport-level retries)
  baseRetryDelayMs: number; // default: 1000 (exponential backoff base for transport)
  maxRetryDelayMs: number;  // default: 30000 (cap for transport backoff)
  // Reasoning config (normalized from openrouterConfig.reasoning)
  reasoning?: {
    effort?: string;
    maxTokens?: number;
    exclude?: boolean;
  };
}

const DEFAULT_CONFIG: Omit<OpenRouterConfig, "apiKey"> = {
  model: "openrouter/free",
  temperature: 0.4,        // factual, consistent
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 30000,
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  maxRetryDelayMs: 30000,
};

export class OpenRouterClient {
  private config: OpenRouterConfig;
  // [v0.4.19d] Per-model circuit breaker state
  private circuitBreakers = new Map<string, CircuitBreaker>();

  constructor(config: Partial<OpenRouterConfig> & { apiKey: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getCircuitBreaker(model: string): CircuitBreaker {
    const existing = this.circuitBreakers.get(model);
    if (existing) return existing;
    const created = new CircuitBreaker();
    this.circuitBreakers.set(model, created);
    return created;
  }

  /**
   * Send a chat completion request to OpenRouter.
   * Handles retries with exponential backoff, Retry-After headers,
   * typed error classification (OpenRouterError), and circuit breaker.
   * Optionally override the model per-request for fallback support.
   */
  async chatCompletion(
    params: { systemPrompt: string; userMessage: string },
    opts?: { modelOverride?: string },
  ): Promise<string> {
    const { systemPrompt, userMessage } = params;
    const model = opts?.modelOverride ?? this.config.model;
    const circuitBreaker = this.getCircuitBreaker(model);

    // Circuit breaker check
    if (!circuitBreaker.canAttempt()) {
      throw new OpenRouterError({
        message: `OpenRouter circuit breaker OPEN for model=${model}. Cooling down before retry.`,
        errorClass: "circuit_open",
        retriable: true, // circuit breaker is temporary
      });
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.min(
          this.config.baseRetryDelayMs * Math.pow(2, attempt - 1),
          this.config.maxRetryDelayMs,
        );
        // Honor Retry-After header if present (from 429 / provider_429)
        const retryAfterSec = lastError instanceof OpenRouterError
          ? lastError.retryAfterSeconds
          : 0;
        const actualDelay = retryAfterSec > 0
          ? Math.max(delayMs, retryAfterSec * 1000)
          : delayMs;
        await this.sleep(actualDelay);
      }

      try {
        const result = await this.doCompletion(systemPrompt, userMessage, model);
        circuitBreaker.recordSuccess();
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Typed OpenRouterError: use .retriable property for retry decision
        if (lastError instanceof OpenRouterError) {
          if (!lastError.retriable) {
            // Non-retriable: immediate throw (401, 403, policy errors, etc.)
            circuitBreaker.recordFailure();
            throw lastError;
          }
          // Retriable: log and continue loop (backoff already calculated above)
          console.warn(
            `[OpenRouter] Attempt ${attempt + 1}/${this.config.maxRetries + 1} failed ` +
            `[${lastError.openRouterErrorClass}] model=${model}: ${lastError.message.slice(0, 200)}. Retrying...`
          );
          continue;
        }

        // Legacy/generic errors: only retry if they look like network/timeout issues
        // 401/403 are never retriable regardless of format
        const msg = lastError.message;
        if (msg.includes("401") || msg.includes("403")) {
          circuitBreaker.recordFailure();
          throw lastError;
        }
        // Other generic errors: assume retriable (network, timeout, etc.)
      }
    }

    // Count this chatCompletion call as one failed attempt for circuit breaker
    circuitBreaker.recordFailure();
    throw lastError ?? new Error("OpenRouter chat completion failed after retries");
  }

  /**
   * Single HTTP request to OpenRouter chat completion endpoint.
   * Classifies responses into typed OpenRouterError for retry logic.
   */
  private async doCompletion(systemPrompt: string, userMessage: string, model?: string): Promise<string> {
    const effectiveModel = model ?? this.config.model;
    const url = `${this.config.baseUrl}/chat/completions`;
    const body: Record<string, any> = {
      model: effectiveModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: this.config.temperature,
    };
    if (this.config.maxTokens !== undefined) {
      body.max_tokens = this.config.maxTokens;
    }

    // Conditionally include reasoning config
    if (this.config.reasoning) {
      const reasoning: Record<string, any> = {};
      if (this.config.reasoning.effort !== undefined) {
        reasoning.effort = this.config.reasoning.effort;
      }
      if (this.config.reasoning.maxTokens !== undefined) {
        reasoning.max_tokens = this.config.reasoning.maxTokens;
      }
      if (this.config.reasoning.exclude === true) {
        reasoning.exclude = true;
      }
      if (Object.keys(reasoning).length > 0) {
        body.reasoning = reasoning;
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
          "HTTP-Referer": "https://github.com/YoshiaKefasu/episodic-claw",
          "X-Title": "episodic-claw",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // ─── Phase 1: HTTP error responses (4xx, 5xx) ────────────────────────
      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        const errorText = await response.text().catch(() => "");
        const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : 0;

        let errorClass: OpenRouterErrorClass;
        let retriable: boolean;

        if (response.status === 429) {
          errorClass = "http_429";
          retriable = true;
        } else if (response.status >= 500) {
          errorClass = "http_5xx";
          retriable = true;
        } else if (response.status === 400) {
          // 400 might be a provider policy error (model mismatch, instruction not enabled, etc.)
          errorClass = "http_400";
          retriable = false;
          if (errorText.includes("Developer instruction") || errorText.includes("not enabled for model")) {
            errorClass = "provider_400_policy";
            // provider_400_policy is NOT retriable but IS a fallback candidate
          }
        } else if (response.status === 401) {
          errorClass = "http_401";
          retriable = false;
        } else if (response.status === 403) {
          errorClass = "http_403";
          retriable = false;
        } else {
          errorClass = "http_unknown";
          retriable = false;
        }

        throw new OpenRouterError({
          message: `OpenRouter HTTP ${response.status} [${errorClass}]: ${errorText.slice(0, 200)}`,
          errorClass,
          retriable,
          retryAfterSeconds,
        });
      }

      // ─── Phase 2: HTTP 200 but data.error present ────────────────────────
      const data = await response.json();

      if (data?.error && typeof data.error === "object") {
        const errorCode = data.error.code ?? 0;
        const errorMsg = data.error.message ?? "unknown error";
        const numCode = typeof errorCode === "number" ? errorCode : parseInt(String(errorCode), 10);

        throw new OpenRouterError({
          message: `OpenRouter error_wrapped_200: code=${errorCode} message=${errorMsg.slice(0, 200)}`,
          errorClass: classifyErrorCode(errorCode),
          retriable: isRetriableErrorCode(errorCode),
          providerErrorCode: numCode,
          providerName: data.error.metadata?.provider_name,
        });
      }

      // ─── Phase 3: choices structure validation ───────────────────────────
      const content = data?.choices?.[0]?.message?.content;

      if (typeof content !== "string" || content.trim().length === 0) {
        // Classify the specific empty-response subtype for observability
        let errorClass: OpenRouterErrorClass;
        if (!Array.isArray(data?.choices) || data.choices.length === 0) {
          errorClass = "missing_choices"; // no choices array at all
        } else if (data.choices[0]?.message && typeof data.choices[0]?.message?.content !== "string") {
          errorClass = typeof data.choices[0].message.content === "object" && data.choices[0].message.content !== null
            ? "non_string_content"
            : "missing_choices"; // null, undefined, or absent
        } else {
          errorClass = "empty_content"; // content is "" or whitespace-only
        }

        throw new OpenRouterError({
          message: `OpenRouter empty_response: ${errorClass}`,
          errorClass,
          retriable: true, // empty responses are typically transient (provider routing jitter)
        });
      }

      return content.trim();
    } catch (err) {
      // Convert AbortError to typed timeout error
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new OpenRouterError({
          message: `OpenRouter request timeout after ${this.config.timeoutMs}ms`,
          errorClass: "timeout",
          retriable: true,
        });
      }
      // Re-throw OpenRouterError as-is (already classified)
      if (err instanceof OpenRouterError) {
        throw err;
      }
      // Generic network/fetch errors
      if (err instanceof TypeError && err.message.includes("fetch")) {
        throw new OpenRouterError({
          message: `OpenRouter network error: ${err.message.slice(0, 200)}`,
          errorClass: "network",
          retriable: true,
        });
      }
      // Unknown errors: wrap as retriable to avoid crashing the worker
      throw new OpenRouterError({
        message: `OpenRouter unexpected error: ${err instanceof Error ? err.message : String(err).slice(0, 200)}`,
        errorClass: "http_unknown",
        retriable: true,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
