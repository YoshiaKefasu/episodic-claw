/**
 * Edge defines a relationship pointer to another episode.
 */
import type { Message } from "./segmenter";

export interface Edge {
  id: string; // The target episode ID or local slug (e.g. 2026/03/14/abc)
  type: "temporal" | "semantic" | "causal";
  weight?: number;
}

export interface EpisodeMetadata {
  ID: string;
  Title: string;
  Created?: string;
  Tags?: string[];
  Topics?: string[];
  SavedBy?: string;
  ConsolidationKey?: string;
  Surprise?: number;
  Depth?: number;
  Tokens?: number;
  Sources?: string[];
  RelatedTo?: Edge[];
}

export interface MarkdownDocument {
  Metadata: EpisodeMetadata;
  Body: string;
}

export interface FileEvent {
  Path: string;
  Operation: string;
  // Some sources send lowercase "path"; keep optional for compatibility.
  path?: string;
}

export type OpenRouterReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface OpenRouterReasoningConfig {
  enabled?: boolean;
  effort?: OpenRouterReasoningEffort;
  maxTokens?: number;
  exclude?: boolean;
}

export interface EpisodicPluginConfig {
  tombstoneRetentionDays?: number;
  /** Enables background maintenance workers (HealingWorker for index auto-rebuild, embedding 429 recovery).
   *  Default: true. Does not affect narrative generation. D1 consolidation is no longer used. */
  enableBackgroundWorkers?: boolean;
  lexicalPreFilterLimit?: number;
  reserveTokens?: number;
  /** Minimum 0..1 score required before degraded HNSW fallback results may auto-inject. */
  autoInjectGuardMinScore?: number;
  /** How many eligible prompt builds may inject the latest compaction anchor+summary.
   *  This is not "every assemble call" — budget-truncated early returns do not consume it. */
  anchorInjectionAssembles?: number;
  /** processTurn() dedup フィルタのウィンドウサイズ（デフォルト 5）。
   *  フォールバック回数が多い環境では大きくする（例: 10）。 */
  dedupWindow?: number;
  /** buffer サイズ上限 flush トリガー（文字数、デフォルト 7200）。
   *  Advanced: live flush guard for the segmenter. Forces flush regardless of surprise/time-gap.
   *  この値を超えると Surprise に関わらず強制 flush される。500 未満は非推奨。 */
  maxBufferChars?: number;
  /** Deprecated (legacy-only): batchIngest に送る 1 チャンクの最大文字数（デフォルト 9000）。
   *  v0.4.x の narrative cache path では使用されない。後方互換のために残存。500 未満は非推奨。 */
  maxCharsPerChunk?: number;
  /** 動的セグメンテーション: 閾値 = mean + lambda * std */
  segmentationLambda?: number;
  /** 動的セグメンテーション: ウォームアップに必要な観測数 */
  segmentationWarmupCount?: number;
  /** 動的セグメンテーション: raw surprise の下限（これ未満は切らない） */
  segmentationMinRawSurprise?: number;
  /** 動的セグメンテーション: 境界検出後のクールダウンターン数 */
  segmentationCooldownTurns?: number;
  /** 動的セグメンテーション: std の最小値（ゼロ割と過敏化の防止） */
  segmentationStdFloor?: number;
  /** 動的セグメンテーション: RPC 失敗時/ウォームアップ時の固定しきい値 */
  segmentationFallbackThreshold?: number;
  /** Phase 3: ユーザーメッセージ間の時間ギャップがこれを超えると強制境界（分、デフォルト 15） */
  segmentationTimeGapMinutes?: number;
  /** Recall calibration: semantic relevance below this floor should not be overruled by usefulness/replay. */
  recallSemanticFloor?: number;
  /** Recall calibration: cap usefulness posterior contribution so it stays a correction term. */
  recallUsefulnessClamp?: number;
  /** Recall calibration: maximum replay-state tie-break boost. */
  recallReplayTieBreakMaxBoost?: number;
  /** Recall calibration: tiny extra boost when a replay candidate is clearly getting stale. */
  recallReplayLowRetrievabilityBonus?: number;
  /** Recall calibration: bonus per matched topic. */
  recallTopicsMatchBoost?: number;
  /** Recall calibration: penalty when topics exist but none match. */
  recallTopicsMismatchPenalty?: number;
  /** Recall calibration: penalty when the record has no topics at all. Usually zero. */
  recallTopicsMissingPenalty?: number;
  /** Recall re-injection guard: minimum turns that must pass before the same episode set may be re-injected.
   *  Counts all messages (user + assistant). Default: 10 (≈5 user + 5 assistant turns).
   *  Set to 0 to disable the guard. */
  recallReInjectionCooldownTurns?: number;
  /** How often the HealingWorker checks for gaps in the Lexical (Bleve) index and auto-rebuilds.
   *  Default: 7 days. Set to 1-30. */
  lexicalRebuildIntervalDays?: number;
  /** Keywords to exclude from recall queries. Prevents noise words from polluting vector search. */
  queryExcludedKeywords?: string[];
  /** How many recent messages are used to build the deterministic recall query. Default: 4. */
  recallQueryRecentMessageCount?: number;
  // Narrative architecture (v0.4.0)
  /** OpenRouter API key. Falls back to OPENROUTER_API_KEY env var. Empty = disabled. */
  openrouterApiKey?: string;
  /** Deprecated: legacy alias for openrouterConfig.model. Use openrouterConfig.model instead. */
  openrouterModel?: string;
  /** Narrative system prompt (inline text). */
  narrativeSystemPrompt?: string;
  /** Narrative user prompt template (inline text). */
  narrativeUserPromptTemplate?: string;
  /** Advanced: maximum characters to pool before forcing a flush to the cache queue. Default: 15000. */
  maxPoolChars?: number;
  /** Pass the full previous episode to the LLM for context continuity. */
  narrativePreviousEpisodeRef?: boolean;
  /** Deprecated: legacy alias for openrouterConfig.maxTokens. Use openrouterConfig.maxTokens instead. */
  narrativeMaxTokens?: number;
  /** Deprecated: legacy alias for openrouterConfig.temperature. Use openrouterConfig.temperature instead. */
  narrativeTemperature?: number;
  /** Nested OpenRouter config for narrative generation. */
  openrouterConfig?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    reasoning?: OpenRouterReasoningConfig;
  };
  /** Normalized reasoning config after applying defaults and validation rules. */
  openrouterReasoning?: {
    enabled: boolean;
    effort?: string;
    maxTokens?: number;
    exclude?: boolean;
  };
}

