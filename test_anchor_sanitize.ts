/**
 * test_anchor_sanitize.ts  (v3 — retriever loaded from the same tempDist as index)
 *
 * UC-1: normalizePromptAnchor() E2/E3 end-to-end
 * UC-2: Telegram metadata format variants (BS-3 case-insensitive JSON)
 * UC-3: Full pipeline — contaminated prompt → clean anchor → clean query keywords
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, Module } from "node:module";

// ── Loader ────────────────────────────────────────────────────────────────
function loadModules(): {
  normalizePromptAnchor: (prompt: unknown) => {
    latestUserAnchor: string;
    anchorAcceptedReason: string;
    anchorRejectedReason: string;
    anchorSanitizeApplied: boolean;
    anchorSanitizedLength: number;
    anchorSanitizeDroppedMetadata: boolean;
  };
  stripUntrustedMetadataBlocks: (text: string) => string;
  EpisodicRetriever: any;
} {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ep-anchor-test-"));
  const tempDist = path.join(tempRoot, "dist");
  fs.mkdirSync(tempDist, { recursive: true });

  const allFiles = [
    "index.js","large-payload.js","untrusted-metadata.js","retriever.js","config.js",
    "anchor-store.js","archiver.js","compactor.js","cjk-tokenizer.js","lang-detect.js",
    "narrative-worker.js","gemini-direct-client.js","narrative-pool.js","narrative-queue.js",
    "openrouter-client.js","reasoning-tags.js","rpc-client.js","runtime-mode.js",
    "segmenter.js","summary-escalation.js","transcript-repair.js","types.js","utils.js",
  ];
  for (const file of allFiles) {
    const src = path.resolve("dist", file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tempDist, file));
  }

  // Stubs for ESM-only / heavy dependencies
  fs.writeFileSync(path.join(tempDist, "lang-detect.js"), `"use strict";
Object.defineProperty(exports,"__esModule",{value:true});
exports.initLanguageDetector=async function(){return true;};
exports.detectLanguage=function(_t){return"unknown";};
exports.detectLanguageDetailed=function(_t){return{lang:"unknown",confidence:0,isReliable:false};};
`);
  fs.writeFileSync(path.join(tempDist, "cjk-tokenizer.js"), `"use strict";
Object.defineProperty(exports,"__esModule",{value:true});
exports.tokenizeCjk=async function(text){
  const m=text.match(/[\\u4e00-\\u9fff\\u3040-\\u30ff]{2,}/g)||[];
  return{keywords:m.slice(0,10),lang:"ja"};
};
`);
  fs.writeFileSync(path.join(tempDist, "rpc-client.js"), `"use strict";
class E{async start(){}async stop(){}async startWatcher(){return"ok";}async recall(){return[];}async recallFeedback(){return"ok";}async batchIngest(){return[];}async getWatermark(){return{dateSeq:"20260101-0",absIndex:0};}async setWatermark(){}async setMeta(){}async triggerBackgroundIndex(){return"ok";}async rebuildIndex(){return"ok";}async segmentScore(){return{isBoundary:false};}}
class F{constructor(){}}
module.exports={EpisodicCoreClient:E,FileEventDebouncer:F};
`);

  process.env.NODE_PATH = path.resolve("node_modules");
  (Module as any)._initPaths();
  delete (globalThis as any)[Symbol.for("__episodic_claw_singleton__")];

  const requireFn = createRequire(path.join(tempDist, "index.js"));
  const indexMod = requireFn(path.join(tempDist, "index.js"));
  const helperMod = requireFn(path.join(tempDist, "untrusted-metadata.js"));
  const retrieverMod = requireFn(path.join(tempDist, "retriever.js"));

  return {
    normalizePromptAnchor: indexMod.normalizePromptAnchor,
    stripUntrustedMetadataBlocks: helperMod.stripUntrustedMetadataBlocks,
    EpisodicRetriever: retrieverMod.EpisodicRetriever,
  };
}

// ── Test runner ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

// ── Load ──────────────────────────────────────────────────────────────────
const { normalizePromptAnchor, stripUntrustedMetadataBlocks, EpisodicRetriever } = loadModules();
assert.ok(typeof normalizePromptAnchor === "function", "normalizePromptAnchor must be exported");

async function main(): Promise<void> {

  // === UC-1: normalizePromptAnchor() E2/E3 end-to-end ===
  console.log("\n=== UC-1: normalizePromptAnchor() E2/E3 end-to-end ===\n");

  await test("UC-1-A: clean user: block → last_user_block", () => {
    const r = normalizePromptAnchor("user:\nHello world, exam study question");
    assert.ok(r.latestUserAnchor.includes("Hello world"), `Got: ${r.latestUserAnchor}`);
    assert.equal(r.anchorAcceptedReason, "last_user_block");
  });

  await test("UC-1-B: user: block with metadata → metadata stripped, last_user_block_sanitized", () => {
    const c = ["user:","Conversation info (untrusted metadata): ctx","```json",'{"chatId":"abc"}',
               "```","70点合格ラインだとしたらいいんじゃない？"].join("\n");
    const r = normalizePromptAnchor(c);
    assert.ok(r.latestUserAnchor.includes("70点"), `Got: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("chatId"), "chatId must not leak");
    assert.equal(r.anchorAcceptedReason, "last_user_block_sanitized");
    assert.equal(r.anchorSanitizeDroppedMetadata, true);
  });

  await test("UC-1-C: metadata-only (no user: block) → empty anchor, rejected", () => {
    const c = ["Conversation info (untrusted metadata): ctx","```json",'{"chatId":"x"}',
               "```","Sender (untrusted metadata): info","```json",'{"firstName":"A"}', "```"].join("\n");
    const r = normalizePromptAnchor(c);
    assert.equal(r.latestUserAnchor, "", `Got: ${r.latestUserAnchor}`);
    assert.ok(r.anchorRejectedReason !== "", `Expected rejection, got: ${r.anchorRejectedReason}`);
    // The rejection reason may be empty_after_normalization (all content stripped in E3/E2)
    assert.ok(!r.latestUserAnchor.includes("chatId"), "chatId must not leak");
  });

  await test("UC-1-D: no user: block, metadata + user text → user text extracted, no metadata", () => {
    const c = ["Conversation info (untrusted metadata): data","```json",'{"chatId":"abc"}',"```",
               "Sender (untrusted metadata): info","```json",'{"userId":"u1"}',"```",
               "今日の漢字テストで合格ラインを超えられた！"].join("\n");
    const r = normalizePromptAnchor(c);
    assert.ok(r.latestUserAnchor.includes("合格ライン"), `Got: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("chatId"), "chatId must not leak");
    assert.ok(r.anchorAcceptedReason !== "", `Expected acceptance reason`);
  });

  await test("UC-1-E: clean prompt, no user: block → raw_prompt_fallback", () => {
    const r = normalizePromptAnchor("What should I review before tomorrow's exam?");
    assert.ok(r.latestUserAnchor.length >= 3, `Got: ${r.latestUserAnchor}`);
    assert.equal(r.anchorAcceptedReason, "raw_prompt_fallback");
  });

  await test("UC-1-F: non-string → missing_or_non_string_prompt, sanitizeApplied=false", () => {
    const r = normalizePromptAnchor(null);
    assert.equal(r.latestUserAnchor, "");
    assert.equal(r.anchorRejectedReason, "missing_or_non_string_prompt");
    assert.equal(r.anchorSanitizeApplied, false);
  });

  await test("UC-1-G: multiple user: blocks → latest block wins, metadata stripped from it", () => {
    const c = ["user:","Conversation info (untrusted metadata): old","```json",'{"chatId":"old"}',"```",
               "assistant:","OK",
               "user:","今日の問題を解いてみた"].join("\n");
    const r = normalizePromptAnchor(c);
    assert.ok(r.latestUserAnchor.includes("今日の問題"), `Got: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("chatId"), "metadata must not leak");
  });

  await test("UC-1-H: user: block with ONLY metadata content → empty after E2 sanitize → rejected", () => {
    const c = ["user:","Conversation info (untrusted metadata): data","```json",'{"chatId":"x"}',"```"].join("\n");
    const r = normalizePromptAnchor(c);
    assert.equal(r.latestUserAnchor, "", `Got: ${r.latestUserAnchor}`);
    assert.ok(r.anchorRejectedReason !== "", "Expected rejection reason");
  });

  // === UC-2: Telegram metadata format variants (BS-3) ===
  console.log("\n=== UC-2: Telegram metadata format variants ===\n");

  await test("UC-2-A: Conversation info (untrusted sender): → stripped", () => {
    const r = stripUntrustedMetadataBlocks("Conversation info (untrusted sender): Alice\n本文テキスト");
    assert.ok(!r.includes("Conversation info"), `got: ${r}`);
    assert.ok(r.includes("本文テキスト"));
  });

  await test("UC-2-B: Sender (untrusted, from Telegram): → stripped", () => {
    const r = stripUntrustedMetadataBlocks("Sender (untrusted, from Telegram): Bob\n本文テキスト");
    assert.ok(!r.includes("Sender"), `got: ${r}`);
    assert.ok(r.includes("本文テキスト"));
  });

  await test("UC-2-C: Replied message (untrusted, for context): → stripped", () => {
    const r = stripUntrustedMetadataBlocks("Replied message (untrusted, for context): prev\n本文テキスト");
    assert.ok(!r.includes("Replied message"), `got: ${r}`);
    assert.ok(r.includes("本文テキスト"));
  });

  await test("UC-2-D: UPPERCASE header → stripped (i flag)", () => {
    const r = stripUntrustedMetadataBlocks("CONVERSATION INFO (UNTRUSTED METADATA): data\n本文テキスト");
    assert.ok(!r.toUpperCase().includes("CONVERSATION INFO"), `got: ${r}`);
    assert.ok(r.includes("本文テキスト"));
  });

  await test("UC-2-E: ```JSON (uppercase) fenced block → stripped (BS-3)", () => {
    const r = stripUntrustedMetadataBlocks(
      "Conversation info (untrusted metadata): x\n```JSON\n{\"chatId\":\"LEAK\"}\n```\n本文"
    );
    assert.ok(!r.includes("LEAK"), `chatId must not leak with uppercase JSON tag, got: ${r}`);
    assert.ok(r.includes("本文"));
  });

  await test("UC-2-F: ```Json (mixed case) → stripped (BS-3)", () => {
    const r = stripUntrustedMetadataBlocks(
      "Sender (untrusted metadata): x\n```Json\n{\"uid\":\"LEAK2\"}\n```\n本文"
    );
    assert.ok(!r.includes("LEAK2"), `uid must not leak with mixed-case Json tag, got: ${r}`);
    assert.ok(r.includes("本文"));
  });

  await test("UC-2-G: all 3 header types in one prompt → all stripped, user content preserved", () => {
    const full = [
      "Conversation info (untrusted metadata): chat","```json",'{"chatId":"c1"}',"```",
      "Sender (untrusted, from Telegram): user","```json",'{"userId":"u1"}',"```",
      "Replied message (untrusted, for context): prev","```json",'{"text":"prev"}',"```",
      "ユーザーの本物のメッセージ",
    ].join("\n");
    const r = stripUntrustedMetadataBlocks(full);
    assert.ok(!r.includes("chatId") && !r.includes("userId"), `metadata leaked: ${r}`);
    assert.ok(r.includes("ユーザーの本物のメッセージ"), `user content missing: ${r}`);
  });

  // === UC-3: Full pipeline ===
  console.log("\n=== UC-3: Full pipeline query contamination prevention ===\n");

  await test("UC-3-A: contaminated user: block → clean anchor → clean retriever query", async () => {
    const contaminated = [
      "user:",
      "Conversation info (untrusted metadata): chat ctx",
      "```json",
      '{"chatId":"CONTAMINATION_RISK","platform":"telegram","messageId":9999}',
      "```",
      "今日の漢字テストを復習したい",
    ].join("\n");

    const ar = normalizePromptAnchor(contaminated);
    assert.ok(!ar.latestUserAnchor.includes("CONTAMINATION_RISK"), `anchor contains chatId: ${ar.latestUserAnchor}`);
    assert.ok(ar.latestUserAnchor.includes("漢字テスト"), `anchor should have user intent: ${ar.latestUserAnchor}`);

    let capturedQuery = "";
    const mockClient = {
      async recall(q: string) { capturedQuery = q; return []; },
      async recallFeedback() { return "ok"; },
    };
    const retriever = new EpisodicRetriever(mockClient as any, undefined);
    await retriever.retrieveRelevantContext(
      [{ role: "user", content: "今日の漢字テストを復習したい" } as any],
      "/tmp/episodes", 5, 2048,
      { latestUserAnchor: ar.latestUserAnchor }
    );
    assert.ok(!capturedQuery.includes("CONTAMINATION_RISK"), `chatId leaked to query: ${capturedQuery}`);
    assert.ok(!capturedQuery.includes("telegram"), `platform leaked to query: ${capturedQuery}`);
  });

  await test("UC-3-B: metadata-only prompt → empty anchor → no metadata in retriever query", async () => {
    const metadataOnly = [
      "Conversation info (untrusted metadata): context",
      "```JSON",
      '{"chatId":"SHOULD_NOT_APPEAR","platform":"telegram"}',
      "```",
    ].join("\n");

    const ar = normalizePromptAnchor(metadataOnly);
    assert.equal(ar.latestUserAnchor, "", "metadata-only must produce empty anchor");

    let capturedQuery = "";
    const mockClient = {
      async recall(q: string) { capturedQuery = q; return []; },
      async recallFeedback() { return "ok"; },
    };
    const retriever = new EpisodicRetriever(mockClient as any, undefined);
    await retriever.retrieveRelevantContext(
      [{ role: "user", content: "漢字の勉強をしたい" } as any],
      "/tmp/episodes", 5, 2048,
      { latestUserAnchor: ar.latestUserAnchor }
    );
    assert.ok(!capturedQuery.includes("SHOULD_NOT_APPEAR"), `chatId leaked: ${capturedQuery}`);
    assert.ok(!capturedQuery.includes("telegram"), `platform leaked: ${capturedQuery}`);
  });

  await test("UC-3-C: message with metadata+json → E4a strips json → no json content in query", async () => {
    const contaminatedMsg = [
      "Conversation info (untrusted metadata): platform data",
      "```json",
      '{"chatId":"QUERY_LEAK_MARKER","platform":"contamination","secret":"shouldNotAppear"}',
      "```",
      "漢字テスト対策",
    ].join("\n");

    let capturedQuery = "";
    const mockClient = {
      async recall(q: string) { capturedQuery = q; return []; },
      async recallFeedback() { return "ok"; },
    };
    const retriever = new EpisodicRetriever(mockClient as any, undefined);
    await retriever.retrieveRelevantContext(
      [{ role: "user", content: contaminatedMsg } as any],
      "/tmp/episodes", 5, 2048
    );
    assert.ok(!capturedQuery.includes("QUERY_LEAK_MARKER"), `marker leaked: ${capturedQuery}`);
    assert.ok(!capturedQuery.includes("contamination"), `platform leaked: ${capturedQuery}`);
    assert.ok(!capturedQuery.includes("shouldNotAppear"), `secret leaked: ${capturedQuery}`);
  });

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(60)}`);
  console.log(`v0.4.28e uncertainty coverage: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("SOME TESTS FAILED");
    process.exit(1);
  }
  console.log("ALL TESTS PASSED ✅");
}

main().catch(err => { console.error(err); process.exit(1); });
