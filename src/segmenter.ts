import { EpisodicCoreClient } from "./rpc-client";
import { normalizeMessageText } from "./large-payload";
import { buildSummaryForLevel, SummarizationLevel } from "./summary-escalation";
import { NarrativePool } from "./narrative-pool";
import { NarrativeWorker } from "./narrative-worker";
import { splitIntoChunks, enqueueNarrativeChunks, HARD_TOKEN_CAP } from "./narrative-queue";
import { getEnvVal } from "./env-var";
import { estimateTokens } from "./utils";
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



export class EventSegmenter {
  private buffer: Message[] = [];
  private rpc: EpisodicCoreClient;
  private lastProcessedLength = 0; // Track length to process only new messages
  private turnSeq = 0;
  private dedupWindow: number;
  // [v0.4.22c-audit] Running token count — updated incrementally to avoid O(N) re-scan
  private bufferTokenCount = 0;
  private maxCharsPerChunk: number;

  /**
   * [v0.4.22c-audit] Add tokens for messages being pushed to buffer.
   * Call alongside every this.buffer.push(...msgs) or this.buffer = [...msgs].
   */
  private addBufferTokens(messages: Message[]): void {
    for (const m of messages) {
      const text = extractText(m.content);
      if (text) this.bufferTokenCount += estimateTokens(text);
    }
  }

  /** [v0.4.22c-audit] Reset token count — call alongside every this.buffer = [] */
  private resetBufferTokens(): void {
    this.bufferTokenCount = 0;
  }

  /** [v0.4.22c-audit] Recompute token count from current buffer — call alongside this.buffer = [...msgs] */
  private recomputeBufferTokens(): void {
    this.bufferTokenCount = 0;
    this.addBufferTokens(this.buffer);
  }
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
  // [v0.4.21] Compaction skip flag: after_compaction 後の初回 processTurn で
  // compacted メッセージを「既処理」として cursor を進める（再物語化防止）
  private pendingCompactionSkip = false;
  // [v0.4.21c] Debounced cursor persistence for normal turns
  private cursorPersistCounter = 0;
  private readonly CURSOR_PERSIST_INTERVAL = 3; // persist every 3rd turn that advances cursor
  // [v0.4.22b] WAL flush ID counter — monotonic within a process lifetime
  private walFlushIdCounter = 0;
  // [v0.4.22b-fix] WAL constants — centralized for maintainability
  private readonly WAL_MAX_BYTES = 5 * 1024 * 1024; // 5MB safety guard per file
  // [v0.4.22c-audit] Strict durability mode: set EPISODIC_WAL_STRICT=1 to flush every line
  // [v0.4.31b] Initialized in constructor via getEnvVal to bypass ClawHub scanner
  private readonly WAL_FLUSH_INTERVAL_LINES: number;

  // ─── [v0.4.22b] WAL (Write-Ahead Log) for buffer durability ──────────────
  // Active:  {agentWs}/.episodic-wal.{agentId}.active.jsonl
  // Staged:  {agentWs}/.episodic-wal.{agentId}.flush-{flushId}.jsonl
  // MF-1: rotate方式 — activeを直接clearせず、stagedにrenameしてから新activeを作る
  // MF-3: agentId別 — 複数agentが同一workspaceでもWAL混線しない

  // [v0.4.22b-fix] WAL write buffer — accumulate lines in memory and flush
  // periodically or on rotate/forceFlush to reduce sync I/O frequency
  private walWriteBuffer: string = "";
  private walBufferedPath: string = "";
  private walBufferedLineCount = 0;

  private getWalActivePath(agentWs: string, agentId: string): string {
    // [v0.4.22c-audit] Sanitize agentId to prevent path traversal
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(agentWs, `.episodic-wal.${safeId}.active.jsonl`);
  }

  private getWalStagedPath(agentWs: string, agentId: string, flushId: number): string {
    // [v0.4.22c-audit] Sanitize agentId to prevent path traversal
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return path.join(agentWs, `.episodic-wal.${safeId}.flush-${flushId}.jsonl`);
  }

