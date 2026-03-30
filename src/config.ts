import { EpisodicPluginConfig, RecallCalibration } from "./types";

/**
 * Parses and resolves default configuration for the plugin.
 * Handles the configSchema defined in openclaw.plugin.json.
 */
export function loadConfig(rawConfig: any): EpisodicPluginConfig {
  return {
    sharedEpisodesDir: rawConfig?.sharedEpisodesDir,
    allowCrossAgentRecall: rawConfig?.allowCrossAgentRecall ?? true,
    reserveTokens: rawConfig?.reserveTokens ?? 6144,
    recentKeep: rawConfig?.recentKeep ?? 30,
    dedupWindow: rawConfig?.dedupWindow ?? 5,
    maxBufferChars: Math.max(500, rawConfig?.maxBufferChars ?? 7200),
    maxCharsPerChunk: Math.max(500, rawConfig?.maxCharsPerChunk ?? 9000),
    segmentationLambda: rawConfig?.segmentationLambda ?? 2.0,
    segmentationWarmupCount: rawConfig?.segmentationWarmupCount ?? 20,
    segmentationMinRawSurprise: rawConfig?.segmentationMinRawSurprise ?? 0.05,
    segmentationCooldownTurns: rawConfig?.segmentationCooldownTurns ?? 2,
    segmentationStdFloor: rawConfig?.segmentationStdFloor ?? 0.01,
    segmentationFallbackThreshold: rawConfig?.segmentationFallbackThreshold ?? 0.2,
    recallSemanticFloor: rawConfig?.recallSemanticFloor ?? 0.35,
    recallUsefulnessClamp: rawConfig?.recallUsefulnessClamp ?? 1.0,
    recallReplayTieBreakMaxBoost: rawConfig?.recallReplayTieBreakMaxBoost ?? 0.04,
    recallReplayLowRetrievabilityBonus: rawConfig?.recallReplayLowRetrievabilityBonus ?? 0.01,
    recallTopicsMatchBoost: rawConfig?.recallTopicsMatchBoost ?? 0.05,
    recallTopicsMismatchPenalty: rawConfig?.recallTopicsMismatchPenalty ?? 0.10,
    recallTopicsMissingPenalty: rawConfig?.recallTopicsMissingPenalty ?? 0.0,
  };
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
