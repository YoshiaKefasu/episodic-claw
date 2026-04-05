import { EpisodicCoreClient } from "./rpc-client";
import { normalizeMessageText } from "./large-payload";
import { buildSummaryForLevel, SummarizationLevel } from "./summary-escalation";

export const EXCLUDED_ROLES = new Set(["toolResult", "tool_result"]);

export interface Message {
  role: string;
  content: any; // OpenClaw uses object/array content blocks, not plain strings
  timestamp?: string;
}

/**
 * Extracts plain text from OpenClaw's content field.
 * Content can be: string, array of blocks [{type:"text", text:"..."}], or object {type:"text", text:"..."}.
 */
export function extractText(content: any): string {
  return normalizeMessageText(content);
}

export class EventSegmenter {
  private buffer: Message[] = [];
  private rpc: EpisodicCoreClient;
  private lastProcessedLength = 0; // Track length to process only new messages
  private turnSeq = 0;
  private dedupWindow: number;
  private maxBufferChars: number;
  private maxCharsPerChunk: number;
  private segCount = 0;
  private segMean = 0;
  private segM2 = 0;
  private segCooldownRemaining = 0;
  private segmentationLambda: number;
  private segmentationWarmupCount: number;
  private segmentationMinRawSurprise: number;
  private segmentationCooldownTurns: number;
  private segmentationStdFloor: number;
  private segmentationFallbackThreshold: number;

  constructor(
    rpc: EpisodicCoreClient,
    dedupWindow = 5,
    maxBufferChars = 7200,
    maxCharsPerChunk = 9000,
    tuning?: {
      lambda?: number;
      warmupCount?: number;
      minRawSurprise?: number;
      cooldownTurns?: number;
      stdFloor?: number;
      fallbackThreshold?: number;
    }
  ) {
    this.rpc = rpc;
    this.dedupWindow = dedupWindow;
    this.maxBufferChars = maxBufferChars;
    this.maxCharsPerChunk = maxCharsPerChunk;
    this.segmentationLambda = Math.max(0, tuning?.lambda ?? 2.0);
    this.segmentationWarmupCount = Math.max(0, tuning?.warmupCount ?? 20);
    this.segmentationMinRawSurprise = Math.max(0, tuning?.minRawSurprise ?? 0.05);
    this.segmentationCooldownTurns = Math.max(0, tuning?.cooldownTurns ?? 2);
    this.segmentationStdFloor = Math.max(0.0001, tuning?.stdFloor ?? 0.01);
    this.segmentationFallbackThreshold = Math.max(0, tuning?.fallbackThreshold ?? 0.2);
  }

  private updateSegStats(value: number): void {
    this.segCount += 1;
    const delta = value - this.segMean;
    this.segMean += delta / this.segCount;
    const delta2 = value - this.segMean;
    this.segM2 += delta * delta2;
  }

  private getSegStd(): number {
    if (this.segCount < 2) return this.segmentationStdFloor;
    const variance = this.segM2 / (this.segCount - 1);
    return Math.max(Math.sqrt(Math.max(variance, 0)), this.segmentationStdFloor);
  }

  private shrinkSegStats(): void {
    if (this.segCount <= 1) return;
    const shrink = 0.5;
    this.segCount = Math.max(1, Math.floor(this.segCount * shrink));
    this.segM2 *= shrink;
  }

