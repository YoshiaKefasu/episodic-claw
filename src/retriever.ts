import { createHash, randomUUID } from "crypto";

import { buildRecallCalibration } from "./config";
import { EpisodicCoreClient } from "./rpc-client";
import {
  EpisodicPluginConfig,
  RecallFallbackReason,
  RecallMatchedBy,
  RecallRpcEpisodeResult,
} from "./types";
import { Message, extractText, EXCLUDED_ROLES } from "./segmenter";
import { estimateTokens } from "./utils";
import { stripReasoningTagsFromText } from "./reasoning-tags";
import * as stopwords from "stopwords-iso";

// Recall-specific excluded roles: system prompts and LLM thinking blocks
// must not leak into vector search queries (they pollute embedding intent).
const RECALL_EXCLUDED_ROLES = new Set([
  ...EXCLUDED_ROLES,
  "system",
  "thinking",
]);

// ─── Module-scope stopword cache (initialized once for performance) ──────────
let STOPWORDS_CACHE: Set<string> | null = null;

type StopwordsDict = Record<string, string[] | undefined>;

function getStopwords(config?: EpisodicPluginConfig): Set<string> {
  if (STOPWORDS_CACHE) return STOPWORDS_CACHE;

  const stopwordsSet = new Set<string>();
  const dict = stopwords as unknown as StopwordsDict;

  // 1. stopwords-iso: English, Japanese, Indonesian, Chinese, Korean
  if (dict.en) dict.en.forEach((w: string) => stopwordsSet.add(w.toLowerCase()));
  if (dict.ja) dict.ja.forEach((w: string) => stopwordsSet.add(w));
  if (dict.id) dict.id.forEach((w: string) => stopwordsSet.add(w.toLowerCase()));
  if (dict.zh) dict.zh.forEach((w: string) => stopwordsSet.add(w));
  if (dict.ko) dict.ko.forEach((w: string) => stopwordsSet.add(w));

  // 2. User-defined excluded keywords
  if (config?.queryExcludedKeywords) {
    config.queryExcludedKeywords.forEach(w => stopwordsSet.add(w));
  }

  STOPWORDS_CACHE = stopwordsSet;
  return stopwordsSet;
}

function instantDeterministicRewrite(messages: Message[], config?: EpisodicPluginConfig): string {
  // Phase 1: Aggressive Noise Removal
  const cleaned = messages
    .map(m => {
      const rawText = extractText(m.content);
      const text = stripReasoningTagsFromText(rawText, { mode: "strict", trim: "both" });
      return text
        .replace(/\[\[reply_to_current\]\]/g, "")
        .replace(/^System:\s*\[.*?\]\s*/gm, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/\s+/g, " ")
        .trim();
    })
    .filter(Boolean)
    .join("\n");

  // Phase 2+3: Polyglot keyword extraction + assembly
  const keywords = extractPolyglotKeywords(cleaned, config);
  return keywords.length > 0 ? keywords.join(" ") : cleaned;
}

