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

/**
 * Slim shape returned by Go's episode.listForgottenEpisodes RPC. The full
 * EpisodeRecord carries a 3072-dim vector that the snapshot worker does not
 * need; only identity, source path, and timestamps are kept.
 */
export interface ForgottenSummary {
  id: string;
  path: string;
  title: string;
  timestamp: string; // ISO 8601
  forgottenAt: string; // ISO 8601
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
  // [v0.4.29c Fix C3] exclude removed from schema — always true internally
}

/** [v0.4.29c Fix C1] Unified narrative generation configuration.
 *  Applies to both Google (Gemini/Gemma) and OpenRouter providers.
 *  Replaces openrouterConfig as the primary config source.
 */
export interface NarrativeConfig {
  /** Model ID for OpenRouter fallback phases (Round 2). Default: 'openrouter/free'. */
  model?: string;
  /** Max tokens cap for narrative generation. Omit to use model default. */
  maxTokens?: number;
  /** Sampling temperature. Default: 0.4. */
  temperature?: number;
  /** HTTP request timeout in ms. Clamped to [30000, 300000]. Default: 30000. */
  timeoutMs?: number;
  /** Transport-level retries after transient failure. Clamped to [0, 5]. Default: 3. */
  maxRetries?: number;
  /** Reasoning/thinking control. Maps to OpenRouter reasoning and Google thinkingConfig. */
  reasoning?: OpenRouterReasoningConfig;
}

export interface EpisodicPluginConfig {
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
  /** [v0.4.21b] Warm-start 初回取り込みガードの閾値。
   *  初回 before_prompt_build 時のメッセージ数がこれ以上なら再起動復帰とみなし cursor を同期。
   *  0 に設定すると warm-start ガードを無効化。
   *  デフォルト: 50 */
  warmStartSkipMinMessages?: number;
  /** Legacy batchIngest chunk size (Default: 9000). Retained for backward compatibility. */
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
  /** Recall calibration: semantic relevance below this floor should not be overruled by usefulness. */
  recallSemanticFloor?: number;
  /** Recall calibration: cap usefulness posterior contribution so it stays a correction term. */
  recallUsefulnessClamp?: number;
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
  /** Max tokens cap for narrative generation. Sources from openrouterConfig.maxTokens.
   *  Omit to use the model's default context window. */
  openrouterMaxTokens?: number;
  /** Request timeout in ms for OpenRouter API calls. Sources from openrouterConfig.timeoutMs.
   *  Clamped to [30000, 300000]. Default: 30000. Set to 180000-300000 for free-tier models. */
  openrouterTimeoutMs?: number;
  /** Transport-level retry count after transient failures (timeout, 5xx, rate-limit).
   *  Sources from openrouterConfig.maxRetries. Clamped to [0, 5]. Default: 3.
   *  Set to 0 for strict fail-fast mode (no retries). */
  openrouterMaxRetries?: number;
  /** Narrative system prompt (inline text). */
  narrativeSystemPrompt?: string;
  /** Narrative user prompt template (inline text). */
  narrativeUserPromptTemplate?: string;
  /** Pass the full previous episode to the LLM for context continuity. */
  narrativePreviousEpisodeRef?: boolean;
  /** Deprecated: legacy alias for openrouterConfig.temperature. Use openrouterConfig.temperature instead. */
  narrativeTemperature?: number;
  /** Normalized reasoning config after applying defaults and validation rules. */
  openrouterReasoning?: {
    enabled: boolean;
    effort?: string;
    maxTokens?: number;
    // [v0.4.29c Fix C3] exclude always true — no longer configurable
  };
  /** [v0.4.29c Fix C1] Source of narrative config — for observability logging. */
  narrativeConfigSource?: "narrativeConfig" | "openrouterConfig" | "flat" | "default";
  // [v0.4.28a] Language guard config — transplanted from Guardrails AI correct_language validator
  /** Expected output language for narrative generation. When set, the language guard
   *  checks that generated narratives match this language. Leave unset to disable (auto). */
  narrativeExpectedLanguage?: "ja" | "en" | "zh" | "ko" | "id";
  /** Confidence threshold (0..1) for language detection. Only triggers on_fail when
   *  the detected language confidence exceeds this threshold and doesn't match expected. Default: 0.75. */
  narrativeLanguageThreshold?: number;
  /** Action when narrative language doesn't match expected. 'softwarn' = log only (observational),
   *  'reask' = retry same model (v0.4.28c), 'handoff' = switch to fallback model (v0.4.28c).
   *  No 'exception' — would crash the pipeline and cause item loss. */
  narrativeLanguageOnFail?: "softwarn" | "reask" | "handoff";
  // [v0.4.28b] Content floor config — Minimum Sentence Gate (G5) + Minimum Content Floor (G6)
  /** Minimum sentence count for narrative output. Runtime branches by detected language:
   *  CJK (ja/zh/ko): this value (default 3). Latin (en/id/unknown): this value + 1 (default 4).
   *  Single variable + runtime branching — KISS, no need for separate cjkMin/latinMin keys. */
  narrativeGuardMinSentences?: number;
  /** Minimum CJK character count for narrative output (whitespace stripped). Default: 120. */
  narrativeGuardMinCjkChars?: number;
  /** Minimum Latin word count for narrative output (whitespace-split). Default: 80. */
  narrativeGuardMinLatinWords?: number;
  /** Weekly unused-episode forgetting sweep config. Default: disabled. */
  forgettingEpisodic?: ForgettingConfig;
}

export interface RecallCalibration {
  semanticFloor?: number;
  usefulnessClamp?: number;
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

export interface JapaneseQueryParseSegment {
  text: string;
  reading?: string;
  lemma?: string;
  kind: "content" | "particle" | "aux" | "latin";
  start: number;
  end: number;
}

export interface JapaneseQueryParseResult {
  segments: JapaneseQueryParseSegment[];
  keywords: string[];
  elapsedMs: number;
  timedOut: boolean;
  source: string;
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

/** Configuration for the weekly unused-episode forgetting sweep. */
export interface ForgettingConfig {
  /** Enable the weekly forgetting sweep. Default: false. */
  enabled?: boolean;
  /** Days an episode must remain unused before eligibility. Default: 365. */
  retentionDays?: number;
  /** TTL (days) for forgotten records before physical delete. Default: 14. */
  physicalDeleteTtlDays?: number;
}

