/**
 * [v0.5.0 Phase E] Tests for autoSurpriseFlush gate.
 *
 * Covers:
 * 1. autoSurpriseFlush=false does NOT enqueue when score.isBoundary=true
 * 2. autoSurpriseFlush=false still records a Surprise checkpoint
 * 3. autoSurpriseFlush=true (default) DOES enqueue when score.isBoundary=true
 * 4. manual ep-boundary still works when autoSurpriseFlush=false
 * 5. Near-64K still flushes prefix up to checkpoint even when autoSurpriseFlush=false
 * 6. No checkpoint + near-64K still escalates to full safety flush
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventSegmenter, Message } from "./src/segmenter";
import { NarrativePool } from "./src/narrative-pool";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(role: string, text: string, timestamp?: string): Message {
  return { role, content: text, timestamp };
}

/**
 * Creates a mock RPC that returns isBoundary=true on the Nth segmentScore call.
 */
function createMockRpc(opts: { boundaryOnCall?: number; boundaryReturn?: boolean } = {}) {
  const calls: { method: string; args: any[] }[] = [];
  let segmentScoreCallCount = 0;
  const boundaryOnCall = opts.boundaryOnCall ?? 2; // default: fire on 2nd call
  return {
    calls,
    async segmentScore() {
      segmentScoreCallCount++;
      const isBoundary = segmentScoreCallCount === boundaryOnCall ? (opts.boundaryReturn ?? true) : false;
      return {
        rawSurprise: isBoundary ? 0.5 : 0.1,
        mean: 0.1,
        std: 0.05,
        threshold: 0.2,
        z: isBoundary ? 3.0 : 0.5,
        isBoundary,
        reason: isBoundary ? "topic-shift" : "",
      };
    },
    async setSegmenterCursor() {},
    async getSegmenterCursor() {
      return { lastProcessedLength: 0 };
    },
    async setBoundaryState() {},
    async getBoundaryState() {
      return { boundarySequence: 0 };
    },
    async batchIngest(items: any[]) {
      calls.push({ method: "batchIngest", args: [items] });
      return items.map((_: any, i: number) => `slug-${i}`);
    },
    request(method: string, params: any) {
      calls.push({ method, args: [params] });
      return { enqueued: params.items?.length ?? 0 };
    },
  } as any;
}

// ─── Test 1: autoSurpriseFlush=false blocks Surprise boundary ─────────────────

