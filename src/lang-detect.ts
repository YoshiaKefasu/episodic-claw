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
    const lang = result.language;

    switch (lang) {
      case "ja":
        return "ja";
      case "zh":
        return "zh";
      case "ko":
        return "ko";
      case "en":
        return "en";
      case "id":
      case "ms": // Malay is close enough to Indonesian for stopword purposes
        return "id";
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}
