/**
 * [v0.5.0 Phase 4] Integration-style tests for Go-backed boundary state sync.
 */

import assert from "node:assert/strict";
import { EventSegmenter } from "./src/segmenter";

function createMockRpc(overrides: Record<string, any> = {}): any {
  return {
    setBoundaryStateCalls: [] as any[],
    async setBoundaryState(agentWs: string, agentId: string, state: any): Promise<boolean> {
      this.setBoundaryStateCalls.push({ agentWs, agentId, state });
      return true;
    },
    async getBoundaryState(_agentWs: string, _agentId: string): Promise<any> {
      return {};
    },
    ...overrides,
  };
}

export async function testSyncCheckpointToGoPersistsSequence(): Promise<void> {
  const rpc = createMockRpc();
  const segmenter = new EventSegmenter(rpc as any);

  (segmenter as any).latestSurpriseCheckpoint = {
    index: 42,
    rawSurprise: 0.15,
    isFullBoundary: true,
    createdAt: "2026-06-27T12:00:00.000Z",
  };

  (segmenter as any).syncCheckpointToGo("/tmp/ws", "main");
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rpc.setBoundaryStateCalls.length, 1, "checkpoint set should sync once");
  const first = rpc.setBoundaryStateCalls[0];
  assert.equal(first.agentWs, "/tmp/ws");
  assert.equal(first.agentId, "main");
  assert.equal(first.state.latestCheckpoint.index, 42);
  assert.equal(first.state.lastBoundaryReason, "surprise-boundary");
  assert.equal(first.state.boundarySequence, 1);

  (segmenter as any).latestSurpriseCheckpoint = null;
  (segmenter as any).syncCheckpointToGo("/tmp/ws", "main");
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(rpc.setBoundaryStateCalls.length, 2, "checkpoint clear should sync once more");
  const second = rpc.setBoundaryStateCalls[1];
  assert.equal(second.state.latestCheckpoint, undefined, "clear sync should omit checkpoint");
  assert.equal(second.state.boundarySequence, 2, "sequence should increase monotonically");

  console.log("  syncCheckpointToGo persists checkpoint + monotonic sequence: verified");
}

export async function testRestoreCheckpointFromGo(): Promise<void> {
  const rpc = createMockRpc({
    async getBoundaryState() {
      return {
        latestCheckpoint: {
          index: 9,
          rawSurprise: 0.21,
          isFullBoundary: false,
          createdAt: "2026-06-27T12:34:56.000Z",
        },
        boundarySequence: 7,
      };
    },
  });
  const segmenter = new EventSegmenter(rpc as any);

  await segmenter.restoreCheckpointFromGo("/tmp/ws", "main");

  assert.deepEqual((segmenter as any).latestSurpriseCheckpoint, {
    index: 9,
    rawSurprise: 0.21,
    isFullBoundary: false,
    createdAt: "2026-06-27T12:34:56.000Z",
  });
  assert.equal((segmenter as any).boundaryStateSequence, 7, "restore should sync local sequence to remote max");

  console.log("  restoreCheckpointFromGo restores checkpoint + sequence: verified");
}

export async function testRestoreCheckpointDoesNotOverwriteLiveState(): Promise<void> {
  let getCalls = 0;
  const rpc = createMockRpc({
    async getBoundaryState() {
      getCalls += 1;
      return {
        latestCheckpoint: {
          index: 99,
          rawSurprise: 0.99,
          isFullBoundary: true,
          createdAt: "2026-06-27T09:00:00.000Z",
        },
        boundarySequence: 99,
      };
    },
  });
  const segmenter = new EventSegmenter(rpc as any);
  (segmenter as any).latestSurpriseCheckpoint = {
    index: 5,
    rawSurprise: 0.1,
    isFullBoundary: false,
    createdAt: "2026-06-27T10:00:00.000Z",
  };

  await segmenter.restoreCheckpointFromGo("/tmp/ws", "main");

  assert.equal(getCalls, 0, "live checkpoint should short-circuit Go restore");
  assert.equal((segmenter as any).latestSurpriseCheckpoint.index, 5, "live checkpoint should stay source of truth");

  console.log("  restoreCheckpointFromGo does not overwrite live checkpoint: verified");
}

export async function testKillSwitchSkipsBoundaryStateSync(): Promise<void> {
  const orig = process.env.EPISODIC_DISABLE_GO_BOUNDARY_STATE;
  process.env.EPISODIC_DISABLE_GO_BOUNDARY_STATE = "1";
  try {
    const rpc = createMockRpc();
    const segmenter = new EventSegmenter(rpc as any);
    (segmenter as any).latestSurpriseCheckpoint = {
      index: 1,
      rawSurprise: 0.12,
      isFullBoundary: false,
      createdAt: "2026-06-27T12:00:00.000Z",
    };
    (segmenter as any).syncCheckpointToGo("/tmp/ws", "main");
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(rpc.setBoundaryStateCalls.length, 0, "kill switch should skip Go sync");
    console.log("  kill switch skips boundary-state sync: verified");
  } finally {
    if (orig === undefined) delete process.env.EPISODIC_DISABLE_GO_BOUNDARY_STATE;
    else process.env.EPISODIC_DISABLE_GO_BOUNDARY_STATE = orig;
  }
}

export async function testOldSidecarFallbackIsSafe(): Promise<void> {
  const rpc = createMockRpc({
    async setBoundaryState() {
      throw new Error("Method not found");
    },
    async getBoundaryState() {
      throw new Error("Method not found");
    },
  });
  const segmenter = new EventSegmenter(rpc as any);
  (segmenter as any).latestSurpriseCheckpoint = {
    index: 3,
    rawSurprise: 0.11,
    isFullBoundary: false,
    createdAt: "2026-06-27T12:00:00.000Z",
  };

  (segmenter as any).syncCheckpointToGo("/tmp/ws", "main");
  await new Promise((r) => setTimeout(r, 0));
  await segmenter.restoreCheckpointFromGo("/tmp/ws", "main");

  assert.equal((segmenter as any).latestSurpriseCheckpoint.index, 3, "fallback should keep TS state intact");
  console.log("  old sidecar fallback keeps pure-TS behavior: verified");
}

async function main() {
  console.log("=== Phase 4 Boundary State Tests ===");
  await testSyncCheckpointToGoPersistsSequence();
  await testRestoreCheckpointFromGo();
  await testRestoreCheckpointDoesNotOverwriteLiveState();
  await testKillSwitchSkipsBoundaryStateSync();
  await testOldSidecarFallbackIsSafe();
  console.log("\n=== All Phase 4 boundary state tests passed ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
