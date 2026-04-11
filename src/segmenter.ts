import { EpisodicCoreClient } from "./rpc-client";
import { normalizeMessageText } from "./large-payload";
import { buildSummaryForLevel, SummarizationLevel } from "./summary-escalation";
import { NarrativePool } from "./narrative-pool";
import { NarrativeWorker } from "./narrative-worker";
import { splitIntoChunks, enqueueNarrativeChunks } from "./narrative-queue";
import * as fs from "fs";
import * as path from "path";
import type { PoolFlushItem } from "./types";

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

// ─── Session mapping for message_sent resolution (v0.4.7) ─────────────────
// Short-lived TTL + LRU bounded map: conversationId -> session info.

export type SessionMappingEntry = {
  sessionKey: string;
  agentId: string;
  agentWs: string;
  expiresAt: number; // ms epoch
};

export class SessionMappingCache {
  private store: Map<string, SessionMappingEntry> = new Map();
  private accessOrder: string[] = [];

  constructor(
    private ttlMs: number = 5 * 60 * 1000, // 5 minutes default
    private maxSize: number = 200,
  ) {}

  set(conversationId: string, entry: SessionMappingEntry): void {
    entry.expiresAt = Date.now() + this.ttlMs;
    this.store.set(conversationId, entry);
    // Update access order
    const idx = this.accessOrder.indexOf(conversationId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(conversationId);
    // LRU eviction
    while (this.store.size > this.maxSize && this.accessOrder.length > 0) {
      const oldest = this.accessOrder.shift()!;
      this.store.delete(oldest);
    }
  }

  get(conversationId: string): SessionMappingEntry | null {
    const entry = this.store.get(conversationId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(conversationId);
      const idx = this.accessOrder.indexOf(conversationId);
      if (idx !== -1) this.accessOrder.splice(idx, 1);
      return null;
    }
    // Refresh access order
    const idx = this.accessOrder.indexOf(conversationId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(conversationId);
    return entry;
  }

  delete(conversationId: string): void {
    this.store.delete(conversationId);
    const idx = this.accessOrder.indexOf(conversationId);
    if (idx !== -1) this.accessOrder.splice(idx, 1);
  }

  clear(): void {
    this.store.clear();
    this.accessOrder.length = 0;
  }

  get size(): number {
    return this.store.size;
  }
}

// ─── Hook payload adapters (v0.4.7 fix: real OpenClaw contracts) ──────────
// These functions translate raw OpenClaw hook events into Message[] deltas
// that the segmenter's processIncrementalTurn can consume.
//
// Real contracts (NOT event.messages):
//   before_dispatch: { content?, body?, sessionKey?, senderId?, isGroup?, timestamp? }
//   message_sent:    { to?, content?, success?, error? }

/**
 * Build a user-role delta Message[] from a before_dispatch event.
 *
 * OpenClaw before_dispatch event shape:
 *   { content: string | ContentBlock[] | ContentBlock, body?: string, ... }
 *
 * The content/body carries the inbound user message text. There is NO event.messages array.
 */
export function buildBeforeDispatchDelta(event: unknown): Message[] {
  if (!event || typeof event !== "object") return [];

  const evt = event as Record<string, unknown>;
  const messages: Message[] = [];

  // Primary: event.content (can be string, array of blocks, or single block)
  const content = evt.content;
  if (content !== undefined && content !== null) {
    messages.push({ role: "user", content, timestamp: typeof evt.timestamp === "string" ? evt.timestamp : undefined });
    return messages;
  }

  // Fallback: event.body (plain string body text)
  const body = evt.body;
  if (typeof body === "string" && body.trim().length > 0) {
    messages.push({ role: "user", content: body, timestamp: typeof evt.timestamp === "string" ? evt.timestamp : undefined });
    return messages;
  }

  return [];
}

/**
 * Build an assistant-role delta Message[] from a message_sent event.
 *
 * OpenClaw message_sent event shape:
 *   { to?: string, content: string | ContentBlock[] | ContentBlock, success?: boolean, error?: string }
 *
 * Returns empty array when success !== true (caller should no-op).
 */
export function buildMessageSentDelta(event: unknown): Message[] {
  if (!event || typeof event !== "object") return [];

  const evt = event as Record<string, unknown>;

  // Only ingest on confirmed success
  if (evt.success !== true) return [];

  const content = evt.content;
  if (content === undefined || content === null) return [];

  return [{ role: "assistant", content }];
}

/**
 * Collect ALL available session/conversation keys from ctx.
 * Returns a deduplicated array of non-empty string keys found in ctx,
 * in priority order: sessionKey > conversationId > conversation.id > sessionId.
 */
export function getAllConversationKeys(ctx: unknown): string[] {
  if (!ctx || typeof ctx !== "object") return [];
  const c = ctx as Record<string, unknown>;
  const keys: string[] = [];
  const seen = new Set<string>();

  const tryAdd = (val: unknown) => {
    if (typeof val === "string" && val.trim().length > 0) {
      if (!seen.has(val)) {
        seen.add(val);
        keys.push(val);
      }
    }
  };

  tryAdd(c.sessionKey);
  tryAdd(c.conversationId);
  if (c.conversation && typeof c.conversation === "object") {
    const conv = c.conversation as Record<string, unknown>;
    tryAdd(conv.id);
  }
  tryAdd(c.sessionId);

  return keys;
}

/**
 * Resolve a stable conversation/session key from the hook context.
 *
 * Priority:
 *   1. ctx.sessionKey (direct, set by before_dispatch)
 *   2. ctx.conversationId (used to look up SessionMappingCache entry)
 *   3. ctx.conversation?.id
 *   4. ctx.sessionId
 *   5. Fallback: null (caller should no-op)
 */
export function normalizeConversationKey(ctx: unknown): string | null {
  const allKeys = getAllConversationKeys(ctx);
  return allKeys.length > 0 ? allKeys[0] : null;
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
  // Surprise improvements (v0.4.0 Phase 3)
  private segmentationTimeGapMinutes: number;
  // Idle flush timer (v0.4.3): auto-flush buffer after silence
  private idleFlushTimer: NodeJS.Timeout | null = null;
  private lastBufferActivityAt = 0;
  // Narrative architecture (v0.4.0)
  private pool: NarrativePool | null;
  private narrativeWorker: NarrativeWorker | null;

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
      timeGapMinutes?: number;
    },
    pool?: NarrativePool | null,
    narrativeWorker?: NarrativeWorker | null,
  ) {
    this.rpc = rpc;
    this.dedupWindow = dedupWindow;
    this.maxBufferChars = maxBufferChars;
    this.maxCharsPerChunk = maxCharsPerChunk;
    this.segmentationLambda = Math.max(0, tuning?.lambda ?? 2.0);
    this.segmentationWarmupCount = Math.max(0, tuning?.warmupCount ?? 10);  // Phase 3: was 20
    this.segmentationMinRawSurprise = Math.max(0, tuning?.minRawSurprise ?? 0.05);
    this.segmentationCooldownTurns = Math.max(0, tuning?.cooldownTurns ?? 2);
    this.segmentationStdFloor = Math.max(0.0001, tuning?.stdFloor ?? 0.01);
    this.segmentationFallbackThreshold = Math.max(0, tuning?.fallbackThreshold ?? 0.2);
    this.segmentationTimeGapMinutes = tuning?.timeGapMinutes ?? 15;
    this.pool = pool ?? null;
    this.narrativeWorker = narrativeWorker ?? null;
  }

