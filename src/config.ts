import { EpisodicPluginConfig } from "./types";

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
  };
}
