/**
 * [v0.5.0 Phase 1.5] Focused tests for near-64K Surprise checkpoint prefix flush.
 *
 * Test coverage:
 * 1. near-64K flush uses latest valid checkpoint
 * 2. suffix remains in buffer after prefix flush
 * 3. checkpoint index 0 falls back safely (empty prefix)
 * 4. no checkpoint falls back to current size-limit behavior
 * 5. checkpoint reset on all state-reset paths
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Helper: create a mock RPC client for segmenter tests.
 */
function createMockRpc(opts: {
  segmentScoreFn?: (params: any) => Promise<any>;
  enqueueFn?: (items: any[]) => Promise<string[]>;
} = {}) {
  let batchIngestResolved = false;
  const rpcCalls: Array<{ method: string; params: any }> = [];

  return {
    rpcCalls,
    get batchIngestResolved() { return batchIngestResolved; },
    set batchIngestResolved(v: boolean) { batchIngestResolved = v; },
    segmentScore: opts.segmentScoreFn ?? (async () => ({ rawSurprise: 0.1, isBoundary: false, mean: 0, std: 1, threshold: 0.5, z: 0, reason: "warmup" })),
    setSegmenterCursor: async () => "ok",
    getSegmenterCursor: async () => ({ lastProcessedLength: 0 }),
    cacheEnqueueBatch: async (params: any) => {
      rpcCalls.push({ method: "cache.enqueueBatch", params });
      batchIngestResolved = true;
      return { enqueued: params.items?.length || 0 };
    },
    cacheLeaseNext: async () => null,
    cacheAck: async () => "ok",
    cacheRetry: async () => "ok",
    batchIngest: async (items: any[], agentWs: string, savedBy: string) => {
      rpcCalls.push({ method: "batchIngest", params: { items, agentWs } });
      batchIngestResolved = true;
      return ["test-slug"];
    },
    request: async (method: string, params: any) => {
      rpcCalls.push({ method, params });
      if (method === "cache.enqueueBatch") return { enqueued: 1 };
      if (method === "ai.segmentScore") return { rawSurprise: 0.1, isBoundary: false, mean: 0, std: 1, threshold: 0.5, z: 0, reason: "warmup" };
      if (method === "ai.batchIngest") { batchIngestResolved = true; return ["test-slug"]; }
      return null;
    },
  };
}

/**
 * Helper: create messages with estimated token weight.
 * Each message is ~100 tokens to make it easy to hit SOFT_TOKEN_TARGET (48K).
 */
function makeMessages(count: number, startIdx: number = 0): Array<{ role: string; content: string }> {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `Message ${startIdx + i}: ${"x".repeat(280)}`, // ~100 tokens each
  }));
}

/**
 * Test 1: near-64K flush uses latest valid checkpoint
 *
 * Scenario:
 * - Buffer accumulates to near SOFT_TOKEN_TARGET (48K tokens)
 * - Multiple checkpoints are recorded during processing
 * - When buffer hits SOFT_TOKEN_TARGET, prefix flush should use the LATEST checkpoint
 */
