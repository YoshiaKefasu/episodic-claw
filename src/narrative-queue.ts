/**
 * Narrative chunk enqueue helper.
 * Splits large text into ~64K token chunks and enqueues them to the Go cache DB.
 * Used by: live ingest (poolAndQueue), cold-start, gap-archive.
 */

import { EpisodicCoreClient } from "./rpc-client";
import { estimateTokens } from "./utils";

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
 * Split raw text into chunks that fit within the 64K token limit.
 * Tries to split at role boundaries or natural break points.
 */
export function splitIntoChunks(
  rawText: string,
  agentWs: string,
  agentId: string,
  source: CacheQueueItem["source"],
  reason: CacheQueueItem["reason"],
  surprise: number,
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

    // If adding this line exceeds soft target, push current chunk
    if (currentTokens + lineTokens > SOFT_TOKEN_TARGET && currentLines.length > 0) {
      pushChunk(currentLines, chunkIndex);
      chunkIndex++;
      currentLines = [];
      currentTokens = 0;
    }

    // Hard cap: force split even mid-line if needed
    if (lineTokens > HARD_TOKEN_CAP) {
      // Push any accumulated lines first
      if (currentLines.length > 0) {
        pushChunk(currentLines, chunkIndex);
        chunkIndex++;
        currentLines = [];
        currentTokens = 0;
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
  }

  // Push remaining
  if (currentLines.length > 0) {
    pushChunk(currentLines, chunkIndex);
  }

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