  /**
   * Wake the narrative worker from idle backoff. Used by archiver and other callers
   * that enqueue directly without going through poolAndQueue.
   */
  wakeNarrativeWorker(): void {
    this.narrativeWorker?.wake();
  }

  // ─── Idle flush timer (v0.4.3) ──────────────────────────────────────────

  /**
   * Clear any pending idle flush timer.
   * Called before scheduling a new timer or on forced flush/context reset.
   */
  private clearIdleFlushTimer(): void {
    if (this.idleFlushTimer) {
      clearTimeout(this.idleFlushTimer);
      this.idleFlushTimer = null;
    }
  }

  /**
   * Schedule an idle flush timer if the buffer is non-empty.
   * Fires after `segmentationTimeGapMinutes` of no new activity.
   */
  private scheduleIdleFlush(agentWs: string, agentId: string): void {
    if (this.buffer.length === 0) return;

    this.clearIdleFlushTimer();
    this.lastBufferActivityAt = Date.now();
    const delayMs = this.segmentationTimeGapMinutes * 60 * 1000;

    this.idleFlushTimer = setTimeout(async () => {
      this.idleFlushTimer = null;
      await this.handleIdleFlush(agentWs, agentId);
    }, delayMs).unref(); // unref() to not block process exit
  }

  /**
   * Fired when the idle flush timer expires.
   * Flushes the buffer if it has meaningful text content.
   */
  private async handleIdleFlush(agentWs: string, agentId: string): Promise<boolean> {
    // Guard: don't flush if buffer was already cleared (race protection)
    if (this.buffer.length === 0) return false;

    // Check if buffer has meaningful text (not just images/tools)
    const textContent = this.buffer
      .filter(m => !EXCLUDED_ROLES.has(m.role) && m.role !== "tool_use")
      .map(m => extractText(m.content).trim())
      .filter(Boolean);

    if (textContent.length === 0) {
      console.log("[Episodic Memory] Idle flush skipped: buffer has no text content (image/tool-only).");
      return false;
    }

    // Preserve cursor before flush — poolAndQueue resets it to 0
    const savedLastProcessedLength = this.lastProcessedLength;

    console.log(`[Episodic Memory] Idle timeout (${this.segmentationTimeGapMinutes}min). Auto-finalizing buffer (${textContent.length} text messages)...`);
    await this.handleSegmentBoundary(agentWs, agentId, 0, "idle-timeout");

    // Restore cursor — messages up to savedLastProcessedLength are already processed
    this.lastProcessedLength = savedLastProcessedLength;
    this.buffer = [];
    return true;
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
   * Phase 3: Detect time gap between user messages.
   * Compares the last user message in the buffer with the first user message in the new batch.
   * If the gap exceeds the configured threshold, force a segment boundary.
   */
  private isTimeGapBoundary(newMsgs: Message[]): boolean {
    if (this.buffer.length === 0 || newMsgs.length === 0) return false;

    // Find the last user message in the buffer
    const lastBufferUser = [...this.buffer].reverse().find(m => m.role === "user" && m.timestamp);
    // Find the first user message in the new messages
    const firstNewUser = newMsgs.find(m => m.role === "user" && m.timestamp);

    if (!lastBufferUser?.timestamp || !firstNewUser?.timestamp) return false;

    const lastTs = new Date(lastBufferUser.timestamp).getTime();
    const firstTs = new Date(firstNewUser.timestamp).getTime();
    const gapMs = firstTs - lastTs;
    const thresholdMs = this.segmentationTimeGapMinutes * 60 * 1000;
    return gapMs > thresholdMs;
  }

  /**
   * Phase 3: Simple adaptive lambda — 2-tier (KISS).
   * Short sessions (<10 turns) use lower lambda for better sensitivity.
   */
  private getEffectiveLambda(): number {
    if (this.segCount < 10) return Math.min(1.5, this.segmentationLambda);
    return this.segmentationLambda;
  }

  /**
   * Evaluates the new context Turn and determines if an episode boundary was crossed.
   * If yes, triggers ingest to flush the old buffer.
   */
  async processTurn(currentMessages: Message[], agentWs: string, agentId: string = ""): Promise<boolean> {
    if (currentMessages.length === 0) {
      console.log("[Episodic Memory] processTurn: empty message list, skipping.");
      return false;
    }

    // Detect context wipe/reset
    if (this.lastProcessedLength > currentMessages.length) {
      // Fix B: reset 検出時に buffer を flush してから破棄（forceFlush 失敗時も確実にクリア）
      if (this.buffer.length > 0) {
        console.log(`[Episodic Memory] Context reset detected. Flushing ${this.buffer.length} buffered messages.`);
        await this.forceFlush(agentWs, agentId);
      }
      this.clearIdleFlushTimer(); // Clear timer on context reset
      this.lastProcessedLength = 0;
      this.buffer = []; // forceFlush 失敗時も確実にクリア
    }

    const newMessages = currentMessages.slice(this.lastProcessedLength);
    if (newMessages.length === 0) {
      console.log(`[Episodic Memory] processTurn: no new messages (lastProcessedLength=${this.lastProcessedLength}, current=${currentMessages.length})`);
      return false;
    }

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
      // Schedule idle flush for the new buffer
      this.scheduleIdleFlush(agentWs, agentId);
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
      console.log(`[Episodic Memory] processTurn: no text content in new messages (image-only or tool_use-only, ${dedupedMessages.length} message(s) filtered out)`);
      this.lastProcessedLength = currentMessages.length;
      return false;
    }

    // 定期的なチャンク分割（Surprise判定を待たずにバッファが大きすぎる場合は強制分割）
    const estimatedChars = this.buffer.reduce((acc, m) => acc + extractText(m.content).length, 0);

    // Phase 3: Time gap boundary check
    if (this.isTimeGapBoundary(dedupedMessages)) {
      console.log(`[Episodic Memory] Time gap boundary detected (${this.segmentationTimeGapMinutes}min threshold). Forcing segment...`);
      await this.handleSegmentBoundary(agentWs, agentId, 0, "time-gap");
      this.buffer = [...dedupedMessages];
      this.lastProcessedLength = currentMessages.length;
      // Reschedule idle flush for the new buffer after time-gap boundary
      this.scheduleIdleFlush(agentWs, agentId);
      return true;
    }

    try {
      const sizeLimitExceeded = estimatedChars > this.maxBufferChars;
      this.turnSeq += 1;

      const score = await this.rpc.segmentScore({
        agentWs,
        agentId: agentId || "auto",
        turn: this.turnSeq,
        text1: oldSlice,
        text2: newSlice,
        lambda: this.getEffectiveLambda(),
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

        // Mode branching: pool+queue (v0.4.0) vs legacy chunkAndIngest (v0.3.x)
        this.handleSegmentBoundary(agentWs, agentId, surprise, reason).catch(err => {
          console.error("[Episodic Memory] Error in segment boundary handling:", err);
        });

        // Clear buffer and start fresh with the new context
        this.buffer = [...dedupedMessages];
        // Reschedule idle flush for the new buffer after boundary
        this.scheduleIdleFlush(agentWs, agentId);
      } else {
        // Just append to buffer / update buffer
        this.buffer.push(...dedupedMessages);
        // Reschedule idle flush for the updated buffer
        this.scheduleIdleFlush(agentWs, agentId);
      }
      this.lastProcessedLength = currentMessages.length;
      return true;
    } catch (err) {
      console.error("[Episodic Memory] Error in segmenter processTurn:", err);
      // Fallback: absorb deduped messages only（Fix D-1 を catch でも維持）
      this.buffer.push(...dedupedMessages);
      this.lastProcessedLength = currentMessages.length;
      // Reschedule idle flush on error recovery
      this.scheduleIdleFlush(agentWs, agentId);
    }
    return false;
  }

  /**
   * Incremental ingest entry point for hook-driven payloads (v0.4.7).
   *
   * Unlike processTurn, this does NOT depend on lastProcessedLength or
   * cumulative message history. It accepts a delta (single turn payload)
   * and appends it to the buffer with dedup + boundary checks.
   *
   * Designed for before_dispatch / message_sent hook payloads where the
   * full conversation history is not available.
   *
   * @param deltaMessages - new messages from a single hook event
   * @param agentWs - agent workspace path
   * @param agentId - agent identifier
   * @param source - diagnostic source label (e.g. "before_dispatch", "message_sent")
   */
  async processIncrementalTurn(
    deltaMessages: Message[],
    agentWs: string,
    agentId: string,
    source: string = "hook",
  ): Promise<boolean> {
    if (deltaMessages.length === 0) {
      console.log(`[Episodic Memory] processIncrementalTurn: empty delta from ${source}, skipping.`);
      return false;
    }

    // Filter out excluded roles and summarize tool_use
    const filteredMessages = deltaMessages
      .filter(m => !EXCLUDED_ROLES.has(m.role))
      .map(m => {
        if (m.role === "tool_use") {
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

    // Dedup against recent buffer entries
    const recentKeys = new Set(
      this.buffer.slice(-this.dedupWindow).map(m => `${m.role}:${extractText(m.content).trim()}`)
    );
    const dedupedMessages = filteredMessages.filter(m => {
      const text = extractText(m.content).trim();
      if (!text) return false;
      const key = `${m.role}:${text}`;
      if (recentKeys.has(key)) return false;
      recentKeys.add(key);
      return true;
    });
    if (dedupedMessages.length === 0) {
      console.log(`[Episodic Memory] processIncrementalTurn: all ${deltaMessages.length} message(s) were duplicates/empty from ${source}, skipping.`);
      return false;
    }

    if (this.buffer.length === 0) {
      // First turn, just absorb
      this.buffer.push(...dedupedMessages);
      this.scheduleIdleFlush(agentWs, agentId);
      return false;
    }

    // Check time gap boundary
    if (this.isTimeGapBoundary(dedupedMessages)) {
      console.log(`[Episodic Memory] Time gap boundary detected (${this.segmentationTimeGapMinutes}min threshold) via ${source}. Forcing segment...`);
      await this.handleSegmentBoundary(agentWs, agentId, 0, "time-gap");
      this.buffer = [...dedupedMessages];
      this.scheduleIdleFlush(agentWs, agentId);
      return true;
    }

    // Compute surprise score for the incremental delta
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
      console.log(`[Episodic Memory] processIncrementalTurn: no text content from ${source}.`);
      return false;
    }

    const estimatedChars = this.buffer.reduce((acc, m) => acc + extractText(m.content).length, 0);
    const sizeLimitExceeded = estimatedChars > this.maxBufferChars;
    this.turnSeq += 1;

    try {
      const score = await this.rpc.segmentScore({
        agentWs,
        agentId: agentId || "auto",
        turn: this.turnSeq,
        text1: oldSlice,
        text2: newSlice,
        lambda: this.getEffectiveLambda(),
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
          `[Episodic Memory] SegmentScore (incremental/${source}): raw=${surprise.toFixed(4)} ` +
          `mean=${mean} std=${std} threshold=${th} z=${z} ` +
          `boundary=${shouldBoundary} reason=${score?.reason ?? "n/a"}`
        );
      }

      if (shouldBoundary) {
        const reason = sizeLimitExceeded ? "size-limit" : "surprise-boundary";
        console.log(`[Episodic Memory] ${reason} exceeded (incremental/${source}). Finalizing previous episode...`);
        this.handleSegmentBoundary(agentWs, agentId, surprise, reason).catch(err => {
          console.error("[Episodic Memory] Error in segment boundary handling (incremental):", err);
        });
        this.buffer = [...dedupedMessages];
        this.scheduleIdleFlush(agentWs, agentId);
      } else {
        this.buffer.push(...dedupedMessages);
        this.scheduleIdleFlush(agentWs, agentId);
      }
      return true;
    } catch (err) {
      console.error(`[Episodic Memory] Error in processIncrementalTurn (${source}):`, err);
      this.buffer.push(...dedupedMessages);
      this.scheduleIdleFlush(agentWs, agentId);
    }
    return false;
  }

  /**
   * Mode branching: pool+queue (v0.4.0 narrative) vs legacy chunkAndIngest (v0.3.x).
   * Fire-and-forget — never awaited by processTurn.
   */
  private async handleSegmentBoundary(agentWs: string, agentId: string, surprise: number, reason: string): Promise<void> {
    if (this.pool && this.narrativeWorker) {
      return this.poolAndQueue(agentWs, agentId, surprise, reason);
    }
    // Legacy path (v0.3.x) — no narrative architecture
    return this.chunkAndIngest(this.buffer, agentWs, reason, agentId, surprise);
  }

  /**
   * Pool mode (v0.4.2): accumulate messages in NarrativePool, split into 64K chunks,
   * and enqueue to the Go cache DB for sequential narrativization.
   * Fire-and-forget — never awaited by processTurn.
   */
  private async poolAndQueue(agentWs: string, agentId: string, surprise: number, reason: string): Promise<void> {
    if (!this.pool || !this.narrativeWorker) return;

    const item = this.pool.add(this.buffer.slice(), surprise, agentWs, agentId);
    // Clear segmenter buffer and idle flush timer; messages are now in the pool.
    this.buffer = [];
    this.lastProcessedLength = 0;
    this.clearIdleFlushTimer();

    if (item) {
      // Flush occurred: clear pool buffer and process.
      this.pool.clear();

      // Split into 64K chunks and enqueue to cache DB
      // Preserve idle-timeout reason for observability — don't collapse it into size-limit
      const cacheReason = (
        reason === "idle-timeout" ? "idle-timeout" :
        reason === "surprise-boundary" ? "surprise-boundary" :
        "size-limit"
      ) as "idle-timeout" | "surprise-boundary" | "size-limit";
      const chunks = splitIntoChunks(item.rawText, agentWs, agentId, "live-turn", cacheReason, surprise);
      // Pass wake callback to wake the worker from idle backoff
      enqueueNarrativeChunks(this.rpc, chunks, () => this.narrativeWorker?.wake()).catch(err =>
        console.error("[Episodic Memory] Cache enqueue failed:", err)
      );
    }
    // If item is null, pool is still buffering; do not clear it.
  }

  /**
   * Save raw conversation log as .raw.md fallback file.
   * Used when narrative generation fails or as backup data.
   */
  private async saveRawLog(item: PoolFlushItem, agentWs: string): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rawPath = path.join(agentWs, `${timestamp}.raw.md`);
    await fs.promises.writeFile(rawPath, item.rawText, "utf8");
    console.log(`[Episodic Memory] Raw log saved: ${rawPath}`);
  }

  /**
   * Forcibly flushes the current buffer to the cache queue regardless of surprise score.
   * Useful before compact() to ensure no context is lost.
   */
  async forceFlush(agentWs: string, agentId: string = ""): Promise<void> {
    if (this.buffer.length === 0) return;
    try {
      console.log(`[Episodic Memory] Force flushing segmenter buffer (${this.buffer.length} messages)...`);
      this.clearIdleFlushTimer(); // Clear timer on force flush

      if (this.pool && this.narrativeWorker) {
        // Pool mode (v0.4.2): add to pool, split, and enqueue to cache DB
        this.pool.add(this.buffer.slice(), 0, agentWs, agentId);
        const item = this.pool.forceFlush(agentWs, agentId);
        this.pool.clear();
        if (item) {
          const chunks = splitIntoChunks(item.rawText, agentWs, agentId, "live-turn", "force-flush", 0);
          // Pass wake callback to wake the worker from idle backoff
          await enqueueNarrativeChunks(this.rpc, chunks, () => this.narrativeWorker?.wake());
        }
        this.buffer = [];
        this.lastProcessedLength = 0;
        return;
      }

      // Legacy path (v0.3.x)
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