  /**
   * Evaluates the new context Turn and determines if an episode boundary was crossed.
   * If yes, triggers ingest to flush the old buffer.
   */
  async processTurn(currentMessages: Message[], agentWs: string, agentId: string = ""): Promise<boolean> {
    if (currentMessages.length === 0) return false;

    // Detect context wipe/reset
    if (this.lastProcessedLength > currentMessages.length) {
      // Fix B: reset 検出時に buffer を flush してから破棄（forceFlush 失敗時も確実にクリア）
      if (this.buffer.length > 0) {
        console.log(`[Episodic Memory] Context reset detected. Flushing ${this.buffer.length} buffered messages.`);
        await this.forceFlush(agentWs, agentId);
      }
      this.lastProcessedLength = 0;
      this.buffer = []; // forceFlush 失敗時も確実にクリア
    }

    const newMessages = currentMessages.slice(this.lastProcessedLength);
    if (newMessages.length === 0) return false;

    // ---- Fix 1: ツール出力の除外と tool_use の要約 ----
    const filteredNewMessages = newMessages
      .filter(m => !EXCLUDED_ROLES.has(m.role))
      .map(m => {
        if (m.role === "tool_use") {
          // 複数ツールの並列呼び出しに対応するため、すべてのツール名を抽出してカンマ区切りにする
          let toolNames: string[] = [];
          if (Array.isArray(m.content)) {
            toolNames = m.content
              .filter((b: any) => b.type === "tool_use" && b.name)
              .map((b: any) => b.name);
          }
          const namesStr = toolNames.length > 0 ? toolNames.join(", ") : "unknown_tool";
          return { ...m, content: `[Tool Used: ${namesStr}]` };
        }
        return m;
      });

    // [Fix D-1] 重複メッセージ dedup（フォールバック連発対策）
    // フォールバック時に同一ユーザーメッセージが N 回送信されるため、
    // buffer 直近 dedupWindow 件と照合して重複・空メッセージを除去する。
    // キーは "role:text" として role を区別する（"はい" が user/assistant 両方から来ても誤除去しない）。
    // lastProcessedLength は dedup に関わらず currentMessages.length に更新する（位置追跡を正確に保つ）。
    // dedupWindow は loadConfig() 経由で設定可能（デフォルト 5、高頻度フォールバック環境では 10+ 推奨）。
    const recentKeys = new Set(
      this.buffer.slice(-this.dedupWindow).map(m => `${m.role}:${extractText(m.content).trim()}`)
    );
    const dedupedMessages = filteredNewMessages.filter(m => {
      const text = extractText(m.content).trim();
      if (!text) return false;                    // 空メッセージ（失敗レスポンス）を除去
      const key = `${m.role}:${text}`;
      if (recentKeys.has(key)) return false;      // buffer 直近との重複を除去（role を考慮）
      recentKeys.add(key);                        // dedupedMessages 内の自己重複も除去
      return true;
    });
    if (dedupedMessages.length === 0) {
      console.log(`[Episodic Memory] All ${newMessages.length} new message(s) were duplicates or empty, skipping.`);
      this.lastProcessedLength = currentMessages.length;
      return false;
    }

    if (this.buffer.length === 0) {
      // First turn, just absorb
      this.buffer.push(...dedupedMessages);
      this.lastProcessedLength = currentMessages.length;
      return false;
    }

    // Extract what's new vs what we had
    // ⚠️ Only use the last 10 messages from buffer to keep RPC payload small.
    // Using the full buffer (potentially 200+ messages) causes the Unix socket
    // to silently fail due to oversized payload, killing ai.surprise entirely.
    // BUG-2 修正: ツール結果等の巨大メッセージで 200,000 文字超になるのを防ぐため上限を設ける。
    const OLD_SLICE_MAX_CHARS = 3000;
    const NEW_SLICE_MAX_CHARS = 2000;
    const oldSlice = this.buffer.slice(-10)
      .map(m => extractText(m.content))
      .join("\n")
      .slice(0, OLD_SLICE_MAX_CHARS);
    const newSlice = dedupedMessages.slice(0, 5)
      .map(m => extractText(m.content))
      .join("\n")
      .slice(0, NEW_SLICE_MAX_CHARS);

    if (!newSlice) {
      // 画像・tool_use など text なしメッセージの場合も位置を進める（スタック防止）
      this.lastProcessedLength = currentMessages.length;
      return false;
    }

    // 定期的なチャンク分割（Surprise判定を待たずにバッファが大きすぎる場合は強制分割）
    const estimatedChars = this.buffer.reduce((acc, m) => acc + extractText(m.content).length, 0);

    try {
      const sizeLimitExceeded = estimatedChars > this.maxBufferChars;
      this.turnSeq += 1;

      const score = await this.rpc.segmentScore({
        agentWs,
        agentId: agentId || "auto",
        turn: this.turnSeq,
        text1: oldSlice,
        text2: newSlice,
        lambda: this.segmentationLambda,
        warmupCount: this.segmentationWarmupCount,
        minRawSurprise: this.segmentationMinRawSurprise,
        cooldownTurns: this.segmentationCooldownTurns,
        stdFloor: this.segmentationStdFloor,
        fallbackThreshold: this.segmentationFallbackThreshold,
      });

      const surprise = score?.rawSurprise ?? 0;
      const shouldBoundary = sizeLimitExceeded || !!score?.isBoundary;

      if (shouldBoundary || this.turnSeq % 5 === 0) {
        const mean = (score?.mean ?? 0).toFixed(4);
        const std = (score?.std ?? 0).toFixed(4);
        const th = (score?.threshold ?? 0).toFixed(4);
        const z = (score?.z ?? 0).toFixed(2);
        console.log(
          `[Episodic Memory] SegmentScore: raw=${surprise.toFixed(4)} ` +
          `mean=${mean} std=${std} threshold=${th} z=${z} ` +
          `boundary=${shouldBoundary} reason=${score?.reason ?? "n/a"}`
        );
      }

      if (shouldBoundary) {
        // 2. Boundary crossed or Buffer too large! Trigger ingest for the OLD buffer
        const reason = sizeLimitExceeded ? "size-limit" : "surprise-boundary";
        console.log(`[Episodic Memory] ${reason} exceeded. Finalizing previous episode...`);
        
        // ==========================================
        // 🔥 アーキテクチャ改修 (Audit対応) 🔥
        // 直列awaitは絶対に行わず、Fire-and-Forgetとして非同期にバックグラウンドへ投げるだけにする。
        // これによりNode.js (OpenClaw UI) が数分間ハングアップするのを完全に防ぐ。
        // ==========================================
        this.chunkAndIngest(this.buffer, agentWs, reason, agentId, surprise).catch(err => {
          console.error("[Episodic Memory] Error in background chunkAndIngest:", err);
        });
        
        // Clear buffer and start fresh with the new context
        this.buffer = [...dedupedMessages];
      } else {
        // Just append to buffer / update buffer
        this.buffer.push(...dedupedMessages);
      }
      this.lastProcessedLength = currentMessages.length;
      return true;
    } catch (err) {
      console.error("[Episodic Memory] Error in segmenter processTurn:", err);
      // Fallback: absorb deduped messages only（Fix D-1 を catch でも維持）
      this.buffer.push(...dedupedMessages);
      this.lastProcessedLength = currentMessages.length;
    }
    return false;
  }