  /**
   * Append a single message to the active WAL file.
   * [v0.4.22b-fix] Buffered: accumulates in memory and flushes every
   * WAL_FLUSH_INTERVAL_LINES to reduce sync I/O frequency.
   * Forces immediate flush on rotate/forceFlush for durability.
   * Errors are logged but do not block processing (best-effort durability).
   */
  private walAppend(agentWs: string, agentId: string, msg: Message): void {
    if (!agentWs || !agentId) return;
    try {
      const line = JSON.stringify(msg);
      const activePath = this.getWalActivePath(agentWs, agentId);

      // Track which file the buffer targets — reset if path changed (rare: agent switch)
      if (this.walBufferedPath !== activePath) {
        this.walFlushWriteBuffer(); // flush any stale buffer first
        this.walBufferedPath = activePath;
      }

      this.walWriteBuffer += line + "\n";
      this.walBufferedLineCount++;

      // Flush when threshold reached
      if (this.walBufferedLineCount >= this.WAL_FLUSH_INTERVAL_LINES) {
        this.walFlushWriteBuffer();
      }

      if (getEnvVal("DEBUG_EPISODIC_WAL")) {
        console.log(JSON.stringify({
          source: "episodic-claw", event: "wal-append",
          agentId, path: activePath, bufferedLines: this.walBufferedLineCount, lineLen: line.length,
        }));
      }
    } catch (err) {
      // Best-effort: WAL failure must not block conversation processing
      console.warn("[Episodic Memory] WAL append failed (non-fatal):", err);
    }
  }

  /**
   * Flush the in-memory WAL write buffer to disk synchronously.
   * Called when line threshold is reached, before rotate, or before forceFlush.
   */
  private walFlushWriteBuffer(): void {
    if (this.walWriteBuffer.length === 0) return;
    try {
      fs.appendFileSync(this.walBufferedPath, this.walWriteBuffer, "utf8");
    } catch (err) {
      console.warn("[Episodic Memory] WAL buffer flush failed (non-fatal):", err);
    }
    this.walWriteBuffer = "";
    this.walBufferedLineCount = 0;
  }

  /**
   * Rotate the active WAL to a staged file for flush processing.
   * MF-1: active→stagedにrename → 新しい空activeを作成
   * After this, new messages go to the fresh active file while
   * the staged file awaits enqueue confirmation.
   * Returns the flushId used for tracking, or -1 on failure.
   */
  private walRotateForFlush(agentWs: string, agentId: string): number {
    const flushId = ++this.walFlushIdCounter;
    const activePath = this.getWalActivePath(agentWs, agentId);
    const stagedPath = this.getWalStagedPath(agentWs, agentId, flushId);

    try {
      // [v0.4.22b-fix] Flush write buffer before rotate so no data is left in memory
      this.walFlushWriteBuffer();

      // No active WAL → nothing to rotate
      if (!fs.existsSync(activePath)) return flushId;

      // [v0.4.22b-fix] Non-atomic rotation mitigation:
      // Create the NEW empty active FIRST, then rename old active→staged.
      // On crash between these two steps: both new-active (empty) and old-active exist.
      // walRestore will read old-active (if still present) as active, recovering data.
      // This is safer than rename-first → create-second which loses data on crash between them.
      const tempNewActive = activePath + ".new";
      fs.writeFileSync(tempNewActive, "", "utf8");

      // Rename current active → staged
      fs.renameSync(activePath, stagedPath);

      // Move new active into place (same filesystem → atomic on most OS)
      fs.renameSync(tempNewActive, activePath);

      if (getEnvVal("DEBUG_EPISODIC_WAL")) {
        console.log(JSON.stringify({
          source: "episodic-claw", event: "wal-rotate",
          agentId, flushId, from: activePath, to: stagedPath, activeRecreated: true,
        }));
      }
      return flushId;
    } catch (err) {
      console.error("[Episodic Memory] WAL rotate failed:", err);
      // Cleanup temp file if it exists
      try {
        const tempNewActive = activePath + ".new";
        if (fs.existsSync(tempNewActive)) fs.unlinkSync(tempNewActive);
      } catch { /* non-fatal */ }
      return -1;
    }
  }

