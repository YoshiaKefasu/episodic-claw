import * as fs from "fs";
import * as path from "path";
import { EpisodicPluginConfig, OpenRouterReasoningConfig, RecallCalibration, ToolFirstRecallConfig } from "./types";

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
 *  d. include exclude only when true
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

  // Rule d: include exclude only when true
  if (raw.exclude === true) {
    exclude = true;
  }

  return { enabled, effort, maxTokens, exclude };
}

/**
 * Parses and resolves default configuration for the plugin.
 * Handles the configSchema defined in openclaw.plugin.json.
 */
export function loadConfig(rawConfig: any): EpisodicPluginConfig {
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
    // Narrative architecture (v0.4.0)
    openrouterApiKey: rawConfig?.openrouterApiKey || process.env.OPENROUTER_API_KEY || "",
    // openrouterConfig (nested) vs flat fields: nested takes precedence
    openrouterModel: rawConfig?.openrouterConfig?.model ?? rawConfig?.openrouterModel ?? "openrouter/free",
    narrativeMaxTokens: rawConfig?.openrouterConfig?.maxTokens ?? rawConfig?.narrativeMaxTokens,
    narrativeTemperature: Math.max(0, Math.min(1, rawConfig?.openrouterConfig?.temperature ?? rawConfig?.narrativeTemperature ?? 0.4)),
    narrativeSystemPrompt: resolvePrompt(rawConfig?.narrativeSystemPrompt),
    narrativeUserPromptTemplate: resolvePrompt(rawConfig?.narrativeUserPromptTemplate),
    maxPoolChars: Math.max(1000, rawConfig?.maxPoolChars ?? 15000),
    narrativePreviousEpisodeRef: rawConfig?.narrativePreviousEpisodeRef ?? true,
    // Reasoning config: default enabled=true, effort=high when unset
    openrouterReasoning: normalizeOpenRouterReasoning(
      rawConfig?.openrouterConfig?.reasoning ?? { enabled: true, effort: "high" }
    ),
  };
}

function resolvePrompt(value: string | undefined): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.endsWith(".md") || trimmed.endsWith(".txt")) {
    try {
      return fs.readFileSync(path.resolve(trimmed), "utf8").trim();
    } catch {
      console.warn(`[Episodic Memory] Failed to read prompt file: ${trimmed}`);
      return "";
    }
  }
  return trimmed;
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

/**
 * Build Tool-first recall config from raw plugin config.
 * Default: enabled=true, k=3.
 */
export function buildToolFirstRecallConfig(rawConfig: any): ToolFirstRecallConfig {
  const tf = rawConfig?.toolFirstRecall ?? {};
  return {
    enabled: tf.enabled ?? true,
    k: Math.max(1, Math.min(10, tf.k ?? 3)),
    maxFingerprintChars: Math.max(32, Math.min(512, tf.maxFingerprintChars ?? 128)),
    negativeCacheMaxSize: Math.max(10, Math.min(500, tf.negativeCacheMaxSize ?? 64)),
    backoffTurns: tf.backoffTurns ?? [3, 6, 12],
  };
}
