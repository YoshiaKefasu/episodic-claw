/**
 * Gemini Direct API client for NarrativeWorker fallback handoff.
 *
 * Important: This client intentionally does NOT implement internal retry loops.
 * NarrativeWorker already owns phase/attempt orchestration.
 */

export type GeminiErrorClass =
  | "gemini_http_429"
  | "gemini_http_5xx"
  | "gemini_http_4xx"
  | "gemini_missing_api_key"
  | "gemini_timeout"
  | "gemini_network"
  | "gemini_empty_candidates"
  | "gemini_empty_text"
  | "gemini_invalid_payload";

export class GeminiDirectError extends Error {
  readonly geminiErrorClass: GeminiErrorClass;
  readonly retriable: boolean;
  readonly statusCode?: number;

  constructor(params: {
    message: string;
    errorClass: GeminiErrorClass;
    retriable: boolean;
    statusCode?: number;
  }) {
    super(params.message);
    this.name = "GeminiDirectError";
    this.geminiErrorClass = params.errorClass;
    this.retriable = params.retriable;
    this.statusCode = params.statusCode;
  }
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
};

export class GeminiDirectClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly maxTokens?: number;

  constructor(
    apiKey: string,
    timeoutMs: number = 30_000,
    opts?: { temperature?: number; maxTokens?: number },
  ) {
    this.apiKey = apiKey.trim();
    this.timeoutMs = timeoutMs;
    this.temperature = opts?.temperature ?? 0.4;
    this.maxTokens = opts?.maxTokens;
  }

  async generateNarrative(
    params: { systemPrompt: string; userMessage: string },
    opts?: { modelOverride?: string; thinkingLevel?: string; thinkingBudget?: number },
  ): Promise<string> {
    if (!this.apiKey) {
      throw new GeminiDirectError({
        message: "gemini_missing_api_key: GEMINI_API_KEY is empty",
        errorClass: "gemini_missing_api_key",
        retriable: false,
      });
    }

    const model = opts?.modelOverride ?? "gemini-3.1-flash-lite";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Build generationConfig with optional maxOutputTokens and thinkingConfig
      const generationConfig: Record<string, any> = {
        temperature: this.temperature,
      };
      // [v0.4.29c BUG-FIX] Only send maxOutputTokens when > 0.
      // maxTokens=0 is invalid (would produce empty output) — treat as unset.
      if (this.maxTokens !== undefined && this.maxTokens > 0) {
        generationConfig.maxOutputTokens = this.maxTokens;
      }
      // [v0.4.29c] thinkingConfig: reasoning.effort → thinkingLevel, reasoning.maxTokens → thinkingBudget
      const thinkingConfig: Record<string, any> = {};
      if (opts?.thinkingLevel) {
        thinkingConfig.thinkingLevel = opts.thinkingLevel;
      }
      if (opts?.thinkingBudget != null) {
        thinkingConfig.thinkingBudget = opts.thinkingBudget;
      }
      if (Object.keys(thinkingConfig).length > 0) {
        generationConfig.thinkingConfig = thinkingConfig;
      }

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        // [v0.5.1] Omit systemInstruction entirely when empty (no-system mode).
        // Gemini API treats absent systemInstruction as no system instruction,
        // which is distinct from systemInstruction: { parts: [{ text: "" }] }.
        body: JSON.stringify({
          ...(params.systemPrompt.trim()
            ? { systemInstruction: { parts: [{ text: params.systemPrompt }] } }
            : {}),
          contents: [
            {
              role: "user",
              parts: [{ text: params.userMessage }],
            },
          ],
          generationConfig,
        }),
        signal: controller.signal,
      });

      const rawText = await response.text();
      let data: GeminiGenerateContentResponse = {};
      if (rawText.trim().length > 0) {
        try {
          data = JSON.parse(rawText) as GeminiGenerateContentResponse;
        } catch {
          throw new GeminiDirectError({
            message: `Gemini returned non-JSON payload (status=${response.status})`,
            errorClass: "gemini_invalid_payload",
            retriable: response.status >= 500,
            statusCode: response.status,
          });
        }
      }

      if (!response.ok) {
        const errMsg = data.error?.message || `Gemini HTTP ${response.status}`;
        if (response.status === 429) {
          throw new GeminiDirectError({
            message: errMsg,
            errorClass: "gemini_http_429",
            retriable: true,
            statusCode: response.status,
          });
        }
        if (response.status >= 500) {
          throw new GeminiDirectError({
            message: errMsg,
            errorClass: "gemini_http_5xx",
            retriable: true,
            statusCode: response.status,
          });
        }
        throw new GeminiDirectError({
          message: errMsg,
          errorClass: "gemini_http_4xx",
          retriable: false,
          statusCode: response.status,
        });
      }

      const candidate = data.candidates?.[0];
      if (!candidate?.content?.parts || candidate.content.parts.length === 0) {
        throw new GeminiDirectError({
          message: "Gemini response has no candidates/parts",
          errorClass: "gemini_empty_candidates",
          retriable: true,
          statusCode: response.status,
        });
      }

      const text = candidate.content.parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("\n")
        .trim();

      if (!text) {
        throw new GeminiDirectError({
          message: "Gemini response text is empty",
          errorClass: "gemini_empty_text",
          retriable: true,
          statusCode: response.status,
        });
      }

      return text;
    } catch (err) {
      if (err instanceof GeminiDirectError) throw err;

      if (err instanceof Error && err.name === "AbortError") {
        throw new GeminiDirectError({
          message: `Gemini request timeout after ${this.timeoutMs}ms`,
          errorClass: "gemini_timeout",
          retriable: true,
        });
      }

      throw new GeminiDirectError({
        message: err instanceof Error ? err.message : String(err),
        errorClass: "gemini_network",
        retriable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