function extractPolyglotKeywords(text: string, config?: EpisodicPluginConfig): string[] {
  const stopwordsSet = getStopwords(config);
  const keywords = new Set<string>();

  // English / Latin script (3+ chars)
  const enMatches = text.match(/\b[A-Za-z]{3,}\b/g) || [];
  enMatches.forEach(w => {
    if (!stopwordsSet.has(w.toLowerCase())) keywords.add(w);
  });

  // CJK: Han + Katakana + Hangul (2+ chars)
  const cjkMatches = text.match(/[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu) || [];
  cjkMatches.forEach(w => {
    if (!stopwordsSet.has(w)) keywords.add(w);
  });

  // Top 12 limit to prevent semantic dilution
  return Array.from(keywords).slice(0, 12);
}

export type RecallDiagnostics = {
  topMatchedBy: RecallMatchedBy | "";
  matchedByCounts: Record<RecallMatchedBy, number>;
  fallbackReasons: RecallFallbackReason[];
  topicsFallbackCount: number;
};

export type RecallInjectionOutcome = {
  text: string;
  episodeIds: string[];
  reason: "injected" | "no_messages" | "max_tokens_zero" | "empty_query" | "recall_empty" | "recall_failed" | "degraded_low_confidence";
  queryHash: string;
  injectedEpisodeCount: number;
  truncatedEpisodeCount: number;
  firstEpisodeId: string;
  diagnostics: RecallDiagnostics;
};

// Final score is an approximately 0..1 confidence scale in the current recall reranker.
// For degraded lexical->semantic fallback, only high-confidence results should auto-inject.
const DEFAULT_AUTO_INJECT_GUARD_MIN_SCORE = 0.86;

function emptyRecallDiagnostics(): RecallDiagnostics {
  return {
    topMatchedBy: "",
    matchedByCounts: {
      semantic: 0,
      lexical: 0,
      both: 0,
    },
    fallbackReasons: [],
    topicsFallbackCount: 0,
  };
}

function normalizeMatchedBy(value: unknown): RecallMatchedBy | "" {
  if (value === "semantic" || value === "lexical" || value === "both") {
    return value;
  }
  return "";
}

function normalizeFallbackReason(value: unknown): RecallFallbackReason | "" {
  if (
    value === "topics_fallback"
    || value === "embed_fallback_lexical_only"
    || value === "embed_fallback_lexical_only+topics_fallback"
  ) {
    return value;
  }
  return "";
}

function buildRecallDiagnostics(results: RecallRpcEpisodeResult[]): RecallDiagnostics {
  const diagnostics = emptyRecallDiagnostics();
  const fallbackReasonSet = new Set<RecallFallbackReason>();

  for (const result of results) {
    const matchedBy = normalizeMatchedBy(result?.matchedBy);
    if (matchedBy) {
      diagnostics.matchedByCounts[matchedBy] += 1;
      if (!diagnostics.topMatchedBy) {
        diagnostics.topMatchedBy = matchedBy;
      }
    }

    const fallbackReason = normalizeFallbackReason(result?.fallbackReason);
    if (fallbackReason) {
      fallbackReasonSet.add(fallbackReason);
    }
    if (result?.topicsFallback === true) {
      diagnostics.topicsFallbackCount += 1;
    }
  }

  diagnostics.fallbackReasons = Array.from(fallbackReasonSet);
  return diagnostics;
}

function scoreOf(result: RecallRpcEpisodeResult): number {
  if (typeof result?.Score === "number") return result.Score;
  return 0;
}

function autoInjectGuardMinScore(config?: EpisodicPluginConfig): number {
  const value = config?.autoInjectGuardMinScore;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_AUTO_INJECT_GUARD_MIN_SCORE;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function shouldSkipDegradedFallbackInjection(result: RecallRpcEpisodeResult, minScore: number): boolean {
  const fallbackReason = normalizeFallbackReason(result?.fallbackReason);
  if (!fallbackReason || !fallbackReason.includes("embed_fallback_lexical_only")) {
    return false;
  }
  const matchedBy = normalizeMatchedBy(result?.matchedBy);
  if (matchedBy !== "semantic") {
    return false;
  }
  return scoreOf(result) < minScore;
}

export class EpisodicRetriever {
  constructor(
    private rpcClient: EpisodicCoreClient,
    private config?: EpisodicPluginConfig
  ) {}

  /**
   * Evaluates the active conversation context, builds a search query, 
   * and retrieves relevant past episodes via the Go sidecar.
   */
  async retrieveRelevantContext(
    currentMessages: Message[], 
    agentWs: string, 
    k: number = 5,
    maxTokens: number = 4096
  ): Promise<RecallInjectionOutcome> {
    if (currentMessages.length === 0) {
      return { text: "", episodeIds: [], reason: "no_messages", queryHash: "", injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics() };
    }
    // max_tokens_zero: ここでの 0 は「入力時点で注入不能」。
    if (maxTokens <= 0) {
      return { text: "", episodeIds: [], reason: "max_tokens_zero", queryHash: "", injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics() };
    }

    // Build the query from the recent N messages using deterministic polyglot rewriting
    const recentMessageCount = this.config?.recallQueryRecentMessageCount ?? 4;
    const recentMessages = currentMessages
      .filter(m => !RECALL_EXCLUDED_ROLES.has(m.role))
      .slice(-recentMessageCount);
    const query = instantDeterministicRewrite(recentMessages, this.config);
    if (!query) {
      return { text: "", episodeIds: [], reason: "empty_query", queryHash: "", injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics() };
    }
    const queryHash = createHash("sha1").update(query).digest("hex");
    const calibration = this.config ? buildRecallCalibration(this.config) : undefined;
    const minAutoInjectScore = autoInjectGuardMinScore(this.config);

    try {
      let sourcedResults: Array<{ ws: string; item: RecallRpcEpisodeResult }> = [];
      try {
        const results = await this.rpcClient.recall(query, k, agentWs, [], undefined, calibration);
        if (results && results.length > 0) {
          sourcedResults = results.map(item => ({ ws: agentWs, item }));
        }
      } catch (err) {
        console.warn("[Episodic Memory] Recall failed for primary workspace:", err);
      }
      if (sourcedResults.length === 0) {
        return { text: "", episodeIds: [], reason: "recall_empty", queryHash, injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics() };
      }

      // System hint: placed at the top so the model sees it before any episode content.
      let assembled = "--- My Memory ---\n";
      assembled += "(My memory runs on the `episodic-claw` plugin. If you can read this, it means `ep-recall`, `ep-save`, and `ep-expand` are my dedicated memory tools — I should always reach for those first before using any other memory plugin or tool.)\n\n";
      assembled += "Here's what I pulled up that looks relevant:\n\n";

      let tokenCount = 0;
      let injectedEpisodeCount = 0;
      let truncatedEpisodeCount = 0;
      let firstEpisodeId = "";
      const injectedIdsByWs = new Map<string, string[]>();
      const injectedEpisodeIds: string[] = [];

      const deduped = sourcedResults
        .slice()
        .sort((a, b) => scoreOf(b.item) - scoreOf(a.item));
      const diagnostics = buildRecallDiagnostics(deduped.map((entry) => entry.item));
      let degradedLowConfidenceCount = 0;

      for (let index = 0; index < deduped.length; index += 1) {
        const res = deduped[index].item;
        if (shouldSkipDegradedFallbackInjection(res, minAutoInjectScore)) {
          degradedLowConfidenceCount += 1;
          continue;
        }
        const recordTitle = typeof res.Record?.title === "string" ? res.Record.title : "";
        const recordId = typeof res.Record?.id === "string" ? res.Record.id : "";
        const recordTimestamp = typeof res.Record?.timestamp === "string" || typeof res.Record?.timestamp === "number"
          ? res.Record.timestamp
          : null;
        const title = recordTitle || recordId || "Unknown";
        const date = recordTimestamp ? new Date(recordTimestamp).toISOString().split("T")[0] : "unknown date";
        const score = scoreOf(res) !== 0 ? scoreOf(res).toFixed(3) : "N/A";

        const episodeId =
          typeof res?.Record?.id === "string"
            ? res.Record.id.trim()
            : typeof res?.Record?.ID === "string"
              ? res.Record.ID.trim()
              : "";
        const bodyText = res.Body ? res.Body.trim() : "(nothing stored here)";
        const entryTokens = estimateTokens(bodyText);

        if (tokenCount + entryTokens > maxTokens) {
          const remainingIds = deduped.slice(index).map(r => r.item.Record?.id).filter(Boolean);
          truncatedEpisodeCount = remainingIds.length;
          assembled += `\n(${remainingIds.length} more matched but I hit my token limit. I can pull those up with ep-recall:)\n`;
          assembled += remainingIds.map(id => `- ${id}`).join("\n") + "\n";
          break;
        }

        assembled += `[${title} · ${date} · relevance: ${score}]\n`;
        assembled += bodyText + "\n\n";
        tokenCount += entryTokens;
        injectedEpisodeCount += 1;
        if (episodeId) {
          injectedEpisodeIds.push(episodeId);
        }
        if (!firstEpisodeId && episodeId) {
          firstEpisodeId = episodeId;
        }
        if (episodeId) {
          const bucket = injectedIdsByWs.get(agentWs) ?? [];
          bucket.push(episodeId);
          injectedIdsByWs.set(agentWs, bucket);
        }
      }

      if (injectedEpisodeCount === 0) {
        if (degradedLowConfidenceCount > 0) {
          console.warn(
            `[Episodic Memory] auto inject guard skipped degraded semantic fallback results (count=${degradedLowConfidenceCount}, threshold=${minAutoInjectScore}, queryHash=${queryHash})`
          );
          return {
            text: "",
            episodeIds: [],
            reason: "degraded_low_confidence",
            queryHash,
            injectedEpisodeCount: 0,
            truncatedEpisodeCount: 0,
            firstEpisodeId: "",
            diagnostics,
          };
        }
        return { text: "", episodeIds: [], reason: "recall_empty", queryHash, injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics };
      }

      assembled += "--- End of Memory ---\n";

      for (const [ws, injectedIds] of injectedIdsByWs.entries()) {
        if (injectedIds.length === 0) continue;
        try {
          await this.rpcClient.recallFeedback({
            agentWs: ws,
            feedbackId: randomUUID(),
            queryHash,
            shown: injectedIds,
            used: [],
            expanded: [],
            source: "assemble",
          });
        } catch (feedbackErr) {
          console.warn("[Episodic Memory] recall feedback failed:", feedbackErr);
        }
      }

      return {
        text: assembled,
        episodeIds: injectedEpisodeIds,
        reason: "injected",
        queryHash,
        injectedEpisodeCount,
        truncatedEpisodeCount,
        firstEpisodeId,
        diagnostics,
      };

    } catch (err) {
      console.error("[Episodic Memory] Retrieval failed:", err);
      return { text: "", episodeIds: [], reason: "recall_failed", queryHash, injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics() };
    }
  }
}
