/**
 * Tests for v0.4.4 OpenRouter reasoning/thinking enable feature.
 *
 * Covers:
 * - normalizeOpenRouterReasoning() normalization rules
 * - OpenRouterClient request body reasoning payload construction
 * - Backward compatibility for existing openrouter fields
 *
 * Run: npx tsx test_reasoning.ts
 */
import assert from "node:assert/strict";
import { normalizeOpenRouterReasoning } from "./src/config";
import { OpenRouterClient } from "./src/openrouter-client";
import type { OpenRouterReasoningConfig } from "./src/types";

// ─── Helper: execute OpenRouterClient and capture outgoing request body ───
async function captureRequestBody(reasoning: ReturnType<typeof normalizeOpenRouterReasoning>, maxTokens?: number): Promise<Record<string, any>> {
  let capturedBody: Record<string, any> | null = null;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body ?? "{}"));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const client = new OpenRouterClient({
      apiKey: "test-key",
      model: "test-model",
      temperature: 0.4,
      timeoutMs: 3000,
      maxRetries: 0,
      baseUrl: "https://example.com/api/v1",
      reasoning,
      maxTokens,
    });
    await client.chatCompletion({ systemPrompt: "sys", userMessage: "hello" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(capturedBody, "request body should be captured");
  return capturedBody!;
}

// ─── normalizeOpenRouterReasoning tests ───

function testNormalizeDefaults() {
  const raw: OpenRouterReasoningConfig = { enabled: true, effort: "high" };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result, "should not be undefined");
  assert.equal(result!.enabled, true);
  assert.equal(result!.effort, "high");
  assert.equal(result!.maxTokens, undefined);
  assert.equal(result!.exclude, undefined);
  console.log("  ✓ normalizeOpenRouterReasoning: defaults (enabled=true, effort=high)");
}

function testNormalizeDisabled() {
  const raw: OpenRouterReasoningConfig = { enabled: false };
  const result = normalizeOpenRouterReasoning(raw);
  assert.equal(result, undefined, "enabled=false should return undefined");
  console.log("  ✓ normalizeOpenRouterReasoning: enabled=false => undefined");
}

function testNormalizeEffortMedium() {
  const raw: OpenRouterReasoningConfig = { effort: "medium" };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.effort, "medium");
  console.log("  ✓ normalizeOpenRouterReasoning: effort=medium");
}

function testNormalizeMaxTokens() {
  const raw: OpenRouterReasoningConfig = { maxTokens: 2048 };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.maxTokens, 2048);
  assert.equal(result!.effort, undefined);
  console.log("  ✓ normalizeOpenRouterReasoning: maxTokens=2048");
}

function testNormalizeEffortAndMaxTokens() {
  const raw: OpenRouterReasoningConfig = { effort: "high", maxTokens: 2048 };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.maxTokens, 2048, "maxTokens should be preserved");
  assert.equal(result!.effort, undefined, "effort should be dropped when maxTokens is present");
  console.log("  ✓ normalizeOpenRouterReasoning: effort+maxTokens => maxTokens only");
}

function testNormalizeExclude() {
  const raw: OpenRouterReasoningConfig = { exclude: true };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.exclude, true);
  console.log("  ✓ normalizeOpenRouterReasoning: exclude=true");
}

function testNormalizeExcludeFalse() {
  const raw: OpenRouterReasoningConfig = { exclude: false };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.exclude, undefined, "exclude=false should not be included");
  console.log("  ✓ normalizeOpenRouterReasoning: exclude=false => undefined");
}

function testNormalizeInvalidMaxTokensZero() {
  const raw: OpenRouterReasoningConfig = { maxTokens: 0 };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.maxTokens, undefined, "maxTokens=0 should be treated as unset");
  console.log("  ✓ normalizeOpenRouterReasoning: maxTokens=0 => unset");
}

function testNormalizeInvalidMaxTokensNegative() {
  const raw: OpenRouterReasoningConfig = { maxTokens: -100 };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.maxTokens, undefined, "maxTokens=-100 should be treated as unset");
  console.log("  ✓ normalizeOpenRouterReasoning: maxTokens=-100 => unset");
}

function testNormalizeInvalidMaxTokensFloat() {
  const raw: OpenRouterReasoningConfig = { maxTokens: 3.14 };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.maxTokens, undefined, "maxTokens=3.14 (non-integer) should be treated as unset");
  console.log("  ✓ normalizeOpenRouterReasoning: maxTokens=3.14 (non-integer) => unset");
}

function testNormalizeUndefined() {
  const result = normalizeOpenRouterReasoning(undefined);
  assert.equal(result, undefined);
  console.log("  ✓ normalizeOpenRouterReasoning: undefined => undefined");
}

function testNormalizeEmptyObject() {
  const result = normalizeOpenRouterReasoning({});
  assert.ok(result);
  assert.equal(result!.enabled, true);
  assert.equal(result!.effort, "high", "empty object should default effort to high");
  assert.equal(result!.maxTokens, undefined);
  assert.equal(result!.exclude, undefined);
  console.log("  ✓ normalizeOpenRouterReasoning: empty object => enabled=true, effort=high");
}