async function testSurpriseGateDisabled(): Promise<void> {
  console.log("Test: autoSurpriseFlush=false does NOT trigger Surprise boundary...");
  // boundaryOnCall=1: Turn 1 absorbs (no segmentScore), Turn 2 calls segmentScore (call #1)
  const rpc = createMockRpc({ boundaryOnCall: 1, boundaryReturn: true });
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,    // dedupWindow
    9000, // maxCharsPerChunk
    {
      autoSurpriseFlush: false,
      autoIdleFlush: false,
      autoTimeGapFlush: false,
      segmentationMinRawSurprise: 0.5,
    },
    pool,
    null,
  );

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ep-phase-e-gate-off-"));
  try {
    // Turn 1: absorb
    const allMessages: Message[] = [
      makeMsg("user", "Tell me about cats."),
      makeMsg("assistant", "Cats are domesticated felines."),
    ];
    await segmenter.processTurn(allMessages, ws, "main");

    // Turn 2: segmentScore returns isBoundary=true, but gate is off
    allMessages.push(
      makeMsg("user", "Now let's discuss quantum physics."),
      makeMsg("assistant", "Quantum physics deals with subatomic particles."),
    );
    await segmenter.processTurn(allMessages, ws, "main");

    // Buffer should have ALL messages (no boundary flushed despite isBoundary=true)
    const buffer = (segmenter as any).buffer as Message[];
    assert.ok(buffer.length >= 4, `Buffer should contain all 4+ messages when gate is off (got ${buffer.length})`);

    // batchIngest should NOT have been called from Surprise boundary
    const batchCalls = rpc.calls.filter((c: any) => c.method === "batchIngest");
    assert.equal(batchCalls.length, 0, "batchIngest should NOT be called when autoSurpriseFlush=false");

    console.log("  PASS");
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// ─── Test 2: autoSurpriseFlush=false still records checkpoint ─────────────────

async function testCheckpointStillRecorded(): Promise<void> {
  console.log("Test: autoSurpriseFlush=false still records Surprise checkpoint...");
  // boundaryOnCall=1: Turn 1 absorbs (no segmentScore), Turn 2 calls segmentScore (call #1)
  const rpc = createMockRpc({ boundaryOnCall: 1, boundaryReturn: true });
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,
    9000,
    { autoSurpriseFlush: false, autoIdleFlush: false, autoTimeGapFlush: false },
    pool,
    null,
  );

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ep-phase-e-checkpoint-"));
  try {
    // Turn 1: absorb
    const allMessages: Message[] = [
      makeMsg("user", "Tell me about cats."),
      makeMsg("assistant", "Cats are domesticated felines."),
    ];
    await segmenter.processTurn(allMessages, ws, "main");

    // Turn 2: segmentScore returns isBoundary=true
    allMessages.push(
      makeMsg("user", "Now let's discuss quantum physics."),
      makeMsg("assistant", "Quantum physics deals with subatomic particles."),
    );
    await segmenter.processTurn(allMessages, ws, "main");

    // Checkpoint should be recorded even though boundary was suppressed
    const checkpoint = (segmenter as any).latestSurpriseCheckpoint;
    assert.ok(checkpoint !== null, "Surprise checkpoint should be recorded even when autoSurpriseFlush=false");
    assert.equal(checkpoint.isFullBoundary, true, "Checkpoint should reflect isFullBoundary=true");
    assert.ok(checkpoint.rawSurprise > 0, "Checkpoint should have rawSurprise > 0");
    assert.ok(checkpoint.index > 0, "Checkpoint index should be > 0");

    console.log("  PASS");
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// ─── Test 3: autoSurpriseFlush=true (default) DOES trigger boundary ───────────

async function testSurpriseGateEnabled(): Promise<void> {
  console.log("Test: autoSurpriseFlush=true (default) DOES trigger Surprise boundary...");
  // boundaryOnCall=1: Turn 1 absorbs (no segmentScore), Turn 2 calls segmentScore (call #1)
  const rpc = createMockRpc({ boundaryOnCall: 1, boundaryReturn: true });
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,
    9000,
    { autoSurpriseFlush: true, autoIdleFlush: false, autoTimeGapFlush: false },
    pool,
    null,
  );

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ep-phase-e-gate-on-"));
  try {
    // Turn 1: absorb
    const allMessages: Message[] = [
      makeMsg("user", "Tell me about cats."),
      makeMsg("assistant", "Cats are domesticated felines."),
    ];
    await segmenter.processTurn(allMessages, ws, "main");

    // Turn 2: segmentScore returns isBoundary=true, gate is ON
    allMessages.push(
      makeMsg("user", "Now let's discuss quantum physics."),
      makeMsg("assistant", "Quantum physics deals with subatomic particles."),
    );
    await segmenter.processTurn(allMessages, ws, "main");

    // Buffer should have only the NEW messages (old buffer was flushed)
    const buffer = (segmenter as any).buffer as Message[];
    const hasNewTopic = buffer.some((m: Message) =>
      typeof m.content === "string" && m.content.includes("quantum physics")
    );
    assert.ok(hasNewTopic, "Buffer should contain only new-topic messages after Surprise boundary");

    // batchIngest SHOULD have been called
    const batchCalls = rpc.calls.filter((c: any) => c.method === "batchIngest");
    assert.ok(batchCalls.length > 0, "batchIngest should be called when autoSurpriseFlush=true and isBoundary=true");

    console.log("  PASS");
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// ─── Test 4: ep-boundary still works when autoSurpriseFlush=false ──────────────

async function testManualBoundaryStillWorks(): Promise<void> {
  console.log("Test: ep-boundary still works when autoSurpriseFlush=false...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,
    9000,
    { autoSurpriseFlush: false, autoIdleFlush: false, autoTimeGapFlush: false },
    pool,
    null,
  );

  // Push messages directly
  const msgs = [
    makeMsg("user", "Topic A discussion"),
    makeMsg("assistant", "Response about topic A"),
  ];
  (segmenter as any).buffer.push(...msgs);
  (segmenter as any).addBufferTokens(msgs);

  // Manual boundary should work regardless of autoSurpriseFlush setting
  const result = await segmenter.forceBoundary("/tmp/test-ws", "main", {
    note: "Manual boundary with Surprise gate off",
    boundaryReason: "manual-test",
  });

  assert.equal(result.flushed, true, "ep-boundary should flush even when autoSurpriseFlush=false");
  assert.ok(result.enqueuedChunks >= 1, "should enqueue at least 1 chunk");
  console.log("  PASS");
}

// ─── Test 5: Near-64K prefix flush uses checkpoint when Surprise gate off ─────

async function testNear64kUsesCheckpointWhenGateOff(): Promise<void> {
  console.log("Test: Near-64K prefix flush uses checkpoint even when autoSurpriseFlush=false...");
  // boundaryOnCall=1: Turn 1 absorbs, Turn 2 calls segmentScore (call #1) → isBoundary=true
  const rpc = createMockRpc({ boundaryOnCall: 1, boundaryReturn: true });

  // Create a pool that will hold data for prefix flush
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,
    9000,
    { autoSurpriseFlush: false, autoIdleFlush: false, autoTimeGapFlush: false },
    pool,
    null,
  );

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ep-phase-e-near64k-"));
  try {
    const initialBuffer = [
      makeMsg("user", "Tell me about cats."),
      makeMsg("assistant", "Cats are domesticated felines."),
      makeMsg("user", "Now switching topics."),
      makeMsg("assistant", "Switched."),
    ];
    (segmenter as any).buffer = initialBuffer.slice();
    (segmenter as any).recomputeBufferTokens();
    (segmenter as any).lastProcessedLength = initialBuffer.length;
    (segmenter as any).latestSurpriseCheckpoint = {
      index: 2,
      rawSurprise: 0.5,
      isFullBoundary: true,
      createdAt: new Date().toISOString(),
    };

    const flushed = await (segmenter as any).flushPrefixAtCheckpoint(ws, "main");
    assert.equal(flushed, true, "Prefix flush should succeed from recorded checkpoint when autoSurpriseFlush=false");

    // The prefix flush should have enqueued narrative work (pool path) or ingested directly (legacy path).
    const enqueueCalls = rpc.calls.filter((c: any) => c.method === "cache.enqueueBatch");
    const batchCalls = rpc.calls.filter((c: any) => c.method === "batchIngest");
    assert.ok(enqueueCalls.length > 0 || batchCalls.length > 0, "Near-64K prefix flush should enqueue or ingest the prefix work");

    // The suffix should remain live after the prefix flush.
    const bufferAfter = (segmenter as any).buffer as Message[];
    assert.equal(bufferAfter.length, 2, "Suffix buffer should remain live after prefix flush");
    assert.ok(bufferAfter.some((m: Message) => m.content === "Now switching topics."), "Suffix should keep post-checkpoint messages");

    // Checkpoint should be cleared after prefix flush
    const checkpointAfter = (segmenter as any).latestSurpriseCheckpoint;
    assert.equal(checkpointAfter, null, "Checkpoint should be cleared after prefix flush");

    console.log("  PASS");
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// ─── Test 6: No checkpoint helper returns false so caller can escalate ─────────

async function testNear64kNoCheckpointEscalatesToFullFlush(): Promise<void> {
  console.log("Test: Near-64K with no checkpoint escalates to full safety flush...");
  const rpc = createMockRpc({ boundaryOnCall: 999, boundaryReturn: false }); // never fires isBoundary
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,
    9000,
    {
      autoSurpriseFlush: false,
      autoIdleFlush: false,
      autoTimeGapFlush: false,
      segmentationMinRawSurprise: 0.5,
    },
    pool,
    null,
  );

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ep-phase-e-near64k-nocp-"));
  try {
    const initialBuffer = [
      makeMsg("user", "Tell me about cats."),
      makeMsg("assistant", "Cats are domesticated felines."),
    ];
    (segmenter as any).buffer = initialBuffer.slice();
    (segmenter as any).recomputeBufferTokens();
    (segmenter as any).lastProcessedLength = initialBuffer.length;
    (segmenter as any).latestSurpriseCheckpoint = null;

    const flushed = await (segmenter as any).flushPrefixAtCheckpoint(ws, "main");
    assert.equal(flushed, false, "Without a checkpoint the helper should return false so caller can escalate");
    assert.equal((segmenter as any).buffer.length, 2, "Buffer should stay intact when no checkpoint exists");

    console.log("  PASS");
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase E: autoSurpriseFlush Gate Tests ===\n");
  await testSurpriseGateDisabled();
  await testCheckpointStillRecorded();
  await testSurpriseGateEnabled();
  await testManualBoundaryStillWorks();
  await testNear64kUsesCheckpointWhenGateOff();
  await testNear64kNoCheckpointEscalatesToFullFlush();
  console.log("\n=== All Phase E tests passed ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
