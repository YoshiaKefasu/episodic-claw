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
    "openrouter-client.js","reasoning-tags.js","rpc-client.js","env-var.js","runtime-mode.js","bug1-registration-origin.js",
    "segmenter.js","summary-escalation.js","transcript-repair.js","transport-retry.js","types.js","utils.js",
    "episode-extract.js","snapshot-guardrail.js","snapshot-file-writer.js","snapshot-worker.js","snapshot-scheduler.js",
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

  // === UC-4: v0.4.29a — caption rescue in normalizePromptAnchor ===
  console.log("\n=== UC-4: v0.4.29a media caption rescue ===\n");

  await test("UC-4-A: [media attached: /path] + caption → anchor is caption only (AC-1)", () => {
    const prompt = [
      "[media attached: /home/user/.openclaw/media/file_401---dd478bbb-1234.jpg | /tmp/cache/img.jpg]",
      "To send an image back, prefer using a URL. Keep caption in the text body.",
      "合格ライン70点だったらいいね！",
    ].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("合格ライン"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media attached"), `media header leaked: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("/home/user"), `file path leaked: ${r.latestUserAnchor}`);
    assert.equal(r.anchorAcceptedReason, "raw_prompt_caption_rescue", `reason: ${r.anchorAcceptedReason}`);
  });

  await test("UC-4-B: [media attached: N files] only (no caption) → anchor empty (AC-4)", () => {
    const prompt = "[media attached: 2 files]";
    const r = normalizePromptAnchor(prompt);
    assert.equal(r.latestUserAnchor, "", `should be empty, got: ${r.latestUserAnchor}`);
    assert.ok(r.anchorRejectedReason !== "", `expected rejection, got: ${r.anchorRejectedReason}`);
  });

  await test("UC-4-C: [media attached] + metadata + caption → caption only, no metadata (AC-1, AC-3)", () => {
    const prompt = [
      "Conversation info (untrusted metadata): platform info",
      "```json",
      '{"chatId":"LEAK_RISK","platform":"telegram"}',
      "```",
      "[media attached: /home/user/img.jpg]",
      "To send an image back, prefer using a URL. Keep caption in the text body.",
      "今日の漢字テスト頑張った！",
    ].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("漢字テスト"), `caption not found: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("LEAK_RISK"), `chatId leaked: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media attached"), `media header leaked: ${r.latestUserAnchor}`);
  });

  await test("UC-4-D: query must not contain [media attached: ...] (AC-2)", async () => {
    const prompt = [
      "[media attached: /home/user/img.jpg]",
      "To send an image back, prefer using a URL. Keep caption in the text body.",
      "試験問題を解いてみた",
    ].join("\n");
    const ar = normalizePromptAnchor(prompt);
    let capturedQuery = "";
    const mockClient = {
      async recall(q: string) { capturedQuery = q; return []; },
      async recallFeedback() { return "ok"; },
    };
    const retriever = new EpisodicRetriever(mockClient as any, undefined);
    await retriever.retrieveRelevantContext(
      [{ role: "user", content: prompt } as any],
      "/tmp/episodes", 5, 2048,
      { latestUserAnchor: ar.latestUserAnchor }
    );
    assert.ok(!capturedQuery.includes("media attached"), `media header leaked to query: ${capturedQuery}`);
    assert.ok(!capturedQuery.includes("media://inbound"), `media URI leaked to query: ${capturedQuery}`);
  });

  // === UC-5: v0.4.29a BS-29A blind spot regression ===
  console.log("\n=== UC-5: v0.4.29a BS-29A blind spot regression ===\n");

  await test("UC-5-A: bare media:image (Gateway WebUI) + caption → anchor is caption only", () => {
    const prompt = ["media:image", "試験問題を解いてみた"].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("試験問題"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media:image"), `media type leaked: ${r.latestUserAnchor}`);
  });

  await test("UC-5-B: bare media:document + caption → anchor is caption only", () => {
    const prompt = ["media:document", "資料を送ります。内容を確認して"].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("資料"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media:document"), `media type leaked: ${r.latestUserAnchor}`);
  });

  await test("UC-5-C: bare media:image only (no caption) → anchor empty", () => {
    const prompt = "media:image";
    const r = normalizePromptAnchor(prompt);
    assert.equal(r.latestUserAnchor, "", `should be empty, got: ${r.latestUserAnchor}`);
    assert.ok(r.anchorRejectedReason !== "", `expected rejection`);
  });

  // === UC-6: v0.4.29a BS-29A-3 — role-labeled path media header rescue ===
  console.log("\n=== UC-6: v0.4.29a BS-29A-3 role-labeled path ===\n");

  await test("UC-6-A: user: block with [media attached: /path] + caption → caption only", () => {
    const prompt = [
      "user:",
      "[media attached: /home/user/img.jpg]",
      "To send an image back, prefer using a URL. Keep caption in the text body.",
      "合格ラインを超えた！",
    ].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("合格ライン"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media attached"), `media header leaked: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("/home/user"), `file path leaked: ${r.latestUserAnchor}`);
    // [BS-29B-2] role-labeled + caption rescue → reason should be last_user_block_caption_rescue
    assert.equal(r.anchorAcceptedReason, "last_user_block_caption_rescue", `reason: ${r.anchorAcceptedReason}`);
  });

  await test("UC-6-B: user: block with media-only (no caption) → rejected", () => {
    const prompt = ["user:", "[media attached: 3 files]"].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.equal(r.latestUserAnchor, "", `should be empty, got: ${r.latestUserAnchor}`);
    assert.ok(r.anchorRejectedReason !== "", `expected rejection, got: ${r.anchorRejectedReason}`);
  });

  await test("UC-6-C: multi-turn transcript with media in user: block → caption extracted", () => {
    const prompt = [
      "assistant:",
      "了解です。",
      "user:",
      "[media attached: /home/user/doc.pdf]",
      "To send an image back, prefer using a URL. Keep caption in the text body.",
      "この資料を確認してほしい",
    ].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("資料"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media attached"), `media header leaked: ${r.latestUserAnchor}`);
  });

  // === UC-7: v0.4.29b BS-29A-2 — MIME annotation rescue ===
  console.log("\n=== UC-7: v0.4.29b BS-29A-2 MIME annotation rescue ===\n");

  await test("UC-7-A: (image/jpeg) + caption → anchor is caption only (AC-1)", () => {
    const prompt = ["(image/jpeg)", "今日の漢字テスト、合格した！"].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("合格した"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("image/jpeg"), `MIME annotation leaked: ${r.latestUserAnchor}`);
  });

  await test("UC-7-B: (image/jpeg) only (no caption) → anchor empty (AC-2)", () => {
    const prompt = "(image/jpeg)";
    const r = normalizePromptAnchor(prompt);
    assert.equal(r.latestUserAnchor, "", `should be empty, got: ${r.latestUserAnchor}`);
    assert.ok(r.anchorRejectedReason !== "", `expected rejection, got: ${r.anchorRejectedReason}`);
  });

  await test("UC-7-C: user: block with (image/jpeg) + caption → caption only (AC-3)", () => {
    const prompt = ["user:", "(image/jpeg)", "明日の準備が終わった"].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("明日"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("image/jpeg"), `MIME annotation leaked: ${r.latestUserAnchor}`);
  });

  // === UC-8: v0.4.29b BS-29B blind spot regression ===
  console.log("\n=== UC-8: v0.4.29b BS-29B blind spot regression ===\n");

  await test("UC-8-A: clean text (no media) → reason is raw_prompt_fallback, not caption_rescue (BS-29B-1 guard)", () => {
    const prompt = "明日の試験に向けて復習しておく";
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("復習"), `clean text lost: ${r.latestUserAnchor}`);
    assert.ok(r.anchorAcceptedReason !== "raw_prompt_caption_rescue", `false rescue on clean text: ${r.anchorAcceptedReason}`);
    assert.equal(r.anchorAcceptedReason, "raw_prompt_fallback", `reason: ${r.anchorAcceptedReason}`);
  });

  await test("UC-8-B: user: block clean text → reason is last_user_block, not caption_rescue (BS-29B-1 guard)", () => {
    const prompt = ["user:", "今日の宿題が終わった"].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("宿題"), `clean text lost: ${r.latestUserAnchor}`);
    assert.equal(r.anchorAcceptedReason, "last_user_block", `reason: ${r.anchorAcceptedReason}`);
  });

  await test("UC-8-C: user: block with media rescue → reason is last_user_block_caption_rescue (BS-29B-2)", () => {
    const prompt = ["user:", "(image/jpeg)", "テスト結果が届いた"].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("テスト結果"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.equal(r.anchorAcceptedReason, "last_user_block_caption_rescue", `reason: ${r.anchorAcceptedReason}`);
  });

  // === UC-9: Messages API pipeline simulation (extractText → normalizePromptAnchor) ===
  // Verifies that extractPlainText (content block format) preserves media markers
  // intact before they reach normalizePromptAnchor — confirming the pipeline is safe.
  console.log("\n=== UC-9: Messages API pipeline (content block → anchor) ===\n");

  // Helper: simulate extractPlainText behaviour inline
  // (mirrors large-payload.ts L19-41: join block.text values)
  function simulateExtractText(blocks: Array<{ type: string; text?: string }>): string {
    return blocks
      .filter(b => b.type !== "thinking" && b.type !== "reasoning")
      .map(b => b.text ?? "")
      .filter(Boolean)
      .join(" ");
  }

  await test("UC-9-A: content blocks with [media attached] + caption → caption only after pipeline", () => {
    // Simulates: user sends image in Messages API format
    const blocks = [
      { type: "text", text: "[media attached: /home/user/photo.jpg]\nTo send an image back, prefer using a URL. Keep caption in the text body.\n今日の授業ノートを送ります" },
    ];
    const rawText = simulateExtractText(blocks);
    const r = normalizePromptAnchor(rawText);
    assert.ok(r.latestUserAnchor.includes("授業ノート"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media attached"), `media header leaked: ${r.latestUserAnchor}`);
  });

  await test("UC-9-B: content blocks with (image/jpeg) + caption → MIME stripped after pipeline", () => {
    const blocks = [
      { type: "text", text: "(image/jpeg)\n来週のスケジュールを確認したい" },
    ];
    const rawText = simulateExtractText(blocks);
    const r = normalizePromptAnchor(rawText);
    assert.ok(r.latestUserAnchor.includes("スケジュール"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("image/jpeg"), `MIME annotation leaked: ${r.latestUserAnchor}`);
  });

  await test("UC-9-C: thinking block is ignored, text block with media is rescued", () => {
    // thinking blocks are filtered out by extractPlainText
    const blocks = [
      { type: "thinking", text: "This should be ignored" },
      { type: "text", text: "[media attached: /path/to/img.png]\nTo send an image back, prefer using a URL. Keep caption in the text body.\n面白い写真だ" },
    ];
    const rawText = simulateExtractText(blocks);
    const r = normalizePromptAnchor(rawText);
    assert.ok(r.latestUserAnchor.includes("写真"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("thinking"), `thinking block leaked: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media attached"), `media header leaked: ${r.latestUserAnchor}`);
  });

  await test("UC-9-D: multi-attachment indexed format [media attached 1/2: ...] + caption → caption only", () => {
    // Verifies indexed multi-attachment format is caught by hasMediaScaffold
    const prompt = [
      "[media attached 1/2: /home/user/photo1.jpg]",
      "[media attached 2/2: /home/user/photo2.jpg]",
      "To send an image back, prefer using a URL. Keep caption in the text body.",
      "2枚とも今日の授業の板書です",
    ].join("\n");
    const r = normalizePromptAnchor(prompt);
    assert.ok(r.latestUserAnchor.includes("板書"), `caption not rescued: ${r.latestUserAnchor}`);
    assert.ok(!r.latestUserAnchor.includes("media attached"), `media header leaked: ${r.latestUserAnchor}`);
  });

  await test("UC-9-E: media-only content block (no caption) → rejected", () => {
    const blocks = [
      { type: "text", text: "[media attached: 3 files]" },
    ];
    const rawText = simulateExtractText(blocks);
    const r = normalizePromptAnchor(rawText);
    assert.equal(r.latestUserAnchor, "", `should be empty, got: ${r.latestUserAnchor}`);
    assert.ok(r.anchorRejectedReason !== "", `expected rejection: ${r.anchorRejectedReason}`);
  });

  await test("UC-9-F: clean text content block (no media) → passthrough unchanged", () => {
    const blocks = [
      { type: "text", text: "明日の数学のテスト範囲を教えて" },
    ];
    const rawText = simulateExtractText(blocks);
    const r = normalizePromptAnchor(rawText);
    assert.ok(r.latestUserAnchor.includes("数学"), `clean text lost: ${r.latestUserAnchor}`);
    assert.equal(r.anchorAcceptedReason, "raw_prompt_fallback", `reason: ${r.anchorAcceptedReason}`);
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
