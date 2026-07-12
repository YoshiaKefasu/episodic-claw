/**
 * Narrative chunk enqueue helper.
 * Splits large text into ~64K token chunks and enqueues them to the Go cache DB.
 * Used by: live ingest (poolAndQueue), cold-start, gap-archive.
 */

import { EpisodicCoreClient } from "./rpc-client";
import { estimateTokens } from "./utils";
import type { Message } from "./segmenter";
import { extractText } from "./segmenter";
import type { BoundaryMetadata } from "./types";
import { formatTranscriptMessageLines } from "./narrative-transcript";

// [v0.5.0 Phase 1.5] Exported for near-64K trigger in segmenter.ts
export const SOFT_TOKEN_TARGET = 48_000;
// [v0.4.22b] Exported for 64K boundary unification in segmenter.ts
export const HARD_TOKEN_CAP = 64_000;

export interface CacheQueueItem {
  id: string;
  agentWs: string;
  agentId: string;
  source: "live-turn" | "cold-start" | "gap-archive";
  parentIngestId: string;
  orderKey: string;
  surprise: number;
  reason: "size-limit" | "surprise-boundary" | "cold-start-import" | "gap-archive" | "force-flush" | "idle-timeout" | "time-gap";
  rawText: string;
  estimatedTokens: number;
  status: "queued" | "leased" | "dead-letter";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseUntil?: string;
  lastError?: string;
  // [v0.5.0 Phase 2] Boundary metadata — optional, omitempty for backward compat
  boundaryNote?: string;
  boundaryBy?: string;
  boundaryReason?: string;
  boundaryTitleHint?: string;
  boundaryCreatedAt?: string;
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
 *
 * [v0.5.0 addendum] Recognizes both legacy and timestamped role lines:
 *   - `user: text`
 *   - `[19:30] user: text`
 */
export function detectRoleLine(line: string): "user" | "assistant" | null {
  // Timestamped: [HH:mm] role: ...
  const tsMatch = line.match(/^\[\d{2}:\d{2}\]\s+(user|assistant):\s/);
  if (tsMatch) return tsMatch[1] as "user" | "assistant";
  // Legacy: role: ...
  if (line.startsWith("user: ")) return "user";
  if (line.startsWith("assistant: ")) return "assistant";
  return null;
}

/**
 * Split raw text into chunks that fit within the 64K token limit.
 * Tries to split at role boundaries or natural break points.
 * [v0.4.19b] Option A: When messages[] is provided, uses structured role data
 * for accurate boundary detection. Falls back to detectRoleLine() when not available.
 * [v0.5.0 Phase 2] boundaryMeta: optional boundary metadata propagated to each chunk.
 */
export function splitIntoChunks(
  rawText: string,
  agentWs: string,
  agentId: string,
  source: CacheQueueItem["source"],
  reason: CacheQueueItem["reason"],
  surprise: number,
  messages?: Message[],  // [v0.4.19b] Option A: structured conversation-boundary-aware chunking
  boundaryMeta?: BoundaryMetadata, // [v0.5.0 Phase 2] boundary metadata from ep-boundary tool
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
        // [v0.5.0 Phase 2] Propagate boundary metadata
        ...(boundaryMeta ? {
          boundaryNote: boundaryMeta.boundaryNote,
          boundaryBy: boundaryMeta.boundaryBy,
          boundaryReason: boundaryMeta.boundaryReason,
          boundaryTitleHint: boundaryMeta.boundaryTitleHint,
          boundaryCreatedAt: boundaryMeta.boundaryCreatedAt,
        } : {}),
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
  // [v0.5.0 addendum] Use formatTranscriptMessageLines() to get exact formatted lines,
  // ensuring the lineToRole map matches the actual rawText produced by the formatter.
  const lineToRole = new Map<string, "user" | "assistant" | null>();
  if (messages && messages.length > 0) {
    for (const m of messages) {
      const text = extractText(m.content);
      if (!text) continue;
      const role = m.role === "user" || m.role === "assistant" ? m.role : null;
      const formattedLines = formatTranscriptMessageLines(
        { role: m.role, text, timestamp: m.timestamp },
      );
      // Map each formatted line to the message's real role
      for (const fLine of formattedLines) {
        if (!lineToRole.has(fLine)) {  // first-occurrence wins on collision
          lineToRole.set(fLine, role);
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
      // [v0.5.0 Phase 2] Propagate boundary metadata to each chunk
      ...(boundaryMeta ? {
        boundaryNote: boundaryMeta.boundaryNote,
        boundaryBy: boundaryMeta.boundaryBy,
        boundaryReason: boundaryMeta.boundaryReason,
        boundaryTitleHint: boundaryMeta.boundaryTitleHint,
        boundaryCreatedAt: boundaryMeta.boundaryCreatedAt,
      } : {}),
    });
  };

  let chunkIndex = 0;
  // [v0.5.0 addendum] Track active date header for carry-forward across splits
  let activeDateHeader: string | null = null;

  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    // [v0.4.19b] Determine role for this line — structured path first, string fallback
    const lineRole = lineToRole.get(line) ?? detectRoleLine(line);

    // [v0.5.0 addendum] Detect date header lines: (YYYY-MM-DD Weekday)
    const isDateHeader = /^\(\d{4}-\d{2}-\d{2}\s+\w+\)$/.test(line);
    if (isDateHeader) {
      activeDateHeader = line;
    }

    // [v0.5.0 addendum] Hard cap: force split even mid-line if needed.
    // Checked BEFORE soft-cap so oversized timestamped lines are handled without
    // creating standalone header-only chunks. Every hard-cap segment in timestamped
    // context receives the active date header.
    if (lineTokens > HARD_TOKEN_CAP) {
      // Push any accumulated lines first
      if (currentLines.length > 0) {
        pushChunk(currentLines, chunkIndex);
        chunkIndex++;
        currentLines = [];
        currentTokens = 0;
        lastRoleInChunk = null;
      }
      // Prepend active date header to the first hard-cap segment if timestamped context.
      // This handles the case where the oversized line is the first line in a new chunk
      // (after the accumulated push) and the soft-split header-prepend path never ran.
      const useHeader = (activeDateHeader && !isDateHeader &&
        (lineRole || /^\[\d{2}:\d{2}\]\s/.test(line)))
        ? activeDateHeader : null;
      // Reduce segment size to account for header token cost so resulting chunks
      // do not exceed HARD_TOKEN_CAP due to the injected header.
      const headerTokens = useHeader ? estimateTokens(useHeader) : 0;
      const effectiveCap = HARD_TOKEN_CAP - headerTokens;
      const maxChars = Math.floor((effectiveCap * 3) * 0.9); // rough: 1 token ≈ 3 chars
      // Split the long line — EVERY segment gets the header (timestamped context)
      let remaining = line;
      while (remaining.length > 0) {
        const segment = remaining.slice(0, maxChars);
        remaining = remaining.slice(maxChars);
        const segLines = useHeader ? [useHeader, segment] : [segment];
        pushChunk(segLines, chunkIndex);
        chunkIndex++;
      }
      continue;
    }

    // If adding this line exceeds soft target, push current chunk
    if (currentTokens + lineTokens > SOFT_TOKEN_TARGET && currentLines.length > 0) {
      if (!lineRole && !isDateHeader) {
        console.log(
          `[Episodic Cache] Chunk split at non-conversation boundary ` +
          `(chunkIndex=${chunkIndex}, lastRole=${lastRoleInChunk}). ` +
          `Consider reducing HARD_TOKEN_CAP or segmentationWarmupCount for smaller chunks.`
        );
      }
      pushChunk(currentLines, chunkIndex);
      chunkIndex++;
      currentLines = [];
      currentTokens = 0;
      lastRoleInChunk = null;
      // [v0.5.0 addendum] After a soft split, prepend active date header to the new chunk
      // if we are in a timestamped context (activeDateHeader is set) and the current line
      // is not itself a date header. This covers:
      // - Timestamped line ([HH:mm] role: …) → header placed before it
      // - Continuation line of a multi-line timestamped message → date context preserved
      // - Any other content in a timestamped context → date context preserved
      // Does NOT fire for date header lines (they carry their own date).
      if (activeDateHeader && !isDateHeader) {
        currentLines.push(activeDateHeader);
        currentTokens += estimateTokens(activeDateHeader);
      }
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
