import { OpenRouterError } from "./openrouter-client";
import { GeminiDirectError } from "./gemini-direct-client";

// [v0.4.30c] Transport retry schedule (API/network failures)
// B方針: 429/5xx/timeout/network を含む通信失敗は全て同じ待ち方に揃える。
export const TRANSPORT_RETRY_SCHEDULE_SEC = [60, 120, 240, 480, 960, 1280] as const;
export const MAX_TRANSPORT_RETRY_DELAY_MS = 1_280_000; // 21m20s cap (matches schedule max)

export function parseGeminiPleaseRetryInSeconds(message: string): number {
  // Example: "Please retry in 32.269782683s.."
  const m = message.match(/Please retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (!m) return 0;
  const sec = Number.parseFloat(m[1] ?? "");
  return Number.isFinite(sec) && sec > 0 ? sec : 0;
}

export function computeTransportRetryDelayMs(
  attempt: number,
  err: unknown,
): { scheduleDelayMs: number; retryAfterMs: number; finalDelayMs: number } {
  const idx = Math.min(Math.max(0, attempt), TRANSPORT_RETRY_SCHEDULE_SEC.length - 1);
  const scheduleSec = TRANSPORT_RETRY_SCHEDULE_SEC[idx];
  const scheduleDelayMs = scheduleSec * 1000;

  let retryAfterMs = 0;
  if (err instanceof OpenRouterError) {
    retryAfterMs = Math.max(0, (err.retryAfterSeconds ?? 0) * 1000);
  } else if (err instanceof GeminiDirectError) {
    retryAfterMs = Math.max(0, parseGeminiPleaseRetryInSeconds(err.message) * 1000);
  } else if (err instanceof Error) {
    // Defensive: Gemini often includes retry hints in message strings.
    retryAfterMs = Math.max(0, parseGeminiPleaseRetryInSeconds(err.message) * 1000);
  }

  const finalDelayMs = Math.min(Math.max(scheduleDelayMs, retryAfterMs), MAX_TRANSPORT_RETRY_DELAY_MS);
  return { scheduleDelayMs, retryAfterMs, finalDelayMs };
}
