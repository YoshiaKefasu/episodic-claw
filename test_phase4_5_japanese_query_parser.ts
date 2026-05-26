import assert from "node:assert/strict";

import { EpisodicRetriever, instantDeterministicRewrite } from "./src/retriever";
import type { EpisodicCoreClient } from "./src/rpc-client";
import type { EpisodicPluginConfig } from "./src/types";
import type { JapaneseQueryParseResult } from "./src/types";
import type { Message } from "./src/segmenter";

type GoFallbackInvoker = {
  buildRecallQueryWithGoFallback(recentMessages: Message[]): Promise<string>;
};

function asGoFallbackInvoker(retriever: EpisodicRetriever): GoFallbackInvoker {
  return retriever as unknown as GoFallbackInvoker;
}

function createMessage(text: string): Message {
  return { role: "user", content: text };
}

function createParseResult(overrides: Partial<JapaneseQueryParseResult> = {}): JapaneseQueryParseResult {
  return {
    segments: [
      { text: "一番", reading: "一番", lemma: "一番", kind: "content", start: 0, end: 6 },
      { text: "安全", reading: "安全", lemma: "安全", kind: "content", start: 6, end: 12 },
      { text: "強い", reading: "強い", lemma: "強い", kind: "content", start: 12, end: 18 },
    ],
    keywords: ["一番", "安全", "強い", "案", "これ"],
    elapsedMs: 12,
    timedOut: false,
    source: "go-japanese-query-parser",
    ...overrides,
  };
}

function createRetriever(parseJapaneseQuery: (text: string, maxMs: number) => Promise<JapaneseQueryParseResult>, config: EpisodicPluginConfig = {}): EpisodicRetriever {
  const mockRpcClient = {
    parseJapaneseQuery,
  } as unknown as EpisodicCoreClient;
  return new EpisodicRetriever(mockRpcClient, config);
}

async function withEnv(name: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

async function testGoFallbackUsesGoWhenSignalIsStrong() {
  let calls = 0;
  const retriever = createRetriever(async () => {
    calls += 1;
    return createParseResult();
  });
  const messages = [createMessage("一番安全で強い案はこれです。")];
  const query = await asGoFallbackInvoker(retriever).buildRecallQueryWithGoFallback(messages);

  assert.equal(query, "一番 安全 強い 案 これ");
  assert.equal(calls, 1);
  console.log("  ✓ Go Japanese parser is used when signal is strong");
}

async function testGoFallbackFallsBackOnLowKeywordCount() {
  let calls = 0;
  const retriever = createRetriever(async () => {
    calls += 1;
    return createParseResult({
      keywords: ["alpha", "beta"],
      elapsedMs: 8,
      timedOut: false,
      source: "go-japanese-query-parser",
    });
  });
  const messages = [createMessage("一番安全で強い案はこれです。")];
  const expectedFallback = await instantDeterministicRewrite(messages, {});
  const query = await asGoFallbackInvoker(retriever).buildRecallQueryWithGoFallback(messages);

  assert.equal(query, expectedFallback);
  assert.equal(calls, 1);
  assert.notEqual(query, "alpha beta");
  console.log("  ✓ low-keyword Go result falls back to TS rewrite");
}

async function testGoFallbackFallsBackOnTimedOutResult() {
  let calls = 0;
  const retriever = createRetriever(async () => {
    calls += 1;
    return createParseResult({
      timedOut: true,
      elapsedMs: 151,
      source: "go-japanese-query-parser",
    });
  });
  const messages = [createMessage("一番安全で強い案はこれです。")];
  const expectedFallback = await instantDeterministicRewrite(messages, {});
  const query = await asGoFallbackInvoker(retriever).buildRecallQueryWithGoFallback(messages);

  assert.equal(query, expectedFallback);
  assert.equal(calls, 1);
  console.log("  ✓ timed-out Go result falls back to TS rewrite");
}

async function testGoFallbackFallsBackOnParserError() {
  let calls = 0;
  const retriever = createRetriever(async () => {
    calls += 1;
    throw new Error("boom");
  });
  const messages = [createMessage("一番安全で強い案はこれです。")];
  const expectedFallback = await instantDeterministicRewrite(messages, {});
  const query = await asGoFallbackInvoker(retriever).buildRecallQueryWithGoFallback(messages);

  assert.equal(query, expectedFallback);
  assert.equal(calls, 1);
  console.log("  ✓ Go parser errors fall back to TS rewrite");
}

async function testGoFallbackKillSwitchBypassesGo() {
  let calls = 0;
  const retriever = createRetriever(async () => {
    calls += 1;
    return createParseResult();
  });
  const messages = [createMessage("一番安全で強い案はこれです。")];

  await withEnv("EPISODIC_DISABLE_GO_JA_QUERY_PARSER", "1", async () => {
    const expectedFallback = await instantDeterministicRewrite(messages, {});
    const query = await asGoFallbackInvoker(retriever).buildRecallQueryWithGoFallback(messages);

    assert.equal(query, expectedFallback);
    assert.equal(calls, 0);
  });

  console.log("  ✓ kill switch bypasses Go parser entirely");
}

export async function runJapaneseQueryParserFallbackTests(): Promise<void> {
  console.log("\n=== Japanese Query Parser Fallback Tests ===");
  await testGoFallbackUsesGoWhenSignalIsStrong();
  await testGoFallbackFallsBackOnLowKeywordCount();
  await testGoFallbackFallsBackOnTimedOutResult();
  await testGoFallbackFallsBackOnParserError();
  await testGoFallbackKillSwitchBypassesGo();
  console.log("✅ test_phase4_5_japanese_query_parser.ts passed");
}
