import * as fs from "fs";
import * as path from "path";
import { EpisodicPluginConfig, RecallCalibration } from "./types";

function clampUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
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
