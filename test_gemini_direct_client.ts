import assert from "node:assert/strict";
import { GeminiDirectClient, GeminiDirectError } from "./src/gemini-direct-client";

async function testOmitsSystemInstructionWhenEmpty() {
  const client = new GeminiDirectClient("test-api-key", 3000, { temperature: 0.4 });

  let capturedBody: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "narrative output" }] } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await client.generateNarrative({ systemPrompt: "", userMessage: "user content" });
    assert.equal(result, "narrative output");
    assert.ok(capturedBody, "should have captured request body");
    assert.equal(capturedBody.systemInstruction, undefined, "systemInstruction should be absent when system prompt is empty");
    assert.ok(capturedBody.contents, "contents should be present");
    assert.equal(capturedBody.contents.length, 1);
    assert.equal(capturedBody.contents[0].role, "user");
    console.log("  ✓ empty system prompt omits systemInstruction entirely");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testIncludesSystemInstructionWhenNonEmpty() {
  const client = new GeminiDirectClient("test-api-key", 3000, { temperature: 0.4 });

  let capturedBody: any = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "narrative output" }] } }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const result = await client.generateNarrative({ systemPrompt: "system instruction", userMessage: "user content" });
    assert.equal(result, "narrative output");
    assert.ok(capturedBody, "should have captured request body");
    assert.ok(capturedBody.systemInstruction, "systemInstruction should be present when non-empty");
    assert.deepEqual(capturedBody.systemInstruction, { parts: [{ text: "system instruction" }] });
    assert.ok(capturedBody.contents, "contents should be present");
    assert.equal(capturedBody.contents.length, 1);
    assert.equal(capturedBody.contents[0].role, "user");
    console.log("  ✓ non-empty system prompt includes systemInstruction");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function main() {
  console.log("\n=== Gemini Direct Client Tests (v0.5.1) ===");
  await testOmitsSystemInstructionWhenEmpty();
  await testIncludesSystemInstructionWhenNonEmpty();
  console.log("\n✅ test_gemini_direct_client.ts passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