function testNormalizeEnabledNoEffort() {
  const raw: OpenRouterReasoningConfig = { enabled: true };
  const result = normalizeOpenRouterReasoning(raw);
  assert.ok(result);
  assert.equal(result!.enabled, true);
  assert.equal(result!.effort, "high", "enabled=true without effort should default to high");
  assert.equal(result!.maxTokens, undefined);
  console.log("  ✓ normalizeOpenRouterReasoning: { enabled: true } => effort=high");
}

// ─── Request body construction tests (actual OpenRouterClient payload) ───

async function testBodyDefaultEffortHigh() {
  const raw: OpenRouterReasoningConfig = { enabled: true, effort: "high" };
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  assert.ok(body.reasoning);
  assert.equal(body.reasoning.effort, "high");
  console.log("  ✓ body: default => reasoning.effort=high");
}

async function testBodyDisabled() {
  const raw: OpenRouterReasoningConfig = { enabled: false };
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  assert.equal(body.reasoning, undefined, "disabled reasoning should not appear in body");
  console.log("  ✓ body: enabled=false => no reasoning in body");
}

async function testBodyEnabledNoEffortDefaultsHigh() {
  const raw: OpenRouterReasoningConfig = { enabled: true };
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  assert.ok(body.reasoning);
  assert.equal(body.reasoning.effort, "high", "enabled=true without effort should default to high in body");
  console.log("  ✓ body: { enabled: true } => reasoning.effort=high");
}

async function testBodyEmptyObjectDefaultsHigh() {
  const raw: OpenRouterReasoningConfig = {};
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  assert.ok(body.reasoning);
  assert.equal(body.reasoning.effort, "high", "empty object should default effort to high in body");
  console.log("  ✓ body: {} => reasoning.effort=high");
}

async function testBodyEffortMedium() {
  const raw: OpenRouterReasoningConfig = { effort: "medium" };
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  assert.ok(body.reasoning);
  assert.equal(body.reasoning.effort, "medium");
  console.log("  ✓ body: effort=medium => reasoning.effort=medium");
}

async function testBodyMaxTokens() {
  const raw: OpenRouterReasoningConfig = { maxTokens: 2048 };
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  assert.ok(body.reasoning);
  assert.equal(body.reasoning.max_tokens, 2048);
  console.log("  ✓ body: maxTokens=2048 => reasoning.max_tokens=2048");
}

async function testBodyEffortAndMaxTokensPriority() {
  const raw: OpenRouterReasoningConfig = { effort: "high", maxTokens: 2048 };
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  assert.ok(body.reasoning);
  assert.equal(body.reasoning.max_tokens, 2048);
  assert.equal(body.reasoning.effort, undefined, "effort should not be in body when maxTokens is present");
  console.log("  ✓ body: effort+maxTokens => max_tokens only, no effort");
}

async function testBodyExclude() {
  const raw: OpenRouterReasoningConfig = { exclude: true };
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  assert.ok(body.reasoning);
  assert.equal(body.reasoning.exclude, true);
  console.log("  ✓ body: exclude=true => reasoning.exclude=true");
}

async function testBodyExcludeFalse() {
  const raw: OpenRouterReasoningConfig = { exclude: false };
  const normalized = normalizeOpenRouterReasoning(raw);
  const body = await captureRequestBody(normalized);
  // exclude=false should not be included; default effort=high still applies
  assert.ok(body.reasoning);
  assert.equal(body.reasoning.effort, "high");
  assert.equal(body.reasoning.exclude, undefined, "exclude=false should not be in body");
  console.log("  ✓ body: exclude=false => reasoning.effort=high, no exclude");
}

async function testBackwardCompatibilityExistingFields() {
  const normalized = normalizeOpenRouterReasoning({ enabled: true, effort: "high" });
  const body = await captureRequestBody(normalized, 777);
  assert.equal(body.model, "test-model");
  assert.equal(body.max_tokens, 777);
  assert.equal(body.temperature, 0.4);
  assert.equal(body.reasoning?.effort, "high");
  console.log("  ✓ backward compatibility: existing fields unchanged");
}

// ─── Main ───

async function main() {
  console.log("Running v0.4.4 reasoning enable tests...\n");

  console.log("normalizeOpenRouterReasoning:");
  testNormalizeDefaults();
  testNormalizeDisabled();
  testNormalizeEffortMedium();
  testNormalizeMaxTokens();
  testNormalizeEffortAndMaxTokens();
  testNormalizeExclude();
  testNormalizeExcludeFalse();
  testNormalizeInvalidMaxTokensZero();
  testNormalizeInvalidMaxTokensNegative();
  testNormalizeInvalidMaxTokensFloat();
  testNormalizeUndefined();
  testNormalizeEmptyObject();
  testNormalizeEnabledNoEffort();

  console.log("\nRequest body construction:");
  await testBodyDefaultEffortHigh();
  await testBodyDisabled();
  await testBodyEnabledNoEffortDefaultsHigh();
  await testBodyEmptyObjectDefaultsHigh();
  await testBodyEffortMedium();
  await testBodyMaxTokens();
  await testBodyEffortAndMaxTokensPriority();
  await testBodyExclude();
  await testBodyExcludeFalse();

  console.log("\nBackward compatibility:");
  await testBackwardCompatibilityExistingFields();

  console.log("\n✅ All reasoning tests passed.");
}

main().catch((err) => {
  console.error("❌ Reasoning tests failed:", err);
  process.exit(1);
});
