import { createHash, randomUUID } from "crypto";

import { buildRecallCalibration } from "./config";
import { EpisodicCoreClient } from "./rpc-client";
import {
  EpisodicPluginConfig,
  RecallFallbackReason,
  RecallMatchedBy,
  RecallRpcEpisodeResult,
} from "./types";
import { Message, extractText } from "./segmenter";
import { estimateTokens } from "./utils";
import { stripReasoningTagsFromText } from "./reasoning-tags";
import * as stopwords from "stopwords-iso";
import { detectLanguage, initLanguageDetector, type DetectedLanguage } from "./lang-detect";
import { tokenizeCjk } from "./cjk-tokenizer";

// ─── TS-side recall result cache ────────────────────────────────────────────
// Caches the last recall outcome by queryHash for RECALL_CACHE_TTL_MS.
// Prevents redundant Embedding API round-trips within a single conversation turn.
type RecallResultCache = {
  queryHash: string;
  agentWs: string;
  result: RecallInjectionOutcome;
  cachedAt: number;
};

const RECALL_CACHE_TTL_MS = 60_000; // 1 minute
const _recallResultCacheMap = new Map<string, RecallResultCache>();

/** Invalidate the TS-side recall cache for a specific workspace. */
export function invalidateTsRecallCache(agentWs: string): void {
  _recallResultCacheMap.delete(agentWs);
}

// ─── Attachment noise patterns (channel-agnostic) ────────────────────────────
// These patterns cover attachment markers used by OpenClaw across all channels:
// Telegram: [media attached: /path/to/file ...]
// Gateway:  [media attached: media://inbound/<id>]
// LINE:     <media:image>, <media:document>
// Discord:  <media:image> (N images), <media:document> (N files)
// Auto-reply: To send an image back, prefer ... Keep caption in the text body.

const ATTACHMENT_BOILERPLATE: RegExp[] = [
  // [media attached: ...] or [media attached 1/2: ...] — indexed multi-attachment support
  // Covers: [media attached: /path], [media attached 1/2: media://inbound/...], etc.
  /\[media attached(?:\s+\d+\/\d+)?:[^\]]*\]/gi,
  // <media:image>, <media:document>, <media:audio>, <media:video> with optional (N ...) suffix
  /<media:(image|document|audio|video)>(\s*\([^)]*\))?/gi,
  // [User sent media without caption]
  /\[User sent media without caption\]/gi,
  // To send an image back, prefer ... (match up to period, preserve text after)
  /To send an image back[^\n]*?(?:prefer|caption|Keep caption|URL)\.[ \t]*/gi,
  // standalone "attached files" / "attachment" lines without meaningful text
  /^\s*attached files\s*$/gi,
  // media://inbound/<id> standalone
  /media:\/\/inbound\/[^\s]+/gi,
];

// Patterns that indicate a message is attachment-dominant (no real user text)
const ATTACHMENT_INDICATORS: RegExp[] = [
  // File extensions appearing as standalone tokens (no CJK context around them)
  /\b(jpg|jpeg|png|webp|gif|mp4|mp3|wav|pdf|txt|docx?|xlsx?)\b/gi,
  // Absolute Windows paths
  /[A-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*/gi,
  // Unix absolute paths
  /\/(?:usr|home|tmp|var|data|media|storage)(?:\/[^/\s]+)+/gi,
];

// Media-only sentinel: a message consisting almost entirely of attachment markers
const MEDIA_ONLY_SENTINEL = /^\s*(?:\[media attached[^\]]*\]|<media:[^>]+>(?:\s*\([^)]*\))?|\[User sent media without caption\]|attached files|media:\/\/inbound\/[^\s]+|\s)*$/i;

/**
 * Check if a message is attachment-dominant (no meaningful user-authored text).
 * Channel-agnostic: covers Telegram, LINE, Discord, and gateway auto-reply patterns.
 *
 * @deprecated Use {@link classifyAndStripAttachment} instead — it combines
 * dominance check and noise stripping in a single pass for better performance.
 */
