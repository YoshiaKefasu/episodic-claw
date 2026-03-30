/**
 * Edge defines a relationship pointer to another episode.
 */
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
}

export interface EpisodicPluginConfig {
  sharedEpisodesDir?: string;
  allowCrossAgentRecall: boolean;
  reserveTokens?: number;
  recentKeep?: number;
  /** processTurn() dedup フィルタのウィンドウサイズ（デフォルト 5）。
   *  フォールバック回数が多い環境では大きくする（例: 10）。 */
  dedupWindow?: number;
  /** buffer サイズ上限 flush トリガー（文字数、デフォルト 7200）。
   *  この値を超えると Surprise に関わらず強制 flush される。
   *  maxCharsPerChunk より大きい値に設定すると chunking が発生する（1 flush = 複数エピソード）。
   *  500 未満は非推奨。 */
  maxBufferChars?: number;
  /** batchIngest に送る 1 チャンクの最大文字数（デフォルト 9000）。
   *  maxBufferChars より大きい値に設定すると chunking が発生しない（1 flush = 1 エピソード）。
   *  500 未満は非推奨。 */
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
