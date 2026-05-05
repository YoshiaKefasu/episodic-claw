import assert from "node:assert";

import { GeminiDirectError } from "./src/gemini-direct-client";
import { OpenRouterError } from "./src/openrouter-client";
import {
  TRANSPORT_RETRY_SCHEDULE_SEC,
  computeTransportRetryDelayMs,
  parseGeminiPleaseRetryInSeconds,
  MAX_TRANSPORT_RETRY_DELAY_MS,
} from "./src/transport-retry";

function sec(n: number): number { return n * 1000; }

console.log("\n=== Transport Retry Schedule Tests (v0.4.30c) ===\n");

// 1) Schedule constant
assert.deepStrictEqual(
  Array.from(TRANSPORT_RETRY_SCHEDULE_SEC),
  [60, 120, 240, 480, 960, 1280],
  "TRANSPORT_RETRY_SCHEDULE_SEC must match 60/120/240/480/960/1280",
);
assert.strictEqual(MAX_TRANSPORT_RETRY_DELAY_MS, sec(1280), "cap must match schedule max (1280s)");

// 2) parseGeminiPleaseRetryInSeconds
assert.strictEqual(parseGeminiPleaseRetryInSeconds("no hint"), 0, "no hint => 0");
assert.strictEqual(
  parseGeminiPleaseRetryInSeconds("Please retry in 32.2s.. Retrying"),
  32.2,
  "should parse float seconds",
);

// 3) computeTransportRetryDelayMs schedule mapping
{
  const r0 = computeTransportRetryDelayMs(0, new Error("x"));
  assert.strictEqual(r0.scheduleDelayMs, sec(60), "attempt=0 schedule=60s");
  assert.strictEqual(r0.finalDelayMs, sec(60), "no retryAfter => final=schedule");

  const r5 = computeTransportRetryDelayMs(5, new Error("x"));
  assert.strictEqual(r5.scheduleDelayMs, sec(1280), "attempt=5 schedule=1280s");

  const rBig = computeTransportRetryDelayMs(999, new Error("x"));
  assert.strictEqual(rBig.scheduleDelayMs, sec(1280), "attempt>=5 clamps to 1280s");
}

// 4) Retry-After override (OpenRouter)
{
  const e = new OpenRouterError({
    message: "OpenRouter HTTP 429",
    errorClass: "http_429",
    retriable: true,
    retryAfterSeconds: 180, // 3 minutes
  });
  const r = computeTransportRetryDelayMs(0, e);
  assert.strictEqual(r.scheduleDelayMs, sec(60), "schedule base is 60s");
  assert.strictEqual(r.retryAfterMs, sec(180), "retryAfter should be surfaced");
  assert.strictEqual(r.finalDelayMs, sec(180), "final=max(schedule, retryAfter)");
}

// 5) Retry-After override (Gemini message)
{
  const e = new GeminiDirectError({
    message: "Quota exceeded. Please retry in 120.5s..",
    errorClass: "gemini_http_429",
    retriable: true,
    statusCode: 429,
  });
  const r = computeTransportRetryDelayMs(0, e);
  assert.strictEqual(r.retryAfterMs, sec(120.5), "gemini hint should be parsed");
  assert.strictEqual(r.finalDelayMs, sec(120.5), "final=max(schedule, retryAfter)");
}

// 6) non-retriable OpenRouterError guard in narrative-worker.ts
// Verifies that the source contains the non-retriable early-handoff guard for OpenRouter.
// (NarrativeWorker is not instantiated here to keep tests lightweight.)
{
  const fs = await import("node:fs/promises");
  const workerSrc = await fs.readFile("./src/narrative-worker.ts", "utf-8");

  // OpenRouter non-retriable guard (added v0.4.30c)
  const hasOpenRouterGuard =
    workerSrc.includes("err instanceof OpenRouterError && !err.retriable") &&
    workerSrc.includes("Handing off to next phase");
  assert.ok(hasOpenRouterGuard, "narrative-worker must have non-retriable OpenRouterError => return null guard");

  // Gemini non-retriable guard (added v0.4.30a)
  const hasGeminiGuard =
    workerSrc.includes("err instanceof GeminiDirectError && !err.retriable");
  assert.ok(hasGeminiGuard, "narrative-worker must have non-retriable GeminiDirectError => return null guard");

  // Both guards must return null (handoff) not throw
  const orGuardBlock = workerSrc.match(
    /err instanceof OpenRouterError && !err\.retriable[\s\S]{0,300}?return null/
  );
  assert.ok(orGuardBlock, "OpenRouter non-retriable guard must reach return null");

  const gdGuardBlock = workerSrc.match(
    /err instanceof GeminiDirectError && !err\.retriable[\s\S]{0,300}?return null/
  );
  assert.ok(gdGuardBlock, "GeminiDirect non-retriable guard must reach return null");

  console.log("  ✓ non-retriable handoff guards verified in narrative-worker.ts");
}

console.log("✅ Transport retry schedule tests passed.");