export function isAttachmentDominant(text: string): boolean {
  // Check for media-only sentinel pattern
  if (MEDIA_ONLY_SENTINEL.test(text.trim())) return true;

  // Count attachment markers vs actual text
  let markerCount = 0;
  for (const pattern of ATTACHMENT_BOILERPLATE) {
    const matches = text.match(pattern);
    if (matches) markerCount += matches.length;
  }

  // If attachment markers dominate the text, it's attachment-dominant
  const nonMarkerText = text.replace(/\[media attached(?:\s+\d+\/\d+)?:[^\]]*\]/gi, "")
    .replace(/<media:(image|document|audio|video)>(\s*\([^)]*\))?/gi, "")
    .replace(/\[User sent media without caption\]/gi, "")
    .replace(/To send an image back[^\n]*?(?:prefer|caption|Keep caption|URL)\.[ \t]*/gi, "")
    .replace(/media:\/\/inbound\/[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // If after removing markers there's very little text left, it's attachment-dominant
  // Use a more lenient threshold: 2 chars for CJK (which can be meaningful with just 2-3 chars)
  const cjkChars = (nonMarkerText.match(/[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]/gu) || []).length;
  if (nonMarkerText.length < 2) return true;
  // For Latin-heavy text, require more content (to avoid false positives from short English words)
  if (cjkChars === 0 && nonMarkerText.length < 5) return true;

  // Count attachment indicator tokens
  let indicatorCount = 0;
  for (const pattern of ATTACHMENT_INDICATORS) {
    const matches = text.match(pattern);
    if (matches) indicatorCount += matches.length;
  }

  // If filename/path tokens outnumber meaningful text, skip
  const wordCount = nonMarkerText.split(/\s+/).filter(Boolean).length;
  if (indicatorCount > 0 && wordCount <= indicatorCount) return true;

  return false;
}

/**
 * Strip attachment noise from message text, preserving caption/user-authored text.
 * Channel-agnostic: handles all OpenClaw attachment marker formats.
 *
 * @deprecated Use {@link classifyAndStripAttachment} instead — it combines
 * dominance check and noise stripping in a single pass for better performance.
 */
export function stripAttachmentNoise(text: string): string {
  let cleaned = text;
  for (const pattern of ATTACHMENT_BOILERPLATE) {
    cleaned = cleaned.replace(pattern, "");
  }
  // Clean up leftover whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();
  return cleaned;
}

/**
 * Classify and strip attachment noise in a single pass.
 * Combines isAttachmentDominant + stripAttachmentNoise to halve regex iterations.
 * Returns { isDominant, cleanedText }.
 */
export function classifyAndStripAttachment(text: string): {
  isDominant: boolean;
  cleanedText: string;
} {
  // Sentinel check first (cheap)
  if (MEDIA_ONLY_SENTINEL.test(text.trim())) {
    return { isDominant: true, cleanedText: "" };
  }

  let cleaned = text;
  let markerCount = 0;

  for (const pattern of ATTACHMENT_BOILERPLATE) {
    const matches = cleaned.match(pattern);
    if (matches) markerCount += matches.length;
    cleaned = cleaned.replace(pattern, "");
  }

  // Clean up leftover whitespace
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();

  // Dominance check on cleaned text
  const cjkChars = (cleaned.match(/[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]/gu) || []).length;

  // Count attachment indicator tokens in original text
  let indicatorCount = 0;
  for (const pattern of ATTACHMENT_INDICATORS) {
    const matches = text.match(pattern);
    if (matches) indicatorCount += matches.length;
  }
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;

  const isDominant =
    cleaned.length < 2 ||
    (cjkChars === 0 && cleaned.length < 5) ||
    (indicatorCount > 0 && wordCount <= indicatorCount);

  return { isDominant, cleanedText: cleaned };
}

/**
 * Determine the dominant script of a text string.
 * Returns 'cjk' if CJK characters are >= 30% of non-whitespace chars,
 * otherwise returns 'latin'.
 */
export function detectDominantScript(text: string): "cjk" | "latin" {
  const chars = text.replace(/\s/g, "");
  if (chars.length === 0) return "latin";

  const cjkChars = (text.match(/[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]/gu) || []).length;
  const cjkRatio = cjkChars / chars.length;

  return cjkRatio >= 0.3 ? "cjk" : "latin";
}

/**
 * Split mixed-script text into CJK and Latin segments for separate processing.
 * CJK segments are joined with spaces for morphological analysis.
 * Latin segments are extracted as 3+ char tokens.
 */
export function splitByScript(text: string): { cjk: string; latin: string } {
  const cjkChars = text.match(
    /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]+/gu
  ) || [];
  const latinTokens = text.match(/\b[A-Za-z]{3,}\b/g) || [];

  return {
    cjk: cjkChars.join(" "),
    latin: latinTokens.join(" "),
  };
}

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