export interface RecallCalibration {
  semanticFloor?: number;
  usefulnessClamp?: number;
  replayTieBreakMaxBoost?: number;
  replayLowRetrievabilityBonus?: number;
  topicsMatchBoost?: number;
  topicsMismatchPenalty?: number;
  topicsMissingPenalty?: number;
}

export interface RecallScoreBreakdown {
  semanticScore?: number;
  freshnessScore?: number;
  surpriseScore?: number;
  usefulnessScore?: number;
  explorationScore?: number;
  replayTieBreakScore?: number;
  topicsMode?: "none" | "strict" | "soft";
  topicsState?: "none" | "matched" | "mismatch" | "missing";
  topicsMatchCount?: number;
  rankBefore?: number;
  rankAfter?: number;
}

export type RecallMatchedBy = "semantic" | "lexical" | "both";

export type RecallFallbackReason =
  | "topics_fallback"
  | "embed_fallback_lexical_only"
  | "embed_fallback_lexical_only+topics_fallback";

export interface RecallRpcEpisodeResult extends RecallScoreBreakdown {
  Record: Record<string, unknown>;
  Body: string;
  Distance?: number;
  Score?: number;
  bm25Score?: number;
  topicsFallback?: boolean;
  candidateRank?: number;
  rank?: number;
  matchedBy?: RecallMatchedBy;
  fallbackReason?: RecallFallbackReason | "";
}

export interface SegmentScoreResult {
  rawSurprise: number;
  mean: number;
  std: number;
  threshold: number;
  z: number;
  isBoundary: boolean;
  reason: string;
}

export interface Watermark {
  dateSeq: string;
  absIndex: number;
}

export interface BatchIngestItem {
  summary: string;
  tags: string[];
  topics?: string[];
  edges: Edge[];
  surprise?: number;
  depth?: number;
  tokens?: number;
  sources?: string[];
}

// Narrative architecture (v0.4.0) — moved from narrative-worker.ts (F2)
export interface PoolFlushItem {
  messages: Message[];
  rawText: string;
  surprise: number;
  reason: "surprise-boundary" | "size-limit" | "force-flush";
  agentWs: string;
  agentId: string;
}

export interface NarrativeResult {
  text: string;
  tokens: number;
  model: string;
}
