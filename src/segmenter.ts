import { EpisodicCoreClient } from "./rpc-client";

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
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && block.text) return block.text;
        if (block && typeof block === "object" && block.content) return extractText(block.content);
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (content && typeof content === "object") {
    if (content.text) return content.text;
    if (content.content) return extractText(content.content);
  }
  return String(content ?? "");
}

export class EventSegmenter {
  private buffer: Message[] = [];
  private rpc: EpisodicCoreClient;
  private surpriseThreshold = 0.2; // Adjustable threshold
  private lastProcessedLength = 0; // Track length to process only new messages
  private dedupWindow: number;
  private maxBufferChars: number;
  private maxCharsPerChunk: number;

  constructor(rpc: EpisodicCoreClient, dedupWindow = 5, maxBufferChars = 7200, maxCharsPerChunk = 9000) {
    this.rpc = rpc;
    this.dedupWindow = dedupWindow;
    this.maxBufferChars = maxBufferChars;
    this.maxCharsPerChunk = maxCharsPerChunk;
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

    // [Fix D-1] 重複メッセージ dedup（フォールバック連発対策）
    // フォールバック時に同一ユーザーメッセージが N 回送信されるため、
    // buffer 直近 dedupWindow 件と照合して重複・空メッセージを除去する。
    // キーは "role:text" として role を区別する（"はい" が user/assistant 両方から来ても誤除去しない）。
    // lastProcessedLength は dedup に関わらず currentMessages.length に更新する（位置追跡を正確に保つ）。
    // dedupWindow は loadConfig() 経由で設定可能（デフォルト 5、高頻度フォールバック環境では 10+ 推奨）。
    const recentKeys = new Set(
      this.buffer.slice(-this.dedupWindow).map(m => `${m.role}:${extractText(m.content).trim()}`)
    );
    const dedupedMessages = newMessages.filter(m => {
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
      // 1. Calculate surprise
      const { surprise } = await this.rpc.calculateSurprise(oldSlice, newSlice);
      console.log(`[Episodic Memory] Calculated surprise: ${surprise}`);

      if (surprise > this.surpriseThreshold || estimatedChars > this.maxBufferChars) {
        // 2. Boundary crossed or Buffer too large! Trigger ingest for the OLD buffer
        const reason = surprise > this.surpriseThreshold ? "surprise-boundary" : "size-limit";
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

  /**
   * Splits a large buffer array into manageable chunks based on character count with Overlap,
   * then sends them to Go Sidecar's BatchIngest for safe concurrent processing.
   */
  private async chunkAndIngest(messages: Message[], agentWs: string, reason: string, agentId: string = "", surprise: number = 0): Promise<void> {
    const MAX_CHARS_PER_CHUNK = this.maxCharsPerChunk; // loadConfig() 経由で設定可能（デフォルト 9000）
    const OVERLAP_MESSAGES = 2; // RAGコンテキスト分断防止のためののりしろ

    const items: any[] = [];
    let currentChunk: Message[] = [];
    let currentLen = 0;
    
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const text = extractText(m.content);
      
      // 次のメッセージを入れると限界を超える場合、現在のチャンクをアイテムとして確定
      if (currentLen + text.length > MAX_CHARS_PER_CHUNK && currentChunk.length > 0) {
        const summary = await this.summarizeBuffer(currentChunk);
        items.push({
          summary: summary,
          tags: ["auto-segmented", "chunked", reason],
          edges: [],
          surprise: items.length === 0 ? surprise : 0
        });
        
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
      const summary = await this.summarizeBuffer(currentChunk);
      items.push({
        summary: summary,
        tags: ["auto-segmented", reason],
        edges: [],
        surprise: items.length === 0 ? surprise : 0
      });
    }

    // TS側の直列awaitループは解体し、構築した配列を1回だけ Goの batchIngest に委譲する（Go側の並行処理を活用）。
    if (items.length > 0) {
      console.log(`[Episodic Memory] Sending ${items.length} chunks to Go sidecar via batchIngest...`);
      // [R-1] batchIngest に Promise.race タイムアウトを追加。
      // Go sidecar がハングした場合にゾンビ Promise が残り続けるのを防ぐ。
      // gateway_stop 後にプロセスが終了できなくなるリスクへの対策。
      const BATCHINGEST_TIMEOUT_MS = 30000; // 30秒
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`batchIngest timed out after ${BATCHINGEST_TIMEOUT_MS}ms`)), BATCHINGEST_TIMEOUT_MS)
      );
      const slugs = await Promise.race([this.rpc.batchIngest(items, agentWs, agentId), timeoutPromise]);
      // [429 Guard] Go sidecar が EmbedContent 429 (quota exceeded) でエピソードをスキップした場合、
      // 戻り値の slug 数が送信した items 数を下回る。無言欠損を防ぐため warn レベルで記録する。
      if (slugs.length < items.length) {
        console.warn(
          `[Episodic Memory] WARN: batchIngest returned ${slugs.length} slug(s) for ${items.length} item(s). ` +
          `${items.length - slugs.length} episode(s) may have been silently skipped. ` +
          `Possible cause: Gemini API 429 (quota exceeded). Check Go sidecar logs for details.`
        );
      }
    }
  }

  private async summarizeBuffer(messages: Message[]): Promise<string> {
    // Phase 2 暫定実装: テキストをそのまま連結するだけで LLM 要約は行わない。
    // ⚠️ トークン上限リスク: maxCharsPerChunk のデフォルト = 9,000 文字 ≈ 約 2,700〜3,600 トークン。
    //   多くの埋め込みモデルの上限（8,192 トークン）は超えないが、長い会話では
    //   チャンク境界の分割次第で 1 チャンクが 8,000+ トークンになる可能性がある。
    //   その場合、埋め込みモデルがチャンク末尾をトランケートし、エピソード後半が
    //   HNSW インデックスから消失する。
    // Phase 3 計画: Go sidecar 側に LLM 要約（抽象化要約）を offload する予定。
    //   summarizeBuffer が返す文字列を Go 側で LLM に渡し、圧縮されたエピソード概要を生成する。
    //   これにより: (1) トークン上限リスク解消、(2) recall 精度向上、(3) ストレージ削減。
    return messages.map(m => `${m.role}: ${extractText(m.content)}`).join("\n");
  }
}
