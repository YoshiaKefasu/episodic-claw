import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EpisodicPluginConfig, NarrativeConfig, OpenRouterReasoningConfig, RecallCalibration, ForgettingConfig } from "./types";
import { getEnvVal } from "./env-var";

let warnedOpenrouterDeprecated = false;

// [v0.4.29d] Test utility to reset the one-shot warning flag
export function _resetWarnedOpenrouterDeprecatedForTest() {
  warnedOpenrouterDeprecated = false;
}

function clampUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** [v0.4.28b] Clamp a numeric config value to [min, max] with NaN/Infinity guard.
 *  Returns fallback if value is not a finite number. Same pattern as clampUnitInterval().
 *  Without this guard, Math.max(1, NaN) = NaN → comparison < NaN = false → gate silently disabled.
 */
function clampFiniteInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** [v0.4.28a] Validate and normalize narrativeExpectedLanguage.
 *  Only accepts ja|en|zh|ko|id. Invalid values → undefined (= auto, no check). */
const VALID_LANGUAGE_CODES = new Set(["ja", "en", "zh", "ko", "id"]);
function normalizeLanguageCode(value: unknown): "ja" | "en" | "zh" | "ko" | "id" | undefined {
  if (typeof value !== "string") return undefined;
  const lower = value.trim().toLowerCase();
  return VALID_LANGUAGE_CODES.has(lower) ? lower as "ja" | "en" | "zh" | "ko" | "id" : undefined;
}

/** [v0.4.28a] Validate and normalize narrativeLanguageOnFail.
 *  Only accepts softwarn|reask|handoff. Invalid values → softwarn (safe default). */
const VALID_ON_FAIL = new Set(["softwarn", "reask", "handoff"]);
function normalizeLanguageOnFail(value: unknown): "softwarn" | "reask" | "handoff" {
  if (typeof value !== "string") return "softwarn";
  const lower = value.trim().toLowerCase();
  return VALID_ON_FAIL.has(lower) ? lower as "softwarn" | "reask" | "handoff" : "softwarn";
}

/**
 * Normalize OpenRouter reasoning config from raw user input.
 *
 * Rules:
 *  a. enabled===false => return undefined (do not send reasoning)
 *  b. if maxTokens and effort both present, prefer maxTokens and drop effort
 *  c. map maxTokens to normalized maxTokens (reject <=0 or non-integer)
 *  d. [v0.4.29c Fix C3] exclude is always true (internal fixed) — prevents CoT token leakage into output
 *  e. invalid maxTokens (<=0 or non-integer) treated as unset
 */
export function normalizeOpenRouterReasoning(
  raw: OpenRouterReasoningConfig | undefined
): { enabled: boolean; effort?: string; maxTokens?: number } | undefined {
  if (!raw) return undefined;

  // Rule a: disabled entirely
  if (raw.enabled === false) return undefined;

  const enabled = true;
  let effort: string | undefined;
  let maxTokens: number | undefined;
  // [v0.4.29c Fix C3] exclude always true — no longer a variable

  const validEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
  if (typeof raw.effort === "string" && validEfforts.has(raw.effort)) {
    effort = raw.effort;
  }

  // Rule e: validate maxTokens — must be positive integer
  if (typeof raw.maxTokens === "number" && Number.isInteger(raw.maxTokens) && raw.maxTokens > 0) {
    maxTokens = raw.maxTokens;
  }

  // Rule b: if both maxTokens and effort present, prefer maxTokens and drop effort
  if (maxTokens !== undefined) {
    effort = undefined;
  }

  // Rule c (default): if no valid effort and no valid maxTokens, default effort to "high"
  if (effort === undefined && maxTokens === undefined) {
    effort = "high";
  }

  // [v0.4.29c Fix C3] exclude removed from return — handled downstream:
  // - OpenRouterClient always sends reasoning.exclude=true
  // - GeminiDirectClient has no exclude concept (thinkingConfig replaces it)
  return { enabled, effort, maxTokens };
}

/**
 * Parse and normalize the forgettingEpisodic config.
 * Priority: forgettingEpisodic.physicalDeleteTtlDays → 14.
 */
