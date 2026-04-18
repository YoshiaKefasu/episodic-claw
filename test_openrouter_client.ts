import assert from "node:assert/strict";
import { OpenRouterClient, OpenRouterError } from "./src/openrouter-client";

type FetchResponseInit = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function createClient(): OpenRouterClient {
  return new OpenRouterClient({
    apiKey: "test-key",
    model: "openrouter/free",
    temperature: 0.4,
    timeoutMs: 3000,
    maxRetries: 1,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    baseUrl: "https://example.com/api/v1",
  });
}

async function withMockFetch(
  responses: FetchResponseInit[],
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = (async () => {
    const next = responses[Math.min(callCount, responses.length - 1)];
    callCount++;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: {
        "Content-Type": "application/json",
        ...(next.headers ?? {}),
      },
    });
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testOpenRouterErrorShape() {
  const err = new OpenRouterError({
    message: "x",
    errorClass: "provider_503",
    retriable: true,
    retryAfterSeconds: 2,
    providerErrorCode: 503,
    providerName: "test-provider",
  });

  assert.equal(err.openRouterErrorClass, "provider_503");
  assert.equal(err.retriable, true);
  assert.equal(err.retryAfterSeconds, 2);
  assert.equal(err.providerErrorCode, 503);
  assert.equal(err.providerName, "test-provider");
  console.log("  ✓ OpenRouterError keeps typed fields");
}

async function testRetryOnWrapped503ThenSuccess() {
  const client = createClient();
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => {
    fetchCalls++;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        error: {
          message: "Provider returned error",
          code: 503,
          metadata: { provider_name: "provider-a" },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok narrative" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const out = await client.chatCompletion({ systemPrompt: "sys", userMessage: "user" });
    assert.equal(out, "ok narrative");
    assert.equal(fetchCalls, 2);
    console.log("  ✓ wrapped 503 is retried and then succeeds");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testWrapped400IsNonRetriable() {
  const client = createClient();
  await withMockFetch(
    [
      {
        status: 200,
        body: {
          error: {
            message: "Developer instruction is not enabled for models/gemma-3n-e4b-it",
            code: 400,
          },
        },
      },
    ],
    async () => {
      await assert.rejects(
        () => client.chatCompletion({ systemPrompt: "sys", userMessage: "user" }),
        (err: unknown) => {
          assert.ok(err instanceof OpenRouterError);
          assert.equal(err.openRouterErrorClass, "provider_400_policy");
          assert.equal(err.retriable, false);
          return true;
        },
      );
      console.log("  ✓ wrapped 400 policy error is non-retriable");
    },
  );
}

async function testMissingChoicesClassified() {
  const client = new OpenRouterClient({
    apiKey: "test-key",
    model: "openrouter/free",
    temperature: 0.4,
    timeoutMs: 3000,
    maxRetries: 0,
    baseRetryDelayMs: 0,
    maxRetryDelayMs: 0,
    baseUrl: "https://example.com/api/v1",
  });

  await withMockFetch(
    [{ status: 200, body: {} }],
    async () => {
      await assert.rejects(
        () => client.chatCompletion({ systemPrompt: "sys", userMessage: "user" }),
        (err: unknown) => {
          assert.ok(err instanceof OpenRouterError);
          assert.equal(err.openRouterErrorClass, "missing_choices");
          assert.equal(err.retriable, true);
          return true;
        },
      );
      console.log("  ✓ missing choices classified as retriable error");
    },
  );
}

async function main() {
  console.log("\n=== OpenRouter Client Tests (v0.4.19d) ===");
  await testOpenRouterErrorShape();
  await testRetryOnWrapped503ThenSuccess();
  await testWrapped400IsNonRetriable();
  await testMissingChoicesClassified();
  console.log("\n✅ test_openrouter_client.ts passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
