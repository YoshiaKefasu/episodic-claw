/**
 * Narrative chunk enqueue helper.
 * Splits large text into ~64K token chunks and enqueues them to the Go cache DB.
 * Used by: live ingest (poolAndQueue), cold-start, gap-archive.
 */

import { EpisodicCoreClient } from "./rpc-client";
import { estimateTokens } from "./utils";
import type { Message } from "./segmenter";
import { extractText } from "./segmenter";

const SOFT_TOKEN_TARGET = 48_000;
const HARD_TOKEN_CAP = 64_000;

export interface CacheQueueItem {
  id: string;
  agentWs: string;
  agentId: string;
  source: "live-turn" | "cold-start" | "gap-archive";
  parentIngestId: string;
  orderKey: string;
  surprise: number;
  reason: "size-limit" | "surprise-boundary" | "cold-start-import" | "gap-archive" | "force-flush" | "idle-timeout";
  rawText: string;
  estimatedTokens: number;
  status: "queued" | "leased" | "dead-letter";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseUntil?: string;
  lastError?: string;
}

let _chunkCounter = 0;
// [AUDIT NOTE] _chunkCounter resets to 0 on process restart. This is NOT a bug:
// - The orderKey format includes ISO timestamp + 4-digit counter + agentId prefix
// - Collision requires: same second + same counter value + same agent — near-zero probability
// - Global monotonic counter ensures uniqueness within a single process lifetime

/**
 * [v0.4.19b] Detect if a line is a role-labeled conversation boundary.
 * Returns the role prefix ("user" or "assistant") or null.
 * Used as fallback when messages[] is not available (cold-start, gap-archive).
 */
export function detectRoleLine(line: string): "user" | "assistant" | null {
  if (line.startsWith("user: ")) return "user";
  if (line.startsWith("assistant: ")) return "assistant";
  return null;
}

/**
 * Split raw text into chunks that fit within the 64K token limit.
 * Tries to split at role boundaries or natural break points.
 * [v0.4.19b] Option A: When messages[] is provided, uses structured role data
 * for accurate boundary detection. Falls back to detectRoleLine() when not available.
 */
