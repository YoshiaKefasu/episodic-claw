/**
 * OpenRouter Chat Completion API client.
 * KISS: Uses Node 18+ built-in fetch(). No external HTTP library dependency.
 */

export interface OpenRouterConfig {
  apiKey: string;
  model: string;           // default: "openrouter/free"
  maxTokens?: number;      // undefined = let OpenRouter/model decide (recommended)
  temperature: number;     // default: 0.4
  baseUrl: string;         // default: "https://openrouter.ai/api/v1"
  timeoutMs: number;       // default: 30000
  maxRetries: number;      // default: 3
}

const DEFAULT_CONFIG: Omit<OpenRouterConfig, "apiKey"> = {
  model: "openrouter/free",
  temperature: 0.4,        // factual, consistent
  baseUrl: "https://openrouter.ai/api/v1",
  timeoutMs: 30000,
  maxRetries: 3,
};

export class OpenRouterClient {
  private config: OpenRouterConfig;

  constructor(config: Partial<OpenRouterConfig> & { apiKey: string }) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Send a chat completion request to OpenRouter.
   * Handles 429 Rate Limit with Retry-After header and exponential backoff.
   */
  async chatCompletion(params: {
    systemPrompt: string;
    userMessage: string;
  }): Promise<string> {
    const { systemPrompt, userMessage } = params;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        await this.sleep(delayMs);
      }

      try {
        const result = await this.doCompletion(systemPrompt, userMessage);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // 429 → check Retry-After header and retry
        if (lastError.message.includes("429")) {
          const retryAfter = (lastError as any).retryAfterSeconds as number ?? 0;
          if (retryAfter > 0) {
            await this.sleep(retryAfter * 1000);
            continue;
          }
        }

        // Non-retryable errors (4xx except 429)
        if (lastError.message.includes("400") || lastError.message.includes("401") || lastError.message.includes("403")) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new Error("OpenRouter chat completion failed after retries");
  }

  private async doCompletion(systemPrompt: string, userMessage: string): Promise<string> {
    const url = `${this.config.baseUrl}/chat/completions`;
    const body: Record<string, any> = {
      model: this.config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: this.config.temperature,
    };
    if (this.config.maxTokens !== undefined) {
      body.max_tokens = this.config.maxTokens;
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

      if (!response.ok) {
        const retryAfter = response.headers.get("Retry-After");
        const errorText = await response.text().catch(() => "");
        const err = new Error(`OpenRouter HTTP ${response.status}: ${errorText.slice(0, 200)}`);
        (err as any).retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : 0;
        throw err;
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("OpenRouter returned empty or invalid response");
      }
      return content.trim();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
