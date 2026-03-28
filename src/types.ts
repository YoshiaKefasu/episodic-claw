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
  SavedBy?: string;
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
}

export interface Watermark {
  dateSeq: string;
  absIndex: number;
}

export interface BatchIngestItem {
  summary: string;
  tags: string[];
  edges: Edge[];
  surprise?: number;
  depth?: number;
  tokens?: number;
  sources?: string[];
}