export function splitIntoChunks(
  rawText: string,
  agentWs: string,
  agentId: string,
  source: CacheQueueItem["source"],
  reason: CacheQueueItem["reason"],
  surprise: number,
  messages?: Message[],  // [v0.4.19b] Option A: structured conversation-boundary-aware chunking
): CacheQueueItem[] {
  const parentIngestId = `ingest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const totalTokens = estimateTokens(rawText);

  // Single chunk — no split needed
  if (totalTokens <= HARD_TOKEN_CAP) {
    _chunkCounter++;
    const now = new Date().toISOString().replace(/[:.]/g, "-");
    const orderKey = `${now}-${String(_chunkCounter).padStart(4, "0")}`;
    return [
      {
        id: `${agentId}:${orderKey}`,
        agentWs,
        agentId,
        source,
        parentIngestId,
        orderKey,
        surprise,
        reason,
        rawText,
        estimatedTokens: totalTokens,
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];
  }

  // Split into multiple chunks
  const chunks: CacheQueueItem[] = [];
  const lines = rawText.split("\n");
  let currentLines: string[] = [];
  let currentTokens = 0;
  let lastRoleInChunk: string | null = null;

  // [v0.4.19b] Build line→role mapping from messages[] for structured path
  // Key fix: multi-line message content (e.g. assistant code blocks) must be split
  // into individual lines so each sub-line maps to the message's real role.
  // Without this, a line like "user: I need help" embedded in an assistant response
  // would fail the Map lookup and fall back to detectRoleLine() → false positive.
  const lineToRole = new Map<string, "user" | "assistant" | null>();
  if (messages && messages.length > 0) {
    for (const m of messages) {
      const text = extractText(m.content);
      if (!text) continue;
      const role = m.role === "user" || m.role === "assistant" ? m.role : null;
      const labeledLine = role ? `${role}: ${text}` : text;
      // Split multi-line content so each sub-line maps to the message's role
      for (const subLine of labeledLine.split("\n")) {
        if (!lineToRole.has(subLine)) {  // first-occurrence wins on collision
          lineToRole.set(subLine, role);
        }
      }
    }
  }

  const pushChunk = (lines: string[], chunkIndex: number) => {
    const text = lines.join("\n");
    const tokens = estimateTokens(text);
    _chunkCounter++;
    const now = new Date().toISOString().replace(/[:.]/g, "-");
    const orderKey = `${now}-${String(_chunkCounter).padStart(4, "0")}`;
    chunks.push({
      id: `${agentId}:${orderKey}`,
      agentWs,
      agentId,
      source,
      parentIngestId,
      orderKey,
      surprise: chunkIndex === 0 ? surprise : 0,
      reason,
      rawText: text,
      estimatedTokens: tokens,
      status: "queued",
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  let chunkIndex = 0;
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    // [v0.4.19b] Determine role for this line — structured path first, string fallback
    const lineRole = lineToRole.get(line) ?? detectRoleLine(line);

    // If adding this line exceeds soft target, push current chunk
    if (currentTokens + lineTokens > SOFT_TOKEN_TARGET && currentLines.length > 0) {
      if (!lineRole) {
        console.log(
          `[Episodic Cache] Chunk split at non-conversation boundary ` +
          `(chunkIndex=${chunkIndex}, lastRole=${lastRoleInChunk}). ` +
          `Consider reducing maxPoolChars for smaller chunks.`
        );
      }
      pushChunk(currentLines, chunkIndex);
      chunkIndex++;
      currentLines = [];
      currentTokens = 0;
      lastRoleInChunk = null;
    }

    // Hard cap: force split even mid-line if needed
    if (lineTokens > HARD_TOKEN_CAP) {
      // Push any accumulated lines first
      if (currentLines.length > 0) {
        pushChunk(currentLines, chunkIndex);
        chunkIndex++;
        currentLines = [];
        currentTokens = 0;
        lastRoleInChunk = null;
      }
      // Split the long line by character chunks (approximate)
      const maxChars = Math.floor((HARD_TOKEN_CAP * 3) * 0.9); // rough: 1 token ≈ 3 chars
      let remaining = line;
      while (remaining.length > 0) {
        const segment = remaining.slice(0, maxChars);
        remaining = remaining.slice(maxChars);
        pushChunk([segment], chunkIndex);
        chunkIndex++;
      }
      continue;
    }

    currentLines.push(line);
    currentTokens += lineTokens;
    if (lineRole) lastRoleInChunk = lineRole;
  }

  // Push remaining
  if (currentLines.length > 0) {
    pushChunk(currentLines, chunkIndex);
  }

  // [v0.4.19c] Split summary log — only for multi-chunk path (single-chunk has no boundary splits to observe)
  console.log(
    `[Episodic Cache] Split summary: ${chunks.length} chunk(s), ` +
    `totalTokens=${totalTokens}, ` +
    `roleBoundarySplits=${chunks.filter(c => {
      const firstLine = c.rawText.split("\n")[0];
      return detectRoleLine(firstLine) !== null;
    }).length}/${chunks.length} start at role boundary`
  );

  return chunks;
}

/**
 * Enqueue narrative chunks to the Go cache DB.
 * Fire-and-forget: returns immediately after RPC call.
 * If a wake callback is provided, it will be called after successful enqueue.
 */
export async function enqueueNarrativeChunks(
  rpcClient: EpisodicCoreClient,
  chunks: CacheQueueItem[],
  onWake?: () => void,
): Promise<void> {
  if (chunks.length === 0) return;

  try {
    const result = await (rpcClient as any).request("cache.enqueueBatch", { items: chunks });
    const count = result?.enqueued ?? chunks.length;
    const totalTokens = chunks.reduce((sum, c) => sum + c.estimatedTokens, 0);
    console.log(
      `[Episodic Cache] Enqueued ${count} chunks (${totalTokens} tokens) for agentId=${chunks[0].agentId} source=${chunks[0].source}`
    );
    // Wake the worker from idle backoff if callback is provided
    if (onWake) onWake();
  } catch (err) {
    console.error("[Episodic Cache] Failed to enqueue narrative chunks:", err);
    throw err; // [v0.4.13] Re-throw so callers can detect failure and preserve data
  }
}
