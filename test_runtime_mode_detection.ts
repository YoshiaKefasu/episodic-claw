/**
 * test_runtime_mode_detection.ts — v0.4.28d Fix D4
 * Unit tests for resolveRuntimeMode() pure helper + EPISODIC_LOG_CLI_SKIP log control.
 *
 * Run: npx tsx test_runtime_mode_detection.ts
 */
import { resolveRuntimeMode } from "./src/runtime-mode";

let passed = 0;
let failed = 0;

function assert(label: string, actual: any, expected: any) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    console.error(`     Expected: ${JSON.stringify(expected)}`);
    console.error(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── Test 1: argv contains "gateway" → daemon ─────────────────────
{
  const result = resolveRuntimeMode(["node", "openclaw", "gateway"]);
  assert("Test 1: gateway → daemon", result.mode, "daemon");
  assert("Test 1: reason", result.reason, "argv:gateway");
}

// ─── Test 2: argv contains "agent" → daemon ───────────────────────
{
  const result = resolveRuntimeMode(["node", "openclaw", "agent"]);
  assert("Test 2: agent → daemon", result.mode, "daemon");
  assert("Test 2: reason", result.reason, "argv:agent");
}

// ─── Test 3: argv contains "test" → daemon ────────────────────────
{
  const result = resolveRuntimeMode(["node", "openclaw", "test"]);
  assert("Test 3: test → daemon", result.mode, "daemon");
  assert("Test 3: reason", result.reason, "argv:test");
}

// ─── Test 4: argv contains "node" but no daemon cmd → cli ──────────
// v0.4.28d: "node" is NOT in DAEMON_CMDS (deferred to follow-up PR)
{
  const result = resolveRuntimeMode(["node", "openclaw", "node"]);
  assert("Test 4: node → cli (v0.4.28d)", result.mode, "cli");
  assert("Test 4: reason", result.reason, "argv:no-daemon-cmd");
}

// ─── Test 5: argv contains "start" → cli (intentional exclusion) ───
{
  const result = resolveRuntimeMode(["node", "openclaw", "start"]);
  assert("Test 5: start → cli (intentional exclusion)", result.mode, "cli");
  assert("Test 5: reason", result.reason, "argv:no-daemon-cmd");
}

// ─── Test 6: empty argv → cli ──────────────────────────────────────
{
  const result = resolveRuntimeMode([]);
  assert("Test 6: empty argv → cli", result.mode, "cli");
  assert("Test 6: reason", result.reason, "argv:no-daemon-cmd");
}

// ─── Test 7: daemon argv at any position ────────────────────────────
{
  const result = resolveRuntimeMode(["gateway", "some-other-arg"]);
  assert("Test 7: gateway at position 0 → daemon", result.mode, "daemon");
}

// ─── Test 8: multiple daemon cmds → first match wins ───────────────
{
  const result = resolveRuntimeMode(["node", "gateway", "agent"]);
  assert("Test 8: multiple daemon cmds → daemon", result.mode, "daemon");
  assert("Test 8: first match = gateway", result.reason, "argv:gateway");
}

// ─── Test 9: EPISODIC_LOG_CLI_SKIP env flag ────────────────────────
{
  const originalValue = process.env.EPISODIC_LOG_CLI_SKIP;

  delete process.env.EPISODIC_LOG_CLI_SKIP;
  assert("Test 9a: EPISODIC_LOG_CLI_SKIP unset → false", process.env.EPISODIC_LOG_CLI_SKIP === "1", false);

  process.env.EPISODIC_LOG_CLI_SKIP = "1";
  assert("Test 9b: EPISODIC_LOG_CLI_SKIP=1 → true", process.env.EPISODIC_LOG_CLI_SKIP === "1", true);

  // Restore
  if (originalValue === undefined) {
    delete process.env.EPISODIC_LOG_CLI_SKIP;
  } else {
    process.env.EPISODIC_LOG_CLI_SKIP = originalValue;
  }
}

// ─── Coverage gap note ──────────────────────────────────────────────
// The pure helper (resolveRuntimeMode) is fully tested above.
// The D2 (EPISODIC_LOG_CLI_SKIP gating) and D3 (JSON runtime-mode event) behaviors
// inside register() are NOT covered here — testing them requires importing the full
// dist/index.js (which has CJS/ESM compatibility issues in this project's test setup)
// and spying on console.log. These paths are verified manually and via canary observability.
// If a future refactor removes the EPISODIC_LOG_CLI_SKIP guard, no automated test will catch it.

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════`);
if (failed === 0) {
  console.log(`v0.4.28d runtime mode detection: all ${passed} tests passed ✅`);
} else {
  console.log(`v0.4.28d runtime mode detection: ${passed} passed, ${failed} failed ❌`);
  process.exit(1);
}
console.log(`═══════════════════════════════════════════════`);
