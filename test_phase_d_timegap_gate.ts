/**
 * [v0.5.0 Phase D] Tests for autoTimeGapFlush gate.
 *
 * Covers:
 * 1. autoTimeGapFlush=false does NOT trigger segment boundary on large timestamp gap
 * 2. autoTimeGapFlush=true (default) DOES trigger segment boundary on large timestamp gap
 * 3. manual ep-boundary still works when autoTimeGapFlush=false
 * 4. Surprise scoring and normal buffering continue when time-gap gate is active
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

// ─── Test 1: autoTimeGapFlush=false blocks time-gap boundary ──────────────────

async function testTimeGapGateDisabled(): Promise<void> {
  console.log("Test: autoTimeGapFlush=false does NOT trigger time-gap boundary...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,    // dedupWindow
    9000, // maxCharsPerChunk
    { timeGapMinutes: 0.001, autoTimeGapFlush: false, autoIdleFlush: false }, // ~60ms gap threshold, gate OFF
    pool,
    null,
  );

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ep-phase-d-gate-off-"));
  try {
    // 1. Feed initial messages (processTurn takes the FULL conversation state)
    const t0 = new Date("2026-06-28T10:00:00Z");
    const allMessages: Message[] = [
      makeMsg("user", "Initial question about Go.", t0.toISOString()),
      makeMsg("assistant", "Go is a compiled language.", t0.toISOString()),
    ];
    await segmenter.processTurn(allMessages, ws, "main");

    // 2. Feed messages with large timestamp gap (>0.001 min = 60ms)
    //    processTurn takes the FULL conversation, so pass all 4 messages.
    const t1 = new Date(t0.getTime() + 120_000); // 2 minutes later
    allMessages.push(
      makeMsg("user", "Now switching to a completely different topic.", t1.toISOString()),
      makeMsg("assistant", "Okay, let's discuss the new topic.", t1.toISOString()),
    );
    await segmenter.processTurn(allMessages, ws, "main");

    // 3. Buffer should have ALL messages (no boundary flushed)
    const buffer = (segmenter as any).buffer as Message[];
    assert.ok(buffer.length >= 4, `Buffer should contain all 4+ messages when gate is off (got ${buffer.length})`);

    // 4. No batchIngest calls from time-gap (only segmentScore calls are expected)
    const batchCalls = rpc.calls.filter((c: any) => c.method === "batchIngest");
    assert.equal(batchCalls.length, 0, "batchIngest should NOT be called when autoTimeGapFlush=false");
    console.log("  PASS");
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// ─── Test 2: autoTimeGapFlush=true (default) triggers time-gap boundary ───────

async function testTimeGapGateEnabled(): Promise<void> {
  console.log("Test: autoTimeGapFlush=true (default) DOES trigger time-gap boundary...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,
    9000,
    { timeGapMinutes: 0.001, autoTimeGapFlush: true, autoIdleFlush: false }, // ~60ms gap threshold, gate ON
    pool,
    null,
  );

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ep-phase-d-gate-on-"));
  try {
    // 1. Feed initial messages (processTurn takes the FULL conversation state)
    const t0 = new Date("2026-06-28T10:00:00Z");
    const allMessages: Message[] = [
      makeMsg("user", "Initial question about Go.", t0.toISOString()),
      makeMsg("assistant", "Go is a compiled language.", t0.toISOString()),
    ];
    await segmenter.processTurn(allMessages, ws, "main");

    // 2. Wait >60ms to ensure time-gap threshold is exceeded
    await new Promise((r) => setTimeout(r, 100));

    // 3. Feed messages with large timestamp gap — pass FULL conversation state
    const t1 = new Date(t0.getTime() + 120_000); // 2 minutes later
    allMessages.push(
      makeMsg("user", "Now switching to a completely different topic.", t1.toISOString()),
      makeMsg("assistant", "Okay, let's discuss the new topic.", t1.toISOString()),
    );
    await segmenter.processTurn(allMessages, ws, "main");

    // 4. Buffer should have only the NEW messages (old buffer was flushed at boundary)
    const buffer = (segmenter as any).buffer as Message[];
    // After time-gap boundary: buffer = [new messages only]
    const hasNewTopic = buffer.some((m: Message) =>
      typeof m.content === "string" && m.content.includes("different topic")
    );
    assert.ok(hasNewTopic, "Buffer should contain the new-topic messages after time-gap boundary");

    // 5. batchIngest should have been called (time-gap flushed the old buffer)
    const batchCalls = rpc.calls.filter((c: any) => c.method === "batchIngest");
    assert.ok(batchCalls.length > 0, "batchIngest should be called when autoTimeGapFlush=true and gap detected");
    console.log("  PASS");
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// ─── Test 3: ep-boundary still works when autoTimeGapFlush=false ──────────────

async function testManualBoundaryStillWorks(): Promise<void> {
  console.log("Test: ep-boundary still works when autoTimeGapFlush=false...");
  const rpc = createMockRpc();
  const pool = new NarrativePool();
  const segmenter = new EventSegmenter(
    rpc,
    5,
    9000,
    { timeGapMinutes: 0.001, autoTimeGapFlush: false, autoIdleFlush: false },
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

  // Manual boundary should work regardless of autoTimeGapFlush setting
  const result = await segmenter.forceBoundary("/tmp/test-ws", "main", {
    note: "Manual boundary with gate off",
    boundaryReason: "manual-test",
  });

  assert.equal(result.flushed, true, "ep-boundary should flush even when autoTimeGapFlush=false");
  assert.ok(result.enqueuedChunks >= 1, "should enqueue at least 1 chunk");
  console.log("  PASS");
}

// ─── Test 4: Surprise scoring continues when time-gap gate is active ──────────

async function testSurpriseScoringUnaffected(): Promise<void> {
  console.log("Test: Surprise scoring continues when autoTimeGapFlush=false...");
  let segmentScoreCallCount = 0;
  const rpc = createMockRpc();
  rpc.segmentScore = async () => {
    segmentScoreCallCount++;
    return { rawSurprise: 0.3, mean: 0.1, std: 0.05, threshold: 0.2, z: 2.0, isBoundary: false, reason: "" };
  };

  const segmenter = new EventSegmenter(
    rpc,
    5,
    9000,
    { timeGapMinutes: 0.001, autoTimeGapFlush: false, autoIdleFlush: false },
    null,
    null,
  );

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ep-phase-d-surprise-"));
  try {
    const t0 = new Date("2026-06-28T10:00:00Z");
    const allMessages: Message[] = [
      makeMsg("user", "First message.", t0.toISOString()),
    ];
    // First turn — absorb only
    await segmenter.processTurn(allMessages, ws, "main");

    // Second turn — should trigger segmentScore even though time-gap gate blocks boundary
    const t1 = new Date(t0.getTime() + 120_000);
    allMessages.push(makeMsg("user", "Second message after gap.", t1.toISOString()));
    await segmenter.processTurn(allMessages, ws, "main");

    assert.ok(segmentScoreCallCount >= 1, `segmentScore should still be called (got ${segmentScoreCallCount})`);
    console.log("  PASS");
  } finally {
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase D: autoTimeGapFlush Gate Tests ===\n");
  await testTimeGapGateDisabled();
  await testTimeGapGateEnabled();
  await testManualBoundaryStillWorks();
  await testSurpriseScoringUnaffected();
  console.log("\n=== All Phase D tests passed ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