export async function instantDeterministicRewrite(messages: Message[], config?: EpisodicPluginConfig): Promise<string> {
  // Phase 0: Filter out attachment-dominant messages and strip attachment noise
  const eligibleTexts: string[] = [];
  let skippedCount = 0;

  for (const m of messages) {
    const rawText = extractText(m.content);
    const text = stripReasoningTagsFromText(rawText, { mode: "strict", trim: "both" });

    const { isDominant, cleanedText } = classifyAndStripAttachment(text);
    if (isDominant) {
      if (cleanedText.length >= 3) {
        eligibleTexts.push(cleanedText);
      } else {
        skippedCount += 1;
      }
    } else {
      eligibleTexts.push(cleanedText);
    }
  }

  // Phase 1: Aggressive Noise Removal (on eligible text only)
  const cleaned = eligibleTexts
    .map(text => text
      .replace(/\[\[reply_to_current\]\]/g, "")
      .replace(/^System:\s*\[.*?\]\s*/gm, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .join("\n");

  // Phase 2+3: Polyglot keyword extraction + assembly (async for kuromojin)
  const keywords = await extractPolyglotKeywords(cleaned, config);
  return keywords.length > 0 ? keywords.join(" ") : cleaned;
}

/**
 * Extract polyglot keywords using language detection + morphological analysis.
 * Phase 1: Japanese uses kuromojin; ZH/KO fall back to regex; Latin uses regex + stopwords.
 * Mixed-text handling: CJK and Latin segments are processed separately and interleaved.
 */
export async function extractPolyglotKeywords(text: string, config?: EpisodicPluginConfig): Promise<string[]> {
  const stopwordsSet = getStopwords(config);

  // Split text by script for mixed-text handling
  const { cjk: cjkText, latin: latinText } = splitByScript(text);

  // Detect language of the CJK segment for routing
  const lang = cjkText ? detectLanguage(cjkText) : "unknown";

  // Extract CJK keywords via language-appropriate tokenizer
  let cjkKeywords: string[] = [];
  if (cjkText) {
    const result = await tokenizeCjk(cjkText, lang);
    cjkKeywords = result.keywords;
  }

  // Extract Latin keywords (3+ chars, non-stopwords)
  const latinKeywords: string[] = [];
  if (latinText) {
    const enMatches = latinText.match(/\b[A-Za-z]{3,}\b/g) || [];
    enMatches.forEach(w => {
      if (!stopwordsSet.has(w.toLowerCase())) latinKeywords.push(w);
    });
  }

  // Filter CJK keywords through stopwords (for regex fallback and any single-char noise)
  const filteredCjkKeywords = cjkKeywords.filter(w => !stopwordsSet.has(w));

  // Script-aware interleaving:
  // - CJK-dominant text: prioritize CJK (8 CJK + 4 Latin)
  // - Latin-dominant text: prioritize Latin (8 Latin + 4 CJK)
  // This prevents one script from filling all 12 slots
  const cjkFirst = lang === "ja" || lang === "zh" || lang === "ko" || (cjkText && latinKeywords.length === 0);
  const primaryPool = cjkFirst ? filteredCjkKeywords : latinKeywords;
  const secondaryPool = cjkFirst ? latinKeywords : filteredCjkKeywords;
  const primaryCount = 8;
  const secondaryCount = 4;

  const keywords: string[] = [];
  for (let i = 0; i < primaryCount && i < primaryPool.length; i++) {
    keywords.push(primaryPool[i]);
  }
  for (let i = 0; i < secondaryCount && i < secondaryPool.length; i++) {
    keywords.push(secondaryPool[i]);
  }

  return keywords.slice(0, 12);
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
  reason: "injected" | "no_messages" | "max_tokens_zero" | "empty_query" | "insufficient_keywords" | "recall_empty" | "recall_failed" | "degraded_low_confidence";
  queryHash: string;
  injectedEpisodeCount: number;
  truncatedEpisodeCount: number;
  firstEpisodeId: string;
  diagnostics: RecallDiagnostics;
  // v0.4.3 observability: recall query construction details
  recallQueryDebug?: {
    recentMessageCount: number;
    eligibleRecentMessages: number;
    skippedImageLikeMessages: number;
    dominantScript: string;
    finalQuery: string;
  };
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

// Helper to build recallQueryDebug for observability on all return paths
function buildRecallQueryDebug(
  recentMessageCount: number,
  eligibleCount: number,
  skippedCount: number,
  dominantScript: string,
  finalQuery: string
): RecallInjectionOutcome["recallQueryDebug"] {
  return { recentMessageCount, eligibleRecentMessages: eligibleCount, skippedImageLikeMessages: skippedCount, dominantScript, finalQuery };
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

    // Build the query from the recent N user messages (whitelist — only user intent matters for recall)
    const recentMessageCount = this.config?.recallQueryRecentMessageCount ?? 4;
    const recentMessages = currentMessages
      .filter(m => m.role === "user")
      .slice(-recentMessageCount);

    // Count eligible vs skipped messages for observability
    let eligibleCount = 0;
    let skippedCount = 0;
    for (const m of recentMessages) {
      const rawText = extractText(m.content);
      const text = stripReasoningTagsFromText(rawText, { mode: "strict", trim: "both" });
      const { isDominant, cleanedText } = classifyAndStripAttachment(text);
      if (isDominant) {
        if (cleanedText.length >= 3) {
          eligibleCount += 1;
        } else {
          skippedCount += 1;
        }
      } else {
        eligibleCount += 1;
      }
    }

    const query = await instantDeterministicRewrite(recentMessages, this.config);
    const dominantScript = query ? detectDominantScript(query) : "none";

    if (!query) {
      return { text: "", episodeIds: [], reason: "empty_query", queryHash: "", injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics(),
        recallQueryDebug: { recentMessageCount, eligibleRecentMessages: eligibleCount, skippedImageLikeMessages: skippedCount, dominantScript: "none", finalQuery: "" } };
    }

    // Skip recall when query has too few keywords — insufficient signal for meaningful retrieval
    const queryKeywords = query.split(/\s+/).filter(Boolean);
    if (queryKeywords.length <= 2) {
      return { text: "", episodeIds: [], reason: "insufficient_keywords", queryHash: "", injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics(),
        recallQueryDebug: { recentMessageCount, eligibleRecentMessages: eligibleCount, skippedImageLikeMessages: skippedCount, dominantScript, finalQuery: query } };
    }
    const queryHash = createHash("sha1").update(query).digest("hex");

    // ─── TS-side cache hit check ────────────────────────────────────────────────
    const cachedEntry = _recallResultCacheMap.get(agentWs);
    if (
      cachedEntry &&
      cachedEntry.queryHash === queryHash &&
      Date.now() - cachedEntry.cachedAt < RECALL_CACHE_TTL_MS
    ) {
      console.log(`[Episodic Recall] TS-cache hit for hash=${queryHash.substring(0, 8)}, skipping RPC.`);
      return cachedEntry.result;
    }

    const calibration = this.config ? buildRecallCalibration(this.config) : undefined;
    const minAutoInjectScore = autoInjectGuardMinScore(this.config);

    // Log query construction for debugging
    console.log(`[Episodic Recall] query="${query.substring(0, 120)}${query.length > 120 ? "..." : ""}" recentMsgs=${recentMessageCount} eligible=${eligibleCount} skipped=${skippedCount} script=${dominantScript} hash=${queryHash.substring(0, 8)}`);

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
        return { text: "", episodeIds: [], reason: "recall_empty", queryHash, injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics(),
          recallQueryDebug: buildRecallQueryDebug(recentMessageCount, eligibleCount, skippedCount, dominantScript, query) };
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
            recallQueryDebug: buildRecallQueryDebug(recentMessageCount, eligibleCount, skippedCount, dominantScript, query),
          };
        }
        return { text: "", episodeIds: [], reason: "recall_empty", queryHash, injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics,
          recallQueryDebug: buildRecallQueryDebug(recentMessageCount, eligibleCount, skippedCount, dominantScript, query) };
      }

      assembled += "--- End of Memory ---\n";

      for (const [ws, injectedIds] of injectedIdsByWs.entries()) {
        if (injectedIds.length === 0) continue;
        this.rpcClient.recallFeedback({
          agentWs: ws,
          feedbackId: randomUUID(),
          queryHash,
          shown: injectedIds,
          used: [],
          expanded: [],
          source: "assemble",
        }).catch(feedbackErr => {
          console.warn("[Episodic Memory] recall feedback failed:", feedbackErr);
        });
      }

      const outcome: RecallInjectionOutcome = {
        text: assembled,
        episodeIds: injectedEpisodeIds,
        reason: "injected",
        queryHash,
        injectedEpisodeCount,
        truncatedEpisodeCount,
        firstEpisodeId,
        diagnostics,
        recallQueryDebug: buildRecallQueryDebug(recentMessageCount, eligibleCount, skippedCount, dominantScript, query),
      };
      // Cache the successful outcome
      _recallResultCacheMap.set(agentWs, { queryHash, agentWs, result: outcome, cachedAt: Date.now() });
      return outcome;

    } catch (err) {
      console.error("[Episodic Memory] Retrieval failed:", err);
      return { text: "", episodeIds: [], reason: "recall_failed", queryHash, injectedEpisodeCount: 0, truncatedEpisodeCount: 0, firstEpisodeId: "", diagnostics: emptyRecallDiagnostics(),
        recallQueryDebug: buildRecallQueryDebug(recentMessageCount, eligibleCount, skippedCount, dominantScript, query) };
    }
  }
}
