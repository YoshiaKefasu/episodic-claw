import eld from "eld";

let eldLoaded = false;

/**
 * Initialize the eld language detector (loads the ngrams database).
 * Call this once during plugin warm-up to avoid first-query latency.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initLanguageDetector(): Promise<boolean> {
  if (eldLoaded) return true;
  try {
    if (typeof (eld as any).load === "function") {
      await (eld as any).load();
    }
    eldLoaded = true;
    return true;
  } catch {
    return false;
  }
}

export type DetectedLanguage = "ja" | "zh" | "ko" | "en" | "id" | "unknown";

/** [v0.4.28a] Normalize eld's raw language code to our DetectedLanguage.
 *  DRY single source of truth — used by both detectLanguage() and detectLanguageDetailed().
 *  Maps 'ms' (Malay) → 'id' (Indonesian) for stopword/tokenizer routing purposes.
 */
function normalizeEldLang(rawLang: string): DetectedLanguage {
  switch (rawLang) {
    case "ja": return "ja";
    case "zh": return "zh";
    case "ko": return "ko";
    case "en": return "en";
    case "id":
    case "ms": return "id"; // Malay is close enough to Indonesian for stopword purposes
    default: return "unknown";
  }
}

/**
 * Detect the dominant language of a text string.
 * Returns a normalized language code suitable for routing to the appropriate tokenizer.
 *
 * Note: eld must be loaded before calling this. If not loaded, falls back to "unknown".
 */
export function detectLanguage(text: string): DetectedLanguage {
  if (!eldLoaded) return "unknown";

  try {
    const result = eld.detect(text);
    return normalizeEldLang(result.language);
  } catch {
    return "unknown";
  }
}

/** [v0.4.28a] Detailed language detection result for language guard.
 *  Returns the detected language, confidence score, and reliability flag.
 *  Uses eld's getScores() and isReliable() APIs.
 *
 *  Transplanted from Guardrails AI correct_language validator pattern,
 *  adapted from langdetect → eld (project's existing detector).
 */
export interface DetectLanguageDetailedResult {
  lang: DetectedLanguage;
  /** Confidence score 0..1 from eld.getScores(). eld.load() always provides scores. */
  confidence: number;
  /** Whether eld considers the detection reliable (built-in heuristic). */
  isReliable: boolean;
}

export function detectLanguageDetailed(text: string): DetectLanguageDetailedResult {
  if (!eldLoaded) {
    return { lang: "unknown", confidence: 0, isReliable: false };
  }

  try {
    // [BUG#1 fix] Call eld.detect() ONCE and derive both lang and confidence from the same result.
    // Previous version called detectLanguage() (which internally calls eld.detect()) then
    // called eld.detect() again — double-processing potentially 200KB of text.
    const result = eld.detect(text);
    const rawLang = result.language;

    // DRY: use shared normalization (same mapping as detectLanguage())
    const lang = normalizeEldLang(rawLang);

    if (lang === "unknown") {
      return { lang, confidence: 0, isReliable: false };
    }

    // [BUG#2 fix] eld stores the score under its INTERNAL code ('ms' for Malay/Indonesian).
    // Our DetectedLanguage normalizes 'ms' → 'id', but score lookup must use eld's original key.
    const scoreLookupKey = rawLang; // 'ms' for Indonesian, original code for others
    const scores = typeof result.getScores === "function" ? result.getScores() : {};
    // [P1 fix] Number.isFinite() guard: NaN >= threshold is always false,
    // which would cause language mismatches to be silently missed.
    const rawScore = typeof scores === "object" && scores !== null && scoreLookupKey in scores
      ? scores[scoreLookupKey]
      : 0;
    const confidence = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : 0;
    const isReliable = typeof result.isReliable === "function" ? result.isReliable() : false;

    return { lang, confidence, isReliable };
  } catch {
    return { lang: "unknown", confidence: 0, isReliable: false };
  }
}