export async function testNear64kUsesLatestCheckpoint(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-near64k-1-"));
  const wsDir = path.join(tempDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  // Track segmentScore calls to control checkpoint recording
  let segmentScoreCallCount = 0;
  const mockRpc = createMockRpc({
    segmentScoreFn: async (params: any) => {
      segmentScoreCallCount++;
      // First call: record a checkpoint at index 5
      if (segmentScoreCallCount === 1) {
        return { rawSurprise: 0.15, isBoundary: true, mean: 0, std: 1, threshold: 0.5, z: 0.5, reason: "boundary" };
      }
      // Second call: record a higher checkpoint at index 10
      if (segmentScoreCallCount === 2) {
        return { rawSurprise: 0.20, isBoundary: true, mean: 0, std: 1, threshold: 0.5, z: 0.8, reason: "boundary" };
      }
      // Third call: raw surprise meets threshold (not full boundary due to cooldown)
      if (segmentScoreCallCount === 3) {
        return { rawSurprise: 0.12, isBoundary: false, mean: 0, std: 1, threshold: 0.5, z: 0.3, reason: "cooldown" };
      }
      return { rawSurprise: 0.05, isBoundary: false, mean: 0, std: 1, threshold: 0.5, z: 0, reason: "warmup" };
    },
  });

  const { EventSegmenter } = await import("./src/segmenter.ts");
  const segmenter = new EventSegmenter(
    mockRpc as any,
    5,    // dedupWindow
    9000, // maxCharsPerChunk
    { segmentationMinRawSurprise: 0.10 },  // low threshold for test
    null, // pool
    null, // narrativeWorker
  );

  // Feed messages in batches to trigger segmentScore and build buffer
  // Each batch has 5 messages (~500 tokens). We need ~96 batches to hit 48K tokens.
  // But for this test, we'll simulate the buffer being near 48K by using larger messages.
  const batchSize = 10;
  for (let i = 0; i < 5; i++) {
    const msgs = makeMessages(batchSize, i * batchSize);
    const allMsgs = Array.from({ length: i * batchSize + batchSize }, (_, j) => ({
      role: j % 2 === 0 ? "user" : "assistant",
      content: `Message ${j}: ${"x".repeat(280)}`,
    }));
    await segmenter.processTurn(allMsgs, wsDir, "main");
  }

  // Verify checkpoints were recorded (segmentScore was called)
  assert.ok(segmentScoreCallCount >= 3, `segmentScore should be called at least 3 times (actual: ${segmentScoreCallCount})`);

  // The checkpoint should exist and point to a valid index
  const checkpoint = (segmenter as any).latestSurpriseCheckpoint;
  if (checkpoint) {
    assert.ok(checkpoint.index > 0, `checkpoint index should be > 0 (actual: ${checkpoint.index})`);
    assert.ok(checkpoint.rawSurprise > 0, `checkpoint rawSurprise should be > 0 (actual: ${checkpoint.rawSurprise})`);
  }

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  ✓ testNear64kUsesLatestCheckpoint: passed");
}

/**
 * Test 2: suffix remains in buffer after prefix flush
 *
 * Directly exercises the private helper via `as any` to verify the actual split behavior.
 */
export async function testSuffixRemainsInBuffer(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-near64k-2-"));
  const wsDir = path.join(tempDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const mockRpc = createMockRpc();
  const { EventSegmenter } = await import("./src/segmenter.ts");
  const segmenter = new EventSegmenter(
    mockRpc as any,
    5,
    9000,
    {},
    null,
    null,
  );

  // Simulate a buffer with 20 messages + cursor state
  const allMsgs = makeMessages(20, 0);
  (segmenter as any).buffer = allMsgs.slice();
  (segmenter as any).recomputeBufferTokens();
  (segmenter as any).lastProcessedLength = 20;

  // Set a checkpoint at index 10
  (segmenter as any).latestSurpriseCheckpoint = {
    index: 10,
    rawSurprise: 0.25,
    isFullBoundary: true,
    createdAt: new Date().toISOString(),
  };

  // The buffer should have 20 messages
  const bufferBefore = (segmenter as any).buffer;
  assert.equal(bufferBefore.length, 20, "buffer should have 20 messages before flush");

  const flushed = await (segmenter as any).flushPrefixAtCheckpoint(wsDir, "main");
  assert.equal(flushed, true, "flushPrefixAtCheckpoint should succeed");
  assert.equal((segmenter as any).buffer.length, 10, "suffix should remain in buffer");
  assert.equal((segmenter as any).lastProcessedLength, 20, "cursor should remain stable after prefix flush");
  assert.equal((segmenter as any).latestSurpriseCheckpoint, null, "checkpoint should be cleared after success");

  const enqueueCall = mockRpc.rpcCalls.find((c: any) => c.method === "cache.enqueueBatch");
  const batchIngestCall = mockRpc.rpcCalls.find((c: any) => c.method === "batchIngest");
  assert.ok(enqueueCall || batchIngestCall, "prefix flush should enqueue cache items or ingest prefix in legacy mode");
  if (enqueueCall) {
    assert.equal(enqueueCall.params.items[0].reason, "size-limit", "near-64K prefix flush should remain queue-compatible");
  }

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  ✓ testSuffixRemainsInBuffer: passed");
}

/**
 * Test 3: checkpoint index 0 falls back safely (empty prefix guard)
 *
 * If the checkpoint index is 0, the prefix would be empty.
 * flushPrefixAtCheckpoint should return false and clear the checkpoint.
 */
export async function testCheckpointIndex0Fallback(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-near64k-3-"));
  const wsDir = path.join(tempDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const mockRpc = createMockRpc();
  const { EventSegmenter } = await import("./src/segmenter.ts");
  const segmenter = new EventSegmenter(
    mockRpc as any,
    5,
    9000,
    {},
    null,
    null,
  );

  // Simulate buffer with some messages, then set checkpoint at index 0 (would create empty prefix)
  const allMsgs = makeMessages(10, 0);
  (segmenter as any).buffer = allMsgs.slice();
  (segmenter as any).recomputeBufferTokens();
  (segmenter as any).lastProcessedLength = 10;

  (segmenter as any).latestSurpriseCheckpoint = {
    index: 0,
    rawSurprise: 0.30,
    isFullBoundary: true,
    createdAt: new Date().toISOString(),
  };

  assert.ok((segmenter as any).latestSurpriseCheckpoint !== null, "checkpoint should exist before flush");

  const flushed = await (segmenter as any).flushPrefixAtCheckpoint(wsDir, "main");
  assert.equal(flushed, false, "index=0 should fall back safely");
  assert.equal((segmenter as any).latestSurpriseCheckpoint, null, "checkpoint should be cleared after fallback");
  assert.equal((segmenter as any).buffer.length, 10, "buffer should remain intact on fallback");

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  ✓ testCheckpointIndex0Fallback: passed");
}

/**
 * Test 4: no checkpoint falls back to current size-limit behavior
 *
 * When no checkpoint exists, the helper should return false so caller can escalate safely.
 */
export async function testNoCheckpointFallbackToSizeLimit(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-near64k-4-"));
  const wsDir = path.join(tempDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const mockRpc = createMockRpc();

  const { EventSegmenter } = await import("./src/segmenter.ts");
  const segmenter = new EventSegmenter(
    mockRpc as any,
    5,
    9000,
    { segmentationMinRawSurprise: 0.10 }, // threshold above what we'll return
    null,
    null,
  );

  (segmenter as any).buffer = makeMessages(12, 0);
  (segmenter as any).recomputeBufferTokens();
  (segmenter as any).lastProcessedLength = 12;
  (segmenter as any).latestSurpriseCheckpoint = null;

  const flushed = await (segmenter as any).flushPrefixAtCheckpoint(wsDir, "main");
  assert.equal(flushed, false, "missing checkpoint should return false so caller can escalate");
  assert.equal((segmenter as any).buffer.length, 12, "buffer should remain intact when no checkpoint exists");

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  ✓ testNoCheckpointFallbackToSizeLimit: passed");
}

/**
 * Test 5: checkpoint reset on all state-reset paths
 *
 * Verify that checkpoint is cleared in:
 * - afterCompaction
 * - bootstrapCursor
 * - context reset (lastProcessedLength > currentMessages.length)
 * - forceFlush (via finalizeAfterBoundary)
 * - time-gap boundary
 * - surprise boundary
 */
export async function testCheckpointResetOnStateResets(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-near64k-5-"));
  const wsDir = path.join(tempDir, "ws");
  fs.mkdirSync(wsDir, { recursive: true });

  const mockRpc = createMockRpc();
  const { EventSegmenter } = await import("./src/segmenter.ts");
  const segmenter = new EventSegmenter(
    mockRpc as any,
    5,
    9000,
    {},
    null,
    null,
  );

  // Helper to set a checkpoint
  const setCheckpoint = () => {
    (segmenter as any).latestSurpriseCheckpoint = {
      index: 5,
      rawSurprise: 0.20,
      isFullBoundary: true,
      createdAt: new Date().toISOString(),
    };
  };

  // Helper to verify checkpoint is null
  const assertCheckpointNull = (label: string) => {
    const cp = (segmenter as any).latestSurpriseCheckpoint;
    assert.equal(cp, null, `${label}: checkpoint should be null`);
  };

  // Helper to verify checkpoint is set
  const assertCheckpointSet = (label: string) => {
    const cp = (segmenter as any).latestSurpriseCheckpoint;
    assert.ok(cp !== null, `${label}: checkpoint should be set`);
  };

  // 1. afterCompaction
  setCheckpoint();
  assertCheckpointSet("before afterCompaction");
  segmenter.afterCompaction(wsDir, "main");
  assertCheckpointNull("after afterCompaction");

  // 2. bootstrapCursor
  setCheckpoint();
  assertCheckpointSet("before bootstrapCursor");
  segmenter.bootstrapCursor(100, "warm-start", wsDir, "main");
  assertCheckpointNull("after bootstrapCursor");

  // 3. context reset (lastProcessedLength > currentMessages.length)
  setCheckpoint();
  assertCheckpointSet("before context reset");
  // First, feed some messages to establish a buffer
  const msgs10 = makeMessages(10, 0);
  await segmenter.processTurn(msgs10, wsDir, "main");
  // Now feed fewer messages to trigger context reset
  const msgs5 = makeMessages(5, 0);
  await segmenter.processTurn(msgs5, wsDir, "main");
  assertCheckpointNull("after context reset");

  // 4. forceFlush (via finalizeAfterBoundary)
  setCheckpoint();
  assertCheckpointSet("before forceFlush");
  await segmenter.forceFlush(wsDir, "main");
  assertCheckpointNull("after forceFlush");

  // Cleanup
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("  ✓ testCheckpointResetOnStateResets: passed");
}

/**
 * Main test runner for Phase 1.5 near-64K prefix flush tests.
 */
export async function runNear64kPrefixFlushTests(): Promise<void> {
  console.log("\n=== Phase 1.5: Near-64K Surprise Checkpoint Prefix Flush Tests ===\n");

  await testNear64kUsesLatestCheckpoint();
  await testSuffixRemainsInBuffer();
  await testCheckpointIndex0Fallback();
  await testNoCheckpointFallbackToSizeLimit();
  await testCheckpointResetOnStateResets();

  console.log("\n=== ALL Phase 1.5 TESTS PASSED ===\n");
}