function normalizeForgettingConfig(rawConfig: any): ForgettingConfig {
  const raw = rawConfig?.forgettingEpisodic as ForgettingConfig | undefined;
  // [v0.4.34] Back-compat: top-level tombstoneRetentionDays (v0.4.32 and earlier)
  // is migrated into forgettingEpisodic.physicalDeleteTtlDays when the latter is unset.
  // This keeps existing KASOU configs working without manual edits.
  const legacyTombstoneTTL = rawConfig?.tombstoneRetentionDays;
  const effectivePhysicalDeleteTtlDays =
    raw?.physicalDeleteTtlDays ?? legacyTombstoneTTL ?? 14;
  return {
    enabled: !!raw?.enabled,
    retentionDays: clampFiniteInt(raw?.retentionDays, 1, 3650, 365),
    physicalDeleteTtlDays: clampFiniteInt(
      effectivePhysicalDeleteTtlDays, 1, 3650, 14
    ),
  };
}

/**
 * Parses and resolves default configuration for the plugin.
 * Handles the configSchema defined in openclaw.plugin.json.
 */
export function loadConfig(rawConfig: any, opts?: { platform?: string }): EpisodicPluginConfig {
  const platform = opts?.platform;
  return {
    // [v0.4.34] forgettingEpisodic — user-facing config for weekly unused-episode sweep
    forgettingEpisodic: normalizeForgettingConfig(rawConfig),
    enableBackgroundWorkers: rawConfig?.enableBackgroundWorkers ?? true,
    lexicalPreFilterLimit: rawConfig?.lexicalPreFilterLimit ?? 1000,
    reserveTokens: rawConfig?.reserveTokens ?? 2048,
    autoInjectGuardMinScore: clampUnitInterval(rawConfig?.autoInjectGuardMinScore, 0.86),
    // Phase 3 lifetime is consumed only by eligible prompt-build passes that actually
    // reach anchor-injection evaluation. A budget-truncated early return does not spend it.
    anchorInjectionAssembles: Math.max(1, rawConfig?.anchorInjectionAssembles ?? 1),
    dedupWindow: rawConfig?.dedupWindow ?? 5,
    // [v0.4.21b] Warm-start cursor bootstrap threshold (default 50, 0 to disable)
    warmStartSkipMinMessages: Math.max(0, rawConfig?.warmStartSkipMinMessages ?? 50),
    maxCharsPerChunk: Math.max(500, rawConfig?.maxCharsPerChunk ?? 9000),
    segmentationLambda: rawConfig?.segmentationLambda ?? 2.0,
    segmentationWarmupCount: rawConfig?.segmentationWarmupCount ?? 10,  // Phase 3: was 20
    segmentationMinRawSurprise: rawConfig?.segmentationMinRawSurprise ?? 0.05,
    segmentationCooldownTurns: rawConfig?.segmentationCooldownTurns ?? 2,
    segmentationStdFloor: rawConfig?.segmentationStdFloor ?? 0.01,
    segmentationFallbackThreshold: rawConfig?.segmentationFallbackThreshold ?? 0.2,
    segmentationTimeGapMinutes: rawConfig?.segmentationTimeGapMinutes ?? 15,
    recallSemanticFloor: rawConfig?.recallSemanticFloor ?? 0.35,
    recallUsefulnessClamp: rawConfig?.recallUsefulnessClamp ?? 1.0,
    recallReplayTieBreakMaxBoost: rawConfig?.recallReplayTieBreakMaxBoost ?? 0.04,
    recallReplayLowRetrievabilityBonus: rawConfig?.recallReplayLowRetrievabilityBonus ?? 0.01,
    recallTopicsMatchBoost: rawConfig?.recallTopicsMatchBoost ?? 0.05,
    recallTopicsMismatchPenalty: rawConfig?.recallTopicsMismatchPenalty ?? 0.10,
    recallTopicsMissingPenalty: rawConfig?.recallTopicsMissingPenalty ?? 0.0,
    recallReInjectionCooldownTurns: Math.max(0, rawConfig?.recallReInjectionCooldownTurns ?? 24),
    lexicalRebuildIntervalDays: rawConfig?.lexicalRebuildIntervalDays ?? 7,
    // [v0.4.14] Recall query config — previously missing from loadConfig(), user settings were ignored
    recallQueryRecentMessageCount: Math.max(1, Math.min(12, rawConfig?.recallQueryRecentMessageCount ?? 4)),
    queryExcludedKeywords: rawConfig?.queryExcludedKeywords ?? [],
    // Narrative architecture (v0.4.0)
    openrouterApiKey: rawConfig?.openrouterApiKey || getEnvVal("OPENROUTER_API_KEY") || "",
    // [v0.4.29c Fix C2] narrativeConfig (unified) > openrouterConfig (deprecated) > flat fields
    // Resolve source priority: narrativeConfig → openrouterConfig → flat → default
    ...(() => {
      const nc = rawConfig?.narrativeConfig as NarrativeConfig | undefined;  // new unified config
      const oc = rawConfig?.openrouterConfig as NarrativeConfig | undefined;  // deprecated compat
      const hasNc = nc && Object.keys(nc).length > 0;
      const hasOc = oc && Object.keys(oc).length > 0;
      // [v0.4.29c] Distinguish "flat" (user set a flat field) vs "default" (nothing user-configured)
      const hasFlatOverride = rawConfig?.openrouterModel != null || rawConfig?.narrativeTemperature != null;
      const source: "narrativeConfig" | "openrouterConfig" | "flat" | "default" =
        hasNc ? "narrativeConfig" : hasOc ? "openrouterConfig" : hasFlatOverride ? "flat" : "default";
      // Emit deprecation warning if openrouterConfig is used (and narrativeConfig is not)
      if (hasOc && !hasNc && !warnedOpenrouterDeprecated) {
        console.warn(
          "[Episodic Memory] openrouterConfig is deprecated (v0.4.29c) - using openrouterConfig fallback. " +
          "Use narrativeConfig instead. openrouterConfig will be removed in a future release."
        );
        warnedOpenrouterDeprecated = true;
      }
      // Merge: narrativeConfig overrides openrouterConfig overrides flat fields
      const model = nc?.model ?? oc?.model ?? rawConfig?.openrouterModel ?? "openrouter/free";
      const maxTokens = nc?.maxTokens ?? oc?.maxTokens;
      const temperature = nc?.temperature ?? oc?.temperature ?? rawConfig?.narrativeTemperature;
      const timeoutMs = nc?.timeoutMs ?? oc?.timeoutMs;
      const maxRetries = nc?.maxRetries ?? oc?.maxRetries;
      const reasoning = nc?.reasoning ?? oc?.reasoning;
      return {
        openrouterModel: model,
        openrouterMaxTokens: maxTokens,
        openrouterTimeoutMs: clampFiniteInt(timeoutMs, 30000, 300000, 30000),
        openrouterMaxRetries: clampFiniteInt(maxRetries, 0, 5, 3),
        narrativeTemperature: Math.max(0, Math.min(1, temperature ?? 0.4)),
        narrativeConfigSource: source,
        openrouterReasoning: normalizeOpenRouterReasoning(
          reasoning ?? { enabled: true, effort: "high" }
        ),
      };
    })(),
    narrativeSystemPrompt: resolvePrompt(rawConfig?.narrativeSystemPrompt, platform),
    narrativeUserPromptTemplate: resolvePrompt(rawConfig?.narrativeUserPromptTemplate, platform),
    narrativePreviousEpisodeRef: rawConfig?.narrativePreviousEpisodeRef ?? true,
    // [v0.4.28a] Language guard config — transplanted from Guardrails AI correct_language validator
    // narrativeExpectedLanguage: undefined = auto (no check). Only accept valid language codes.
    narrativeExpectedLanguage: normalizeLanguageCode(rawConfig?.narrativeExpectedLanguage),
    narrativeLanguageThreshold: clampUnitInterval(rawConfig?.narrativeLanguageThreshold, 0.75),
    narrativeLanguageOnFail: normalizeLanguageOnFail(rawConfig?.narrativeLanguageOnFail),
    // [v0.4.28b] Content floor config — G5 Minimum Sentence Gate + G6 Minimum Content Floor
    // Uses clampFiniteInt() for NaN/Infinity guard (same pattern as clampUnitInterval).
    // narrativeGuardMinSentences: clamp [1, 20], default 3. Runtime branches: CJK=this, Latin=this+1.
    narrativeGuardMinSentences: clampFiniteInt(rawConfig?.narrativeGuardMinSentences, 1, 20, 3),
    // narrativeGuardMinCjkChars: clamp [10, 500], default 120.
    narrativeGuardMinCjkChars: clampFiniteInt(rawConfig?.narrativeGuardMinCjkChars, 10, 500, 120),
    // narrativeGuardMinLatinWords: clamp [5, 300], default 80.
    narrativeGuardMinLatinWords: clampFiniteInt(rawConfig?.narrativeGuardMinLatinWords, 5, 300, 80),
  };
}