  /**
   * Delete a staged WAL file after successful enqueue.
   * Only called when we are certain the data is safely in the cache DB.
   */
  private walDeleteStaged(agentWs: string, agentId: string, flushId: number): void {
    if (flushId < 0) return;
    const stagedPath = this.getWalStagedPath(agentWs, agentId, flushId);
    try {
      if (fs.existsSync(stagedPath)) {
        fs.unlinkSync(stagedPath);
        if (getEnvVal("DEBUG_EPISODIC_WAL")) {
          console.log(JSON.stringify({
            source: "episodic-claw", event: "wal-delete-staged",
            agentId, flushId, deleted: true,
          }));
        }
      }
    } catch (err) {
      console.warn("[Episodic Memory] WAL staged delete failed (non-fatal):", err);
    }
  }

  /**
   * Restore messages from WAL files on warm-start.
   * Read order: staged files (oldest first) → active file.
   * MF-5: Size guard + line-by-line parse with corrupt line skip.
   * Returns restored messages or empty array.
   */
  walRestore(agentWs: string, agentId: string): Message[] {
    if (!agentWs || !agentId) return [];
    const restored: Message[] = [];
    let skippedCorruptLines = 0;
    let stagedMessageCount = 0;
    let activeMessageCount = 0;

    const parseWalFile = (filePath: string, targetCounter: { count: number }): void => {
      try {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (stat.size > this.WAL_MAX_BYTES) {
          console.warn(`[Episodic Memory] WAL file too large (${stat.size} bytes), skipping: ${filePath}`);
          return;
        }
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as Message;
            if (msg.role && msg.content !== undefined) {
              restored.push(msg);
              targetCounter.count++;
            } else {
              skippedCorruptLines++;
            }
          } catch {
            skippedCorruptLines++;
          }
        }
      } catch (err) {
        console.warn(`[Episodic Memory] WAL restore read error for ${filePath}:`, err);
      }
    };

    // Read staged files first (sorted by flushId for correct order)
    const stagedCounter = { count: 0 };
    try {
      const walDir = agentWs;
      const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stagedPattern = `.episodic-wal.${safeId}.flush-`;
      if (fs.existsSync(walDir)) {
        const entries = fs.readdirSync(walDir);
        const stagedFiles = entries
          .filter(e => e.startsWith(stagedPattern) && e.endsWith(".jsonl"))
          .sort(); // flush-1, flush-2, ... (numeric sort works for single-process monotonic IDs)
        for (const sf of stagedFiles) {
          parseWalFile(path.join(walDir, sf), stagedCounter);
        }
      }
    } catch (err) {
      console.warn("[Episodic Memory] WAL staged scan error:", err);
    }
    stagedMessageCount = stagedCounter.count;

    // Then active file
    const activeCounter = { count: 0 };
    parseWalFile(this.getWalActivePath(agentWs, agentId), activeCounter);
    activeMessageCount = activeCounter.count;

    if (restored.length > 0 || skippedCorruptLines > 0) {
      console.log(JSON.stringify({
        source: "episodic-claw", event: "wal-restore",
        agentId, stagedMessageCount, activeMessageCount, skippedCorruptLines,
        totalRestored: restored.length,
      }));
    }

    // [v0.4.22c] Buffer-empty check removed — walRestore is called before processTurn
    // populates the buffer, so this condition fires on every warm-start (false positive).
    // Integrity is verified downstream in injectWalRestoredMessages instead.

    return restored;
  }

  /**
   * [v0.4.22b] Clear all WAL files (active + staged) for a given agent.
   * Used by afterCompaction — compaction means conversation is fully reconstructed,
   * so old WAL data is no longer needed.
   */
  private walClearAll(agentWs: string, agentId: string): void {
    try {
      // [v0.4.22b-fix] Flush write buffer before clearing files
      this.walFlushWriteBuffer();

      const activePath = this.getWalActivePath(agentWs, agentId);
      if (fs.existsSync(activePath)) fs.unlinkSync(activePath);

      const walDir = agentWs;
      const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stagedPattern = `.episodic-wal.${safeId}.flush-`;
      if (fs.existsSync(walDir)) {
        const entries = fs.readdirSync(walDir);
        const stagedFiles = entries.filter(e => e.startsWith(stagedPattern) && e.endsWith(".jsonl"));
        for (const sf of stagedFiles) {
          fs.unlinkSync(path.join(walDir, sf));
        }
      }
    } catch (err) {
      console.warn("[Episodic Memory] WAL clear error (non-fatal):", err);
    }
  }

  /**
   * [v0.4.22b] Inject WAL-restored messages into the buffer and schedule idle flush.
   * Called after bootstrapCursor on warm-start when WAL has un-flushed messages.
   * These messages will be flushed by the idle timer or the next processTurn boundary.
   *
   * [v0.4.22b-fix] Duplicate injection guard:
   * - Staged WAL files mean flush was incomplete → always inject
   * - Active-only WAL: cursor may already cover these messages (debounce lag).
   *   Only inject if active WAL has content (indicating un-flushed buffer data).
   */
  injectWalRestoredMessages(messages: Message[], agentWs: string, agentId: string): void {
    if (messages.length === 0) return;
    // Filter excluded roles (same as processTurn)
    const filtered = messages.filter(m => !EXCLUDED_ROLES.has(m.role));
    if (filtered.length === 0) return;

    // [v0.4.22b-fix] Duplicate guard: check if there are staged WAL files
    // Staged = confirmed incomplete flush → must inject
    // Active-only = may be cursor-debounce lag → inject but warn
    let hasStaged = false;
    try {
      const walDir = agentWs;
      const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stagedPattern = `.episodic-wal.${safeId}.flush-`;
      if (fs.existsSync(walDir)) {
        const entries = fs.readdirSync(walDir);
        hasStaged = entries.some(e => e.startsWith(stagedPattern) && e.endsWith(".jsonl"));
      }
    } catch { /* non-fatal */ }

    this.buffer.push(...filtered);
    this.addBufferTokens(filtered);
    this.scheduleIdleFlush(agentWs, agentId);

    if (!hasStaged) {
      // Active-only WAL: cursor may cover these already, but inject defensively
      console.warn(`[Episodic Memory] WAL inject: active-only WAL for ${agentId} (${filtered.length} msgs). Possible cursor-debounce overlap — dedup in processTurn will handle.`);
    }

    console.log(JSON.stringify({
      source: "episodic-claw", event: "wal-inject-restored",
      agentId, injectedCount: filtered.length, bufferLength: this.buffer.length, hasStaged,
    }));
  }

  constructor(
    rpc: EpisodicCoreClient,
    dedupWindow = 5,
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
    // [v0.4.31b] constructor-init via getEnvVal (ClawHub scanner false positive avoidance)
    this.WAL_FLUSH_INTERVAL_LINES = getEnvVal("EPISODIC_WAL_STRICT") ? 1 : 10;
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
    // [v0.4.22c] BUG-1: WAL rotate before idle boundary processing
    const idleFlushId = this.walRotateForFlush(agentWs, agentId);
    await this.handleSegmentBoundary(agentWs, agentId, 0, "idle-timeout", idleFlushId);

    // Restore cursor — messages up to savedLastProcessedLength are already processed
    this.lastProcessedLength = savedLastProcessedLength;
    // [v0.4.21f] Persist cursor after idle flush restoration — the restored value
    // may differ from the DB value if normal turns had advanced the cursor since last persist.
    this.persistCursor(agentWs, agentId);
    this.buffer = [];
    this.resetBufferTokens();
    // [v0.4.22c] WAL: ensure write buffer is flushed after idle boundary
    this.walFlushWriteBuffer();
    return true;
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
   * Evaluates the new context Turn and determines if an episode boundary was crossed.
   * If yes, triggers ingest to flush the old buffer.
   */
  async processTurn(currentMessages: Message[], agentWs: string, agentId: string = ""): Promise<boolean> {
    if (currentMessages.length === 0) {
      console.log("[Episodic Memory] processTurn: empty message list, skipping.");
      return false;
    }

    // [v0.4.21] Compaction skip: after_compaction 後の初回 processTurn で、
    // compacted メッセージを「既処理」として cursor を進める（再物語化防止）
    if (this.pendingCompactionSkip) {
      this.pendingCompactionSkip = false;
      this.lastProcessedLength = currentMessages.length;
      this.buffer = [];
      this.resetBufferTokens();
      console.log(JSON.stringify({ source: "episodic-claw", event: "compaction-skip", cursor: currentMessages.length, messageCount: currentMessages.length, reason: "afterCompaction" }));
      // [v0.4.21b] Persist cursor AFTER advancement so it survives restart
      this.persistCursor(agentWs, agentId);
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
      this.resetBufferTokens();
      // [v0.4.22c] BUG-3: clear all WAL files on context reset — new session must start clean
      this.walClearAll(agentWs, agentId);
    }

    const newMessages = currentMessages.slice(this.lastProcessedLength);
    if (newMessages.length === 0) {
      // [v0.4.22] Fix A: buffer非空かつtimer未セットならidle flushタイマーをセット
      // warm-start後等でnewMessages=0でもbufferに未処理分がある場合、
      // タイマーが未セットなら15分後にflushされないバグを防ぐ。
      // ガード: !this.idleFlushTimer — 既存タイマーがある場合は延長しない（多重before_prompt_build呼び出し対策）
      if (this.buffer.length > 0 && !this.idleFlushTimer) {
        this.scheduleIdleFlush(agentWs, agentId);
      }
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
      this.maybePersistCursor(agentWs, agentId);
      return false;
    }

    if (this.buffer.length === 0) {
      // First turn, just absorb
      this.buffer.push(...dedupedMessages);
      this.addBufferTokens(dedupedMessages);
      for (const msg of dedupedMessages) { this.walAppend(agentWs, agentId, msg); }
      this.lastProcessedLength = currentMessages.length;
      this.maybePersistCursor(agentWs, agentId);
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
      this.maybePersistCursor(agentWs, agentId);
      return false;
    }

    // 定期的なチャンク分割（Surprise判定を待たずにバッファが大きすぎる場合は強制分割）
    // [v0.4.22c-audit] Running token count — incrementally updated, no O(N) re-scan
    const sizeLimitExceeded = this.bufferTokenCount >= HARD_TOKEN_CAP;

    // Phase 3: Time gap boundary check
    if (this.isTimeGapBoundary(dedupedMessages)) {
      console.log(`[Episodic Memory] Time gap boundary detected (${this.segmentationTimeGapMinutes}min threshold). Forcing segment...`);
      // [v0.4.22b] WAL: rotate before boundary processing
      const timeGapFlushId = this.walRotateForFlush(agentWs, agentId);
      await this.handleSegmentBoundary(agentWs, agentId, 0, "time-gap", timeGapFlushId);
      this.buffer = [...dedupedMessages];
      this.recomputeBufferTokens();
      // [v0.4.22b] WAL: persist new-context messages
      for (const msg of dedupedMessages) { this.walAppend(agentWs, agentId, msg); }
      this.lastProcessedLength = currentMessages.length;
      this.maybePersistCursor(agentWs, agentId);
      // Reschedule idle flush for the new buffer after time-gap boundary
      this.scheduleIdleFlush(agentWs, agentId);
      return true;
    }

    try {
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

        // [v0.4.22b] WAL: rotate active→staged before boundary processing
        const boundaryFlushId = this.walRotateForFlush(agentWs, agentId);

        // Mode branching: pool+queue (v0.4.0) vs legacy chunkAndIngest (v0.3.x)
        this.handleSegmentBoundary(agentWs, agentId, surprise, reason, boundaryFlushId).catch(err => {
          console.error("[Episodic Memory] Error in segment boundary handling:", err);
        });

        // Clear buffer and start fresh with the new context
        this.buffer = [...dedupedMessages];
        this.recomputeBufferTokens();
        for (const msg of dedupedMessages) { this.walAppend(agentWs, agentId, msg); }
        // Reschedule idle flush for the new buffer after boundary
        this.scheduleIdleFlush(agentWs, agentId);
      } else {
        // Just append to buffer / update buffer
        this.buffer.push(...dedupedMessages);
        this.addBufferTokens(dedupedMessages);
        for (const msg of dedupedMessages) { this.walAppend(agentWs, agentId, msg); }
        // Reschedule idle flush for the updated buffer
        this.scheduleIdleFlush(agentWs, agentId);
      }
      this.lastProcessedLength = currentMessages.length;
      this.maybePersistCursor(agentWs, agentId);
      return true;
    } catch (err) {
      console.error("[Episodic Memory] Error in segmenter processTurn:", err);
      // Fallback: absorb deduped messages only（Fix D-1 を catch でも維持）
      this.buffer.push(...dedupedMessages);
      this.addBufferTokens(dedupedMessages);
      for (const msg of dedupedMessages) { this.walAppend(agentWs, agentId, msg); }
      this.lastProcessedLength = currentMessages.length;
      this.maybePersistCursor(agentWs, agentId);
      // Reschedule idle flush on error recovery
      this.scheduleIdleFlush(agentWs, agentId);
    }
    return false;
  }


  /**
   * Mode branching: pool+queue (v0.4.0 narrative) vs legacy chunkAndIngest (v0.3.x).
   * Fire-and-forget — never awaited by processTurn.
   */
  private async handleSegmentBoundary(agentWs: string, agentId: string, surprise: number, reason: string, walFlushId: number = -1): Promise<void> {
    if (this.pool && this.narrativeWorker) {
      return this.poolAndQueue(agentWs, agentId, surprise, reason, walFlushId);
    }
    // Legacy path (v0.3.x) — no narrative architecture
    return this.chunkAndIngest(this.buffer, agentWs, reason, agentId, surprise);
  }

  /**
   * Normalize boundary reason for cache queue item reason union.
   * Keep observability fidelity for known reasons and degrade safely for unknown values.
   */
  private mapBoundaryReasonToCacheReason(
    reason: string
  ): "idle-timeout" | "surprise-boundary" | "size-limit" | "time-gap" {
    switch (reason) {
      case "idle-timeout":
      case "surprise-boundary":
      case "size-limit":
      case "time-gap":
        return reason;
      default:
        console.warn(`[Episodic Memory] Unknown boundary reason '${reason}', falling back to 'size-limit'.`);
        return "size-limit";
    }
  }

  /**
   * Finalize segmenter local state after a boundary flush succeeds.
   * Keeps cleanup logic consistent across poolAndQueue / forceFlush paths.
   */
  private finalizeAfterBoundary(savedCursor: number, agentWs: string, agentId: string): void {
    this.buffer = [];
    this.resetBufferTokens();
    this.lastProcessedLength = savedCursor;
    this.persistCursor(agentWs, agentId);
  }

  /**
   * Pool mode (v0.4.2): accumulate messages in NarrativePool, split into 64K chunks,
   * and enqueue to the Go cache DB for sequential narrativization.
   * Fire-and-forget — never awaited by processTurn.
   */
  private async poolAndQueue(agentWs: string, agentId: string, surprise: number, reason: string, walFlushId: number = -1): Promise<void> {
    if (!this.pool || !this.narrativeWorker) return;

    // [v0.4.24a] NarrativePool is passive (add() always returns null).
    // Boundary decisions are made by segmenter, so flush explicitly here.
    this.pool.add(this.buffer.slice(), surprise, agentWs, agentId);
    const item = this.pool.forceFlush(agentWs, agentId, surprise);
    // Clear segmenter buffer and idle flush timer; data is now in the pool.
    this.buffer = [];
    this.resetBufferTokens();
    this.lastProcessedLength = 0;
    this.clearIdleFlushTimer();

    if (item) {
      // Flush occurred: split and enqueue to cache DB
      // Preserve idle-timeout reason for observability — don't collapse it into size-limit
      const cacheReason = this.mapBoundaryReasonToCacheReason(reason);
      const chunks = splitIntoChunks(item.rawText, agentWs, agentId, "live-turn", cacheReason, surprise, item.messages);

      // [v0.4.13] Defer pool.clear() until after enqueue confirmation
      // (requires enqueueNarrativeChunks to re-throw errors — see Phase 0)
      // Buffer/lastProcessedLength are cleared immediately above — data is already
      // copied to pool via pool.add(this.buffer.slice(), ...), so no race with callers.
      enqueueNarrativeChunks(this.rpc, chunks, () => this.narrativeWorker?.wake())
        .then(() => {
          // Enqueue succeeded — safe to clear pool
          this.pool!.clear();
          // [v0.4.22b] WAL: delete staged file only after confirmed enqueue
          if (walFlushId >= 0) {
            this.walDeleteStaged(agentWs, agentId, walFlushId);
          }
          if (getEnvVal("DEBUG_EPISODIC_WAL")) {
            console.log(JSON.stringify({
              source: "episodic-claw", event: "wal-enqueue-result",
              agentId, flushId: walFlushId, success: true, enqueuedChunks: chunks.length,
            }));
          }
        })
        .catch(err => {
          console.error("[Episodic Memory] Cache enqueue failed:", err);
          // Pool retains data for retry on next flush/forceFlush
        });
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
   * [v0.4.21] Compaction 後の再物語化防止。
   * after_compaction handler から呼び出し、次回 processTurn で
   * compacted メッセージを全て「既処理」として扱うようフラグを設定する。
   *
   * forceFlush() は lastProcessedLength = 0 にリセットするが、
   * compaction 後の processTurn は 0 から全メッセージを再処理してしまう。
   * このメソッドは compaction 特有の「メッセージ短縮」を「既処理」として扱い、
   * 真のコンテキストリセット（セッション全消去）との区別を可能にする。
   */
  afterCompaction(agentWs: string = "", agentId: string = ""): void {
    this.pendingCompactionSkip = true;
    this.buffer = [];
    this.resetBufferTokens();
    this.turnSeq = 0;
    this.clearIdleFlushTimer();
    // [v0.4.22d] WAL: compaction後は会話が再構成済みのためWALも明示クリア
    if (agentWs && agentId) {
      this.walClearAll(agentWs, agentId);
    }
    console.log(JSON.stringify({ source: "episodic-claw", event: "after-compaction", pendingSkip: true, bufferCleared: true }));
  }

  /**
   * [v0.4.21] Warm-start 初回取り込みガード（再起動経路）。
   * cursor を明示的に現在のメッセージ長に同期し、
   * 再起動直後に巨大な既存メッセージ列を「新規」と誤認するのを防ぐ。
   *
   * @param currentMessagesLength 現在のメッセージリスト長
   * @param reason 呼び出し元の識別（ログ用）
   */
  bootstrapCursor(currentMessagesLength: number, reason: "warm-start" | "manual", agentWs: string = "", agentId: string = ""): void {
    const next = Math.max(0, currentMessagesLength);
    const changed = this.lastProcessedLength !== next;
    this.lastProcessedLength = next;
    this.buffer = [];
    this.resetBufferTokens();
    this.turnSeq = 0;
    this.clearIdleFlushTimer();
    console.log(JSON.stringify({ source: "episodic-claw", event: "bootstrap-cursor", cursor: this.lastProcessedLength, reason }));
    // [v0.4.21d] Only persist when value changed or user-explicit manual operation.
    // This avoids unnecessary DB writes (pebble.Sync) when restoreCursor returns the same
    // value that is already in memory — common on restart when cursor hasn't advanced.
    if (changed || reason === "manual") {
      this.persistCursor(agentWs, agentId);
    }
  }

  // ─── [v0.4.21b] Cursor persistence ──────────────────────────────────────

  /**
   * [v0.4.21c] Debounced cursor persistence for normal turns.
   * Writes every CURSOR_PERSIST_INTERVAL advances to reduce DB I/O.
   * In-memory cursor is always up-to-date; DB is a restart-recovery backup.
   * Max staleness: CURSOR_PERSIST_INTERVAL - 1 turns (acceptable on crash).
   */
  private maybePersistCursor(agentWs: string, agentId: string): void {
    if (!agentWs || !agentId) return;
    this.cursorPersistCounter++;
    if (this.cursorPersistCounter % this.CURSOR_PERSIST_INTERVAL !== 0) return;
    this.persistCursor(agentWs, agentId);
  }

  /**
   * Persist the current cursor position to the state DB so it survives restarts.
   * Fire-and-forget — errors are logged but not propagated.
   */
  private persistCursor(agentWs: string, agentId: string): void {
    if (!agentWs || !agentId) return; // skip if caller didn't provide identity
    this.rpc.setSegmenterCursor(agentWs, agentId, { lastProcessedLength: this.lastProcessedLength })
      .catch((err) => console.warn("[Episodic Memory] Failed to persist segmenter cursor:", err));
  }

  /**
   * [v0.4.21b] Restore cursor from the state DB (called on agent initialization).
   * Returns the restored lastProcessedLength, or 0 if no persisted cursor found.
   */
  async restoreCursor(agentWs: string, agentId: string): Promise<number> {
    const saved = await this.rpc.getSegmenterCursor(agentWs, agentId).catch(() => ({ lastProcessedLength: 0 }));
    // NOTE: Does NOT set this.lastProcessedLength internally — caller decides
    // via bootstrapCursor() which also clears buffer/timer and persists.
    return saved.lastProcessedLength;
  }

  /**
   * [v0.4.21b] Expose current cursor position for external guard checks.
   * Used by before_prompt_build to determine if warm-start fallback is needed.
   */
  get currentCursor(): number {
    return this.lastProcessedLength;
  }

  /**
   * Forcibly flushes the current buffer to the cache queue regardless of surprise score.
   * Useful before compact() to ensure no context is lost.
   */
  async forceFlush(agentWs: string, agentId: string = ""): Promise<void> {
    const hasBufferedMessages = this.buffer.length > 0;
    const hasPool = !!this.pool;

    // [v0.4.24a] Even when segmenter buffer is empty, pool may retain data
    // from a prior enqueue failure. Allow pool-only drain.
    if (!hasBufferedMessages && !hasPool) return;

    // [v0.4.22b] Save cursor before flush — restore after to prevent B-1 cursor regression
    const savedCursor = this.lastProcessedLength;
    try {
      console.log(`[Episodic Memory] Force flushing segmenter buffer (${this.buffer.length} messages)...`);
      this.clearIdleFlushTimer(); // Clear timer on force flush

      // [v0.4.22b] WAL: rotate active→staged only when segmenter buffer has data.
      const forceFlushId = hasBufferedMessages ? this.walRotateForFlush(agentWs, agentId) : -1;

      if (this.pool) {
        // Pool mode (v0.4.2): add buffer contents (if any), then flush pool.
        if (hasBufferedMessages) {
          this.pool.add(this.buffer.slice(), 0, agentWs, agentId);
        }
        const item = this.pool.forceFlush(agentWs, agentId);
        if (item) {
          const chunks = splitIntoChunks(item.rawText, agentWs, agentId, "live-turn", "force-flush", 0, item.messages);
          // [v0.4.13] Await enqueue first, then clear pool — consistent with poolAndQueue semantics
          await enqueueNarrativeChunks(this.rpc, chunks, () => this.narrativeWorker?.wake());
          // [v0.4.22b] WAL: delete staged after confirmed enqueue
          if (forceFlushId >= 0) {
            this.walDeleteStaged(agentWs, agentId, forceFlushId);
          }
        }
        // [AUDIT NOTE] this.pool.clear() runs AFTER await enqueueNarrativeChunks() (fixed in v0.4.13).
        // If enqueue throws, pool data is preserved — the outer try/catch skips this line.
        // Pre-v0.4.13 had pool.clear() before the await, which was a data-loss risk on enqueue failure.
        // [v0.4.13] Clear pool AFTER successful enqueue (data preserved on failure)
        this.pool.clear();
        // [v0.4.22b-fix] Restore savedCursor on success too — persisting 0 causes
        // full reprocessing on restart. savedCursor reflects the true processed position.
        this.finalizeAfterBoundary(savedCursor, agentWs, agentId);
        return;
      }

      // Legacy path (v0.3.x)
      await this.chunkAndIngest(this.buffer, agentWs, "force-flush", agentId);
      // [v0.4.22b] WAL: delete staged after confirmed enqueue (legacy path)
      if (forceFlushId >= 0) {
        this.walDeleteStaged(agentWs, agentId, forceFlushId);
      }
      this.finalizeAfterBoundary(savedCursor, agentWs, agentId);
    } catch (err) {
      console.error("[Episodic Memory] Error in segmenter forceFlush:", err);
      // [v0.4.22c] BUG-2: WAL flush write buffer on failure too — data in memory must reach disk
      this.walFlushWriteBuffer();
      // [v0.4.22b] On failure: restore cursor so B-1 restart doesn't reprocess everything
      this.lastProcessedLength = savedCursor;
      this.persistCursor(agentWs, agentId);
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
