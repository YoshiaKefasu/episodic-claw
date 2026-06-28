/**
 * [v0.5.0 Phase C] Tests for autoIdleFlush=false gate.
 *
 * Covers:
 * 1. autoIdleFlush=false does not schedule idle timer
 * 2. autoIdleFlush=false clears an existing idle timer
 * 3. autoIdleFlush=true (default) schedules idle timer normally
 * 4. forceBoundary still works when autoIdleFlush=false
 */

import assert from "node:assert/strict";
import { EventSegmenter, Message } from "./src/segmenter";
import { NarrativePool } from "./src/narrative-pool";

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

async function testAutoIdleFlushFalseNoTimer(): Promise<void> {
  console.log("Test: autoIdleFlush=false does not schedule idle timer...");
  const rpc = createMockRpc();
  const segmenter = new EventSegmenter(rpc, 5, 9000, { autoIdleFlush: false }, null, null);

  // Push messages and trigger scheduleIdleFlush via processTurn path
  const msgs = [makeMsg("user", "Hello"), makeMsg("assistant", "Hi there")];
  (segmenter as any).buffer.push(...msgs);
  (segmenter as any).addBufferTokens(msgs);

  // Call scheduleIdleFlush directly (simulates what processTurn does)
  (segmenter as any).scheduleIdleFlush("/tmp/test-ws", "main");

  // Verify no timer was set
  const timer = (segmenter as any).idleFlushTimer;
  assert.equal(timer, null, "idleFlushTimer should be null when autoIdleFlush=false");
  console.log("  PASS");
}

async function testAutoIdleFlushFalseClearsExistingTimer(): Promise<void> {
  console.log("Test: autoIdleFlush=false clears an existing idle timer...");
  const rpc = createMockRpc();
  const segmenter = new EventSegmenter(rpc, 5, 9000, { autoIdleFlush: true }, null, null);

  // Manually set a fake timer
  const fakeTimer = setTimeout(() => {}, 60000);
  (segmenter as any).idleFlushTimer = fakeTimer;

  // Now switch to autoIdleFlush=false by setting the field directly
  // (simulates config reload or initial state)
  (segmenter as any).autoIdleFlush = false;

  // Call scheduleIdleFlush — should clear the existing timer and return
  (segmenter as any).scheduleIdleFlush("/tmp/test-ws", "main");

  const timer = (segmenter as any).idleFlushTimer;
  assert.equal(timer, null, "idleFlushTimer should be cleared when autoIdleFlush=false");

  // Clean up the fake timer (it was already cleared by clearIdleFlushTimer)
  clearTimeout(fakeTimer);
  console.log("  PASS");
}

async function testAutoIdleFlushTrueDefaultBehavior(): Promise<void> {
  console.log("Test: autoIdleFlush=true (default) schedules idle timer...");
  const rpc = createMockRpc();
  const segmenter = new EventSegmenter(rpc, 5, 9000, { autoIdleFlush: true, timeGapMinutes: 15 }, null, null);

  // Push messages
  const msgs = [makeMsg("user", "Hello"), makeMsg("assistant", "Hi")];
  (segmenter as any).buffer.push(...msgs);
  (segmenter as any).addBufferTokens(msgs);

  // Call scheduleIdleFlush
  (segmenter as any).scheduleIdleFlush("/tmp/test-ws", "main");

  // Verify timer was set
  const timer = (segmenter as any).idleFlushTimer;
  assert.ok(timer !== null, "idleFlushTimer should be set when autoIdleFlush=true");

  // Clean up
  (segmenter as any).clearIdleFlushTimer();
  console.log("  PASS");
}

async function testForceBoundaryStillWorksWithAutoIdleFlushFalse(): Promise<void> {
  console.log("Test: forceBoundary works when autoIdleFlush=false...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(rpc, 5, 9000, { autoIdleFlush: false }, pool, null);

  // Push messages
  const msgs = [makeMsg("user", "Task: explain Go errors"), makeMsg("assistant", "Go uses error values...")];
  (segmenter as any).buffer.push(...msgs);
  (segmenter as any).addBufferTokens(msgs);

  // Verify no idle timer before boundary
  assert.equal((segmenter as any).idleFlushTimer, null, "no idle timer before boundary");

  // forceBoundary should still work
  const result = await segmenter.forceBoundary("/tmp/test-ws", "main", {
    note: "Task complete",
    boundaryReason: "task-complete",
  });

  assert.equal(result.flushed, true, "forceBoundary should flush even when autoIdleFlush=false");
  assert.ok(result.enqueuedChunks >= 1, "should enqueue at least 1 chunk");
  console.log("  PASS");
}

async function testProcessTurnRespectsAutoIdleFlushFalse(): Promise<void> {
  console.log("Test: processTurn does not schedule idle timer when autoIdleFlush=false...");
  const rpc = createMockRpc();
  const segmenter = new EventSegmenter(rpc, 5, 9000, { autoIdleFlush: false, timeGapMinutes: 15 }, null, null);

  // processTurn with first message — should absorb but not schedule timer
  await segmenter.processTurn(
    [makeMsg("user", "Hello world")],
    "/tmp/test-ws",
    "main"
  );

  const timer = (segmenter as any).idleFlushTimer;
  assert.equal(timer, null, "idleFlushTimer should not be set after processTurn when autoIdleFlush=false");
  console.log("  PASS");
}

async function testDefaultConfigEnablesIdleFlush(): Promise<void> {
  console.log("Test: default config (no tuning) enables idle flush...");
  const rpc = createMockRpc();
  const segmenter = new EventSegmenter(rpc, 5, 9000, {}, null, null);

  // Default should be true
  const autoIdleFlush = (segmenter as any).autoIdleFlush;
  assert.equal(autoIdleFlush, true, "autoIdleFlush should default to true");

  // Push messages and schedule
  const msgs = [makeMsg("user", "Test")];
  (segmenter as any).buffer.push(...msgs);
  (segmenter as any).addBufferTokens(msgs);
  (segmenter as any).scheduleIdleFlush("/tmp/test-ws", "main");

  const timer = (segmenter as any).idleFlushTimer;
  assert.ok(timer !== null, "idleFlushTimer should be set with default config");

  // Clean up
  (segmenter as any).clearIdleFlushTimer();
  console.log("  PASS");
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("=== autoIdleFlush gate Phase C tests ===\n");
  await testAutoIdleFlushFalseNoTimer();
  await testAutoIdleFlushFalseClearsExistingTimer();
  await testAutoIdleFlushTrueDefaultBehavior();
  await testForceBoundaryStillWorksWithAutoIdleFlushFalse();
  await testProcessTurnRespectsAutoIdleFlushFalse();
  await testDefaultConfigEnablesIdleFlush();
  console.log("\n=== All autoIdleFlush gate tests passed ===");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