/**
 * Resolve a prompt value that may be inline text, a file path, or a ~/ path.
 * Cross-platform: handles Linux absolute paths (/home/...), Windows paths (Y:\...),
 * and home-dir shortcuts (~/...) on all platforms.
 *
 * @param value - The prompt value to resolve (inline text, file path, or ~/ path)
 * @param platform - Platform identifier for testing injection (default: process.platform)
 */
function resolvePrompt(value: string | undefined, platform: string = process.platform): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (!trimmed.endsWith(".md") && !trimmed.endsWith(".txt")) {
    return trimmed;  // inline text
  }

  // Build a list of candidate paths to try in order
  const candidates: string[] = [];

  // 1. Resolve ~ / ~/path — works on all platforms
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    const homeDir = getEnvVal("HOME") || getEnvVal("USERPROFILE") || os.homedir();
    candidates.push(path.join(homeDir, trimmed.slice(2)));
  } else if (trimmed === "~") {
    const homeDir = getEnvVal("HOME") || getEnvVal("USERPROFILE") || os.homedir();
    candidates.push(homeDir);
  }

  // 2. path.resolve(trimmed) — handles Windows absolute (C:\...) and relative paths
  //    Same behavior as before (backward compatible)
  candidates.push(path.resolve(trimmed));

  // 3. Cross-platform: If original is a POSIX absolute path (/home/user/...) and
  //    we're on Windows, try resolving under the Windows user home directory.
  //    This handles the case where openclaw.json was written on Linux and the
  //    plugin runs on Windows (WSL, dual-boot config share, etc.)
  if (platform === "win32" && trimmed.startsWith("/home/")) {
    const homeDir = getEnvVal("HOME") || getEnvVal("USERPROFILE") || os.homedir();
    // /home/kasou_yoshia/.openclaw/... → HOME\.openclaw\...
    // Skip the username segment and join by the path after it
    const relativeFromHome = trimmed.slice("/home/".length);  // kasou_yoshia/.openclaw/...
    const firstSlash = relativeFromHome.indexOf("/");
    if (firstSlash > 0) {
      const afterUsername = relativeFromHome.slice(firstSlash + 1);  // .openclaw/...
      candidates.push(path.join(homeDir, afterUsername));
    }
  }

  // Try each candidate in order; first successful read wins
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, "utf8").trim();
      if (content.length > 0) {
        if (candidate !== path.resolve(trimmed)) {
          console.log(`[Episodic Memory] Prompt file resolved via cross-platform path: ${trimmed} → ${candidate}`);
        }
        return content;
      }
    } catch {
      // Continue to next candidate
    }
  }

  // All candidates failed — log for observability
  console.warn(
    `[Episodic Memory] Failed to read prompt file: ${trimmed}` +
    ` (tried: ${candidates.join(", ")})`
  );
  return "";
}

export function buildRecallCalibration(config: EpisodicPluginConfig): RecallCalibration {
  return {
    semanticFloor: config.recallSemanticFloor,
    usefulnessClamp: config.recallUsefulnessClamp,
    replayTieBreakMaxBoost: config.recallReplayTieBreakMaxBoost,
    replayLowRetrievabilityBonus: config.recallReplayLowRetrievabilityBonus,
    topicsMatchBoost: config.recallTopicsMatchBoost,
    topicsMismatchPenalty: config.recallTopicsMismatchPenalty,
    topicsMissingPenalty: config.recallTopicsMissingPenalty,
  };
}


