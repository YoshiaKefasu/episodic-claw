import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { EpisodicPluginConfig, OpenRouterReasoningConfig, RecallCalibration } from "./types";

function clampUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalize OpenRouter reasoning config from raw user input.
 *
 * Rules:
 *  a. enabled===false => return undefined (do not send reasoning)
 *  b. if maxTokens and effort both present, prefer maxTokens and drop effort
 *  c. map maxTokens to normalized maxTokens (reject <=0 or non-integer)
 *  d. Default exclude=true for narrative path — prevents CoT token leakage into output. Only omit when user explicitly sets exclude: false
 *  e. invalid maxTokens (<=0 or non-integer) treated as unset
 */
export function normalizeOpenRouterReasoning(
  raw: OpenRouterReasoningConfig | undefined
): { enabled: boolean; effort?: string; maxTokens?: number; exclude?: boolean } | undefined {
  if (!raw) return undefined;

  // Rule a: disabled entirely
  if (raw.enabled === false) return undefined;

  const enabled = true;
  let effort: string | undefined;
  let maxTokens: number | undefined;
  let exclude: boolean | undefined;

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

  // Rule d [v0.4.17]: Default exclude=true for narrative path — prevents CoT token leakage into output
  // Only disable if user explicitly sets exclude: false
  if (raw.exclude !== false) {
    exclude = true;
  }

  return { enabled, effort, maxTokens, exclude };
}

/**
 * Parses and resolves default configuration for the plugin.
 * Handles the configSchema defined in openclaw.plugin.json.
 */
export function loadConfig(rawConfig: any, opts?: { platform?: string }): EpisodicPluginConfig {
  const platform = opts?.platform;
  return {
    tombstoneRetentionDays: rawConfig?.tombstoneRetentionDays ?? 14,
    enableBackgroundWorkers: rawConfig?.enableBackgroundWorkers ?? true,
    lexicalPreFilterLimit: rawConfig?.lexicalPreFilterLimit ?? 1000,
    reserveTokens: rawConfig?.reserveTokens ?? 2048,
    autoInjectGuardMinScore: clampUnitInterval(rawConfig?.autoInjectGuardMinScore, 0.86),
    // Phase 3 lifetime is consumed only by eligible prompt-build passes that actually
    // reach anchor-injection evaluation. A budget-truncated early return does not spend it.
    anchorInjectionAssembles: Math.max(1, rawConfig?.anchorInjectionAssembles ?? 1),
    dedupWindow: rawConfig?.dedupWindow ?? 5,
    maxBufferChars: Math.max(500, rawConfig?.maxBufferChars ?? 7200),
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
    openrouterApiKey: rawConfig?.openrouterApiKey || process.env.OPENROUTER_API_KEY || "",
    // openrouterConfig (nested) vs flat fields: nested takes precedence
    openrouterModel: rawConfig?.openrouterConfig?.model ?? rawConfig?.openrouterModel ?? "openrouter/free",
    // [v0.4.15] Max tokens for narrative generation — previously dropped by v0.4.14 Fix B
    openrouterMaxTokens: rawConfig?.openrouterConfig?.maxTokens,
    narrativeTemperature: Math.max(0, Math.min(1, rawConfig?.openrouterConfig?.temperature ?? rawConfig?.narrativeTemperature ?? 0.4)),
    narrativeSystemPrompt: resolvePrompt(rawConfig?.narrativeSystemPrompt, platform),
    narrativeUserPromptTemplate: resolvePrompt(rawConfig?.narrativeUserPromptTemplate, platform),
    maxPoolChars: Math.max(1000, rawConfig?.maxPoolChars ?? 15000),
    narrativePreviousEpisodeRef: rawConfig?.narrativePreviousEpisodeRef ?? true,
    // Reasoning config: default enabled=true, effort=high when unset
    openrouterReasoning: normalizeOpenRouterReasoning(
      rawConfig?.openrouterConfig?.reasoning ?? { enabled: true, effort: "high" }
    ),
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
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    candidates.push(path.join(homeDir, trimmed.slice(2)));
  } else if (trimmed === "~") {
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
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
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
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