  /**
   * Forcibly flushes the current buffer to an episode regardless of surprise score.
   * Useful before compact() to ensure no context is lost.
   */
  async forceFlush(agentWs: string, agentId: string = ""): Promise<void> {
    if (this.buffer.length === 0) return;
    try {
      console.log(`[Episodic Memory] Force flushing segmenter buffer (${this.buffer.length} messages)...`);
      // forceFlushは同期完了を期待されるケースもあるためawaitする
      await this.chunkAndIngest(this.buffer, agentWs, "force-flush", agentId);
      this.buffer = [];
    } catch (err) {
      console.error("[Episodic Memory] Error in segmenter forceFlush:", err);
    }
  }

  private async ingestChunkBatchesWithEscalation(params: {
    chunkBatches: Message[][];
    agentWs: string;
    agentId: string;
    reason: string;
    surprise: number;
  }): Promise<void> {
    const BATCHINGEST_TIMEOUT_MS = 30000;
    const summaryLevels: SummarizationLevel[] = ["normal", "aggressive", "fallback"];
    let lastError: unknown = null;

    for (const level of summaryLevels) {
      const items = params.chunkBatches.map((batch, index) => ({
        summary: "", // placeholder filled below
        tags: index === 0 ? ["auto-segmented", "chunked", params.reason] : ["auto-segmented", params.reason],
        topics: [],
        edges: [],
        surprise: index === 0 ? params.surprise : 0,
      }));

      for (let index = 0; index < items.length; index += 1) {
        items[index].summary = await this.summarizeBuffer(params.chunkBatches[index], level);
      }

      if (items.length === 0) {
        return;
      }

      console.log(
        `[Episodic Memory] Sending ${items.length} chunks to Go sidecar via batchIngest (summary=${level})...`
      );

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`batchIngest timed out after ${BATCHINGEST_TIMEOUT_MS}ms`)), BATCHINGEST_TIMEOUT_MS)
      );

      try {
        const slugs = await Promise.race([this.rpc.batchIngest(items, params.agentWs, params.agentId), timeoutPromise]);
        if (slugs.length < items.length) {
          console.warn(
            `[Episodic Memory] WARN: batchIngest returned ${slugs.length} slug(s) for ${items.length} item(s) ` +
            `(summary=${level}). ${items.length - slugs.length} episode(s) may have been skipped. ` +
            `Possible cause: Gemini API 429 (quota exceeded). Check Go sidecar logs for details.`
          );
        }
        if (slugs.length > 0) {
          if (level !== "normal") {
            console.log(`[Episodic Memory] Summarization escalation resolved at level=${level}.`);
          }
          return;
        }
        console.warn(
          `[Episodic Memory] batchIngest returned 0 slugs for ${items.length} item(s) at summary=${level}. Escalating...`
        );
      } catch (err) {
        lastError = err;
        console.warn(
          `[Episodic Memory] batchIngest failed at summary=${level}: ${err instanceof Error ? err.message : String(err)}. Escalating...`
        );
      }
    }

    if (lastError) {
      console.error("[Episodic Memory] All summarization escalation levels failed for chunk ingestion:", lastError);
    }
  }

  /**
   * Splits a large buffer array into manageable chunks based on character count with Overlap,
   * then sends them to Go Sidecar's BatchIngest for safe concurrent processing.
   */
  private async chunkAndIngest(messages: Message[], agentWs: string, reason: string, agentId: string = "", surprise: number = 0): Promise<void> {
    const MAX_CHARS_PER_CHUNK = this.maxCharsPerChunk; // loadConfig() 経由で設定可能（デフォルト 9000）
    const OVERLAP_MESSAGES = 2; // RAGコンテキスト分断防止のためののりしろ

    const chunkBatches: Message[][] = [];
    let currentChunk: Message[] = [];
    let currentLen = 0;
    
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const text = extractText(m.content);
      
      // 次のメッセージを入れると限界を超える場合、現在のチャンクをアイテムとして確定
      if (currentLen + text.length > MAX_CHARS_PER_CHUNK && currentChunk.length > 0) {
        chunkBatches.push([...currentChunk]);
        
        // のりしろ（Overlap）を抽出して新しいチャンクの初期状態にする
        const overlap = currentChunk.slice(-OVERLAP_MESSAGES);
        currentChunk = [...overlap];
        currentLen = overlap.reduce((acc, msg) => acc + extractText(msg.content).length, 0);
      }
      
      currentChunk.push(m);
      currentLen += text.length;
    }

    // 残りのチャンクも追加
    if (currentChunk.length > 0) {
      chunkBatches.push([...currentChunk]);
    }

    // TS側の直列 await ループは解体し、summary escalation を挟んで
    // 構築した配列を Go の batchIngest に委譲する（Go 側の並行処理を活用）。
    if (chunkBatches.length > 0) {
      await this.ingestChunkBatchesWithEscalation({
        chunkBatches,
        agentWs,
        agentId,
        reason,
        surprise,
      });
    }
  }

  private async summarizeBuffer(messages: Message[], level: SummarizationLevel = "normal"): Promise<string> {
    return buildSummaryForLevel(messages, level);
  }
}
