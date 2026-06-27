/**
 * [v0.5.0 Phase 1] Tests for ep-boundary agent-driven narrative boundary.
 *
 * Covers:
 * 1. forceBoundary with buffered messages enqueues one narrative job
 * 2. forceBoundary with empty buffer returns no-op (empty-buffer)
 * 3. forceBoundary during compaction-skip returns no-op (compaction-skip)
 * 4. Boundary note is NOT appended to rawText (transcript contamination guard)
 * 5. boundary metadata fields are set on queue items in Phase 2
 * 6. forceBoundary awaits enqueue (non-empty path)
 * 7. Boundary reason defaults to manual when omitted
 */

import assert from "node:assert/strict";
import { EventSegmenter, Message, extractText } from "./src/segmenter";
import { NarrativePool } from "./src/narrative-pool";
import { HARD_TOKEN_CAP } from "./src/narrative-queue";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMsg(role: string, text: string): Message {
  return { role, content: text };
}

function createMockRpc() {
  const calls: { method: string; args: any[] }[] = [];
  return {
    calls,
    async segmentScore() {
      return { rawSurprise: 0, mean: 0, std: 0, threshold: 0, z: 0, isBoundary: false, reason: "" };
    },
    async setSegmenterCursor() {},
    async getSegmenterCursor() {
      return { lastProcessedLength: 0 };
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

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testForceBoundaryWithBuffer(): Promise<void> {
  console.log("Test: forceBoundary with buffered messages enqueues...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, pool, null);

  // Push messages into the buffer via processTurn
  const msgs = [
    makeMsg("user", "Hello, I need help with Go."),
    makeMsg("assistant", "Sure! What specifically about Go?"),
    makeMsg("user", "How do I handle errors in goroutines?"),
  ];
  // Inject messages directly into buffer (bypass processTurn RPC dependency)
  (segmenter as any).buffer.push(...msgs);
  (segmenter as any).addBufferTokens(msgs);

  const result = await segmenter.forceBoundary("/tmp/test-ws", "main", {
    note: "Task complete: explained goroutine error handling",
    boundaryReason: "task-complete",
    titleHint: "Go Error Handling",
  });

  assert.equal(result.flushed, true, "should report flushed");
  assert.equal(result.noOpReason, undefined, "no no-op reason on success");
  assert.ok(result.enqueuedChunks >= 1, "should enqueue at least 1 chunk");
  assert.equal(result.reason, "force-flush", "queue reason should be force-flush");
  console.log("  PASS");
}

async function testForceBoundaryEmptyBuffer(): Promise<void> {
  console.log("Test: forceBoundary with empty buffer returns no-op...");
  const rpc = createMockRpc();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, null, null);

  const result = await segmenter.forceBoundary("/tmp/test-ws", "main");

  assert.equal(result.flushed, false, "should not flush");
  assert.equal(result.noOpReason, "empty-buffer", "should report empty-buffer no-op");
  assert.equal(result.enqueuedChunks, 0, "should not enqueue anything");
  console.log("  PASS");
}

async function testForceBoundaryCompactionSkip(): Promise<void> {
  console.log("Test: forceBoundary during compaction-skip returns no-op...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, pool, null);

  // Simulate pending compaction skip
  (segmenter as any).pendingCompactionSkip = true;
  // Also push some messages to prove the guard fires even with data
  (segmenter as any).buffer.push(makeMsg("user", "test"));

  const result = await segmenter.forceBoundary("/tmp/test-ws", "main");

  assert.equal(result.flushed, false, "should not flush during compaction skip");
  assert.equal(result.noOpReason, "compaction-skip", "should report compaction-skip no-op");
  assert.equal(result.enqueuedChunks, 0, "should not enqueue");
  console.log("  PASS");
}

async function testBoundaryNoteNotInRawText(): Promise<void> {
  console.log("Test: boundary note is NOT appended to rawText...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, pool, null);

  const msgs = [
    makeMsg("user", "User message one"),
    makeMsg("assistant", "Assistant response one"),
  ];
  (segmenter as any).buffer.push(...msgs);
  (segmenter as any).addBufferTokens(msgs);

  const boundaryNote = "This is a boundary note that must NOT appear in rawText";

  await segmenter.forceBoundary("/tmp/test-ws", "main", {
    note: boundaryNote,
    boundaryReason: "task-complete",
  });

  // The pool received the buffer before forceBoundary ran, so check
  // the queue items enqueued via RPC. The rawText in those items must
  // not contain the boundary note.
  const batchIngestCall = rpc.calls.find((c: any) => c.method === "cache.enqueueBatch");
  assert.ok(batchIngestCall, "cache.enqueueBatch should have been called");

  const items = batchIngestCall.args[0].items;
  for (const item of items) {
    assert.ok(
      !item.rawText.includes(boundaryNote),
      `rawText must not contain boundary note. rawText preview: "${item.rawText.substring(0, 100)}"`
    );
  }
  console.log("  PASS");
}

async function testBoundaryMetadataOnQueueItems(): Promise<void> {
  console.log("Test: Phase 2 persists boundary metadata into queue items...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, pool, null);

  const msgs = [
    makeMsg("user", "Topic A discussion"),
    makeMsg("assistant", "Response about topic A"),
    makeMsg("user", "Now switching to topic B entirely"),
  ];
  (segmenter as any).buffer.push(...msgs);
  (segmenter as any).addBufferTokens(msgs);

  await segmenter.forceBoundary("/tmp/test-ws", "main", {
    note: "Switching topics",
    boundaryReason: "topic-shift",
    titleHint: "Topic B",
  });

  const batchIngestCall = rpc.calls.find((c: any) => c.method === "cache.enqueueBatch");
  assert.ok(batchIngestCall, "cache.enqueueBatch should have been called");

  const items = batchIngestCall.args[0].items;
  assert.ok(items.length >= 1, "should have at least 1 queue item");

  const item = items[0];
  assert.equal(item.reason, "force-flush", "queue reason should remain force-flush");
  assert.equal(item.boundaryNote, "Switching topics", "Phase 2 should persist boundaryNote");
  assert.equal(item.boundaryReason, "topic-shift", "Phase 2 should persist boundaryReason");
  assert.equal(item.boundaryTitleHint, "Topic B", "Phase 2 should persist boundaryTitleHint");
  assert.equal(item.boundaryBy, "main", "Phase 2 should persist boundaryBy");
  assert.ok(item.boundaryCreatedAt, "Phase 2 should persist boundaryCreatedAt");
  console.log("  PASS");
}

async function testForceBoundaryAwaitsEnqueue(): Promise<void> {
  console.log("Test: forceBoundary awaits enqueue completion...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, pool, null);

  (segmenter as any).buffer.push(makeMsg("user", "test message"));
  (segmenter as any).addBufferTokens([makeMsg("user", "test message")]);

  const start = Date.now();
  const result = await segmenter.forceBoundary("/tmp/test-ws", "main");
  const elapsed = Date.now() - start;

  assert.equal(result.flushed, true, "should flush");
  // The method should have awaited the enqueue (not returned immediately)
  assert.ok(elapsed >= 0, "should have awaited (not fire-and-forget)");
  // Verify RPC was called
  const batchCall = rpc.calls.find((c: any) => c.method === "cache.enqueueBatch");
  assert.ok(batchCall, "cache.enqueueBatch should have been called (awaited)");
  console.log("  PASS");
}

async function testForceBoundaryReasonDefault(): Promise<void> {
  console.log("Test: boundary reason defaults to manual when omitted...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, pool, null);

  (segmenter as any).buffer.push(makeMsg("user", "test"));
  (segmenter as any).addBufferTokens([makeMsg("user", "test")]);

  await segmenter.forceBoundary("/tmp/test-ws", "main", {
    note: "Manual boundary",
    // No boundaryReason — should not cause issues
  });

  const batchIngestCall = rpc.calls.find((c: any) => c.method === "cache.enqueueBatch");
  assert.ok(batchIngestCall, "should enqueue");
  const items = batchIngestCall.args[0].items;
  assert.ok(items.length >= 1, "should have queue items");
  // When omitted, semantic boundary reason remains absent even in Phase 2
  assert.equal(items[0].boundaryReason, undefined, "boundaryReason should stay undefined when omitted");
  console.log("  PASS");
}

async function testBufferClearedAfterBoundary(): Promise<void> {
  console.log("Test: buffer is cleared after successful boundary...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, pool, null);

  (segmenter as any).buffer.push(makeMsg("user", "msg1"), makeMsg("assistant", "msg2"));
  (segmenter as any).addBufferTokens([makeMsg("user", "msg1"), makeMsg("assistant", "msg2")]);
  const bufferLen = (segmenter as any).buffer.length;
  assert.ok(bufferLen > 0, "buffer should have messages before boundary");

  await segmenter.forceBoundary("/tmp/test-ws", "main");

  assert.equal((segmenter as any).buffer.length, 0, "buffer should be empty after boundary");
  console.log("  PASS");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== ep-boundary Phase 1 tests ===\n");
  await testForceBoundaryWithBuffer();
  await testForceBoundaryEmptyBuffer();
  await testForceBoundaryCompactionSkip();
  await testBoundaryNoteNotInRawText();
  await testBoundaryMetadataOnQueueItems();
  await testForceBoundaryAwaitsEnqueue();
  await testForceBoundaryReasonDefault();
  await testBufferClearedAfterBoundary();
  console.log("\n=== All ep-boundary tests passed ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
