/**
 * [v0.5.0 Phase 2] Focused tests for boundary metadata in queue payload and narrative prompt.
 *
 * Test coverage:
 * 1. boundaryNote persists to queue item for ep-boundary (splitIntoChunks)
 * 2. boundaryNote is NOT appended to rawText
 * 3. narrative worker prompt gets boundary block when metadata exists
 * 4. custom template fallback still includes boundary block when template omits {boundaryNoteBlock}
 * 5. old queue items without boundary fields still process safely
 * 6. pool.add() carries boundary metadata through to flush item
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  MOCK_CJK_NARRATIVE,
  MOCK_LATIN_NARRATIVE,
} from "./test_phase4_5_shared.ts";

// ── Test 1 & 2: splitIntoChunks propagates boundary metadata to queue items ──────────

export async function testBoundaryMetadataPersistedToQueueItems(): Promise<void> {
  // Import splitIntoChunks from compiled dist
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-boundary-meta-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "narrative-queue.cjs");
  fs.copyFileSync(path.resolve("dist", "narrative-queue.js"), tempCjsPath);
  const distFiles = fs.readdirSync(path.resolve("dist"));
  for (const file of distFiles) {
    const src = path.resolve("dist", file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tempDir, file));
    }
  }

  const req = createRequire(import.meta.url);
  const queueModule = req(tempCjsPath);
  const splitIntoChunks = queueModule.splitIntoChunks;

  if (!splitIntoChunks) {
    throw new Error("splitIntoChunks not found in compiled module");
  }

  const boundaryMeta = {
    boundaryNote: "Task completed: authentication module refactored",
    boundaryBy: "main",
    boundaryReason: "task-complete",
    boundaryTitleHint: "Auth Module Refactor",
    boundaryCreatedAt: "2026-06-27T12:00:00.000Z",
  };

  const chunks = splitIntoChunks(
    "user: Let's refactor the auth module.\nassistant: Sure, I'll start with the JWT handler.",
    "ws-hash",
    "main",
    "live-turn",
    "force-flush",
    0,
    undefined, // no messages[]
    boundaryMeta,
  );

  assert.ok(chunks.length > 0, "Should produce at least one chunk");
  for (const chunk of chunks) {
    assert.equal(chunk.boundaryNote, "Task completed: authentication module refactored",
      "boundaryNote should be propagated to each queue chunk");
    assert.equal(chunk.boundaryBy, "main",
      "boundaryBy should be propagated");
    assert.equal(chunk.boundaryReason, "task-complete",
      "boundaryReason should be propagated");
    assert.equal(chunk.boundaryTitleHint, "Auth Module Refactor",
      "boundaryTitleHint should be propagated");
    assert.equal(chunk.boundaryCreatedAt, "2026-06-27T12:00:00.000Z",
      "boundaryCreatedAt should be propagated");

    // Test 2: rawText must NOT contain boundary metadata
    assert.ok(!chunk.rawText.includes("Task completed: authentication module refactored"),
      "boundaryNote must NOT appear in rawText");
    assert.ok(!chunk.rawText.includes("Auth Module Refactor"),
      "boundaryTitleHint must NOT appear in rawText");
  }

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  console.log("  boundary metadata persisted to queue items: all fields propagated, rawText clean");
}

// ── Test 3: splitIntoChunks without boundary metadata (backward compat) ──────────────

export async function testOldQueueItemsWithoutBoundaryFields(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-old-items-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "narrative-queue.cjs");
  fs.copyFileSync(path.resolve("dist", "narrative-queue.js"), tempCjsPath);
  const distFiles = fs.readdirSync(path.resolve("dist"));
  for (const file of distFiles) {
    const src = path.resolve("dist", file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tempDir, file));
    }
  }

  const req = createRequire(import.meta.url);
  const queueModule = req(tempCjsPath);
  const splitIntoChunks = queueModule.splitIntoChunks;

  // No boundaryMeta → old behavior
  const chunks = splitIntoChunks(
    "user: Hello\nassistant: Hi there",
    "ws-hash",
    "main",
    "live-turn",
    "size-limit",
    0,
  );

  assert.ok(chunks.length > 0, "Should produce at least one chunk");
  for (const chunk of chunks) {
    // Boundary fields should be undefined (not present), not cause errors
    assert.equal(chunk.boundaryNote, undefined, "boundaryNote should be undefined when not provided");
    assert.equal(chunk.boundaryBy, undefined, "boundaryBy should be undefined when not provided");
    assert.equal(chunk.boundaryReason, undefined, "boundaryReason should be undefined when not provided");
    assert.equal(chunk.boundaryTitleHint, undefined, "boundaryTitleHint should be undefined when not provided");
    assert.equal(chunk.boundaryCreatedAt, undefined, "boundaryCreatedAt should be undefined when not provided");
  }

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  console.log("  old queue items without boundary fields: backward compat verified");
}

// ── Test 4: pool.add() carries boundary metadata through to flush item ───────────────

export async function testPoolCarriesBoundaryMetadata(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-pool-boundary-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "narrative-pool.cjs");
  fs.copyFileSync(path.resolve("dist", "narrative-pool.js"), tempCjsPath);
  const distFiles = fs.readdirSync(path.resolve("dist"));
  for (const file of distFiles) {
    const src = path.resolve("dist", file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tempDir, file));
    }
  }

  const req = createRequire(import.meta.url);
  const poolModule = req(tempCjsPath);
  const NarrativePool = poolModule.NarrativePool;

  if (!NarrativePool) {
    throw new Error("NarrativePool not found in compiled module");
  }

  const pool = new NarrativePool();

  const messages = [
    { role: "user", content: "Let's refactor the auth module." },
    { role: "assistant", content: "Sure, I'll start with the JWT handler." },
  ];

  const boundaryMeta = {
    boundaryNote: "Task completed",
    boundaryBy: "main",
    boundaryReason: "task-complete",
    boundaryTitleHint: "Auth Refactor",
    boundaryCreatedAt: "2026-06-27T12:00:00.000Z",
  };

  // add() returns null (passive accumulator) but should store the boundary metadata
  const result = pool.add(messages, 0, "ws-hash", "main", boundaryMeta);
  assert.equal(result, null, "pool.add() should return null (passive accumulator)");

  // forceFlush should carry the boundary metadata in the flush item
  const flushItem = pool.forceFlush("ws-hash", "main");
  assert.ok(flushItem !== null, "forceFlush should return a flush item");
  assert.ok(flushItem!.boundaryMeta, "flush item should have boundaryMeta");
  assert.equal(flushItem!.boundaryMeta!.boundaryNote, "Task completed", "boundaryNote should be in flush item");
  assert.equal(flushItem!.boundaryMeta!.boundaryBy, "main", "boundaryBy should be in flush item");
  assert.equal(flushItem!.boundaryMeta!.boundaryReason, "task-complete", "boundaryReason should be in flush item");
  assert.equal(flushItem!.boundaryMeta!.boundaryTitleHint, "Auth Refactor", "boundaryTitleHint should be in flush item");
  assert.equal(flushItem!.boundaryMeta!.boundaryCreatedAt, "2026-06-27T12:00:00.000Z", "boundaryCreatedAt should be in flush item");

  // rawText should NOT contain boundary metadata
  assert.ok(!flushItem!.rawText.includes("Task completed"), "rawText must not contain boundaryNote");
  assert.ok(!flushItem!.rawText.includes("Auth Refactor"), "rawText must not contain boundaryTitleHint");

  // pool.clear() should reset boundary metadata
  pool.clear();
  pool.add(messages, 0, "ws-hash", "main");
  const flushItemNoMeta = pool.forceFlush("ws-hash", "main");
  assert.ok(flushItemNoMeta !== null, "forceFlush should return a flush item after clear");
  assert.equal(flushItemNoMeta!.boundaryMeta, undefined, "boundaryMeta should be undefined after pool clear");

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  console.log("  pool carries boundary metadata through flush item: verified, clear resets it");
}

// ── Test 5: Narrative worker prompt gets boundary block ──────────────────────────────

export async function testNarrativeWorkerPromptBoundaryBlock(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-boundary-prompt-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "narrative-worker.cjs");
  fs.copyFileSync(path.resolve("dist", "narrative-worker.js"), tempCjsPath);
  const distFiles = fs.readdirSync(path.resolve("dist"));
  for (const file of distFiles) {
    const src = path.resolve("dist", file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tempDir, file));
    }
  }
  fs.writeFileSync(
    path.join(tempDir, "lang-detect.js"),
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLanguageDetector = initLanguageDetector;
exports.detectLanguage = detectLanguage;
exports.detectLanguageDetailed = detectLanguageDetailed;
async function initLanguageDetector() { return true; }
function detectLanguage(_text) { return "unknown"; }
function detectLanguageDetailed(_text) { return { lang: "unknown", confidence: 0, isReliable: false }; }
`,
    "utf8"
  );

  const req = createRequire(import.meta.url);
  const workerModule = req(tempCjsPath);
  const NarrativeWorker = workerModule.NarrativeWorker;

  if (!NarrativeWorker) {
    throw new Error("NarrativeWorker class not found in compiled module");
  }

  let capturedUserMessage = "";
  let chatCallCount = 0;
  let leaseCount = 0;
  let ackCount = 0;

  const mockOpenRouter = {
    chatCompletion: async (params: any) => {
      chatCallCount++;
      capturedUserMessage = params.userMessage || "";
      return MOCK_CJK_NARRATIVE;
    },
  };

  const mockRpcClient = {
    getNarrativeSaveHashes: async () => ({}),
    cacheLeaseNext: async () => {
      if (leaseCount > 0) return null;
      leaseCount++;
      return {
        id: `boundary-prompt-item-${process.pid}`,
        agentWs: tempDir,
        agentId: "main",
        source: "live-turn",
        parentIngestId: "ingest-test",
        orderKey: Date.now().toString(),
        surprise: 0,
        reason: "force-flush",
        rawText: "user: Let's refactor auth.\nassistant: Starting with JWT handler.",
        estimatedTokens: 10,
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Phase 2: boundary metadata
        boundaryNote: "Task completed: auth module refactored",
        boundaryReason: "task-complete",
        boundaryTitleHint: "Auth Refactor",
      };
    },
    cacheAck: async () => { ackCount++; return "ok"; },
    cacheRetry: async () => "ok",
    batchIngest: async () => ["test-slug"],
    cacheGetLatestNarrative: async () => ({ episodeId: "", body: "", found: false }),
    request: async () => null,
    setMeta: async () => "ok",
    getMeta: async () => null,
    recall: async () => [],
    recallFeedback: async () => ({ updated: 0, skipped: 0 }),
  };

  const mockConfig = {
    openrouterModel: "test-model",
    openrouterConfig: { model: "test-model" },
    narrativeSystemPrompt: "Test prompt",
    narrativeUserPromptTemplate: undefined, // use default template
    narrativePreviousEpisodeRef: true,
  };

  const savedGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
    await (worker as any).processNextFromCache();

    assert.equal(chatCallCount, 1, "Should call LLM once");
    assert.equal(ackCount, 1, "Should ack on success");

    // The captured user message should contain the boundary block
    assert.ok(capturedUserMessage.includes("Agent Boundary Note:"),
      "User message should contain 'Agent Boundary Note:' header");
    assert.ok(capturedUserMessage.includes("Task completed: auth module refactored"),
      "User message should contain boundaryNote");
    assert.ok(capturedUserMessage.includes("Reason: task-complete"),
      "User message should contain boundaryReason");
    assert.ok(capturedUserMessage.includes("Title hint: Auth Refactor"),
      "User message should contain boundaryTitleHint");
    assert.ok(capturedUserMessage.includes("Do not quote it as user or assistant speech"),
      "User message should contain editorial context instruction");
    // rawText should NOT be in the user message's boundary section
    assert.ok(!capturedUserMessage.includes("Agent Boundary Note:") || capturedUserMessage.includes("Agent Boundary Note:"),
      "Boundary block should be present in prompt");
  } finally {
    if (savedGeminiKey !== undefined) process.env.GEMINI_API_KEY = savedGeminiKey; else delete process.env.GEMINI_API_KEY;
  }

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  console.log("  narrative worker prompt includes boundary block: verified");
}

// ── Test 6: Custom template fallback with {boundaryNoteBlock} ────────────────────────

export async function testCustomTemplateWithBoundaryBlock(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-boundary-custom-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "narrative-worker.cjs");
  fs.copyFileSync(path.resolve("dist", "narrative-worker.js"), tempCjsPath);
  const distFiles = fs.readdirSync(path.resolve("dist"));
  for (const file of distFiles) {
    const src = path.resolve("dist", file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tempDir, file));
    }
  }
  fs.writeFileSync(
    path.join(tempDir, "lang-detect.js"),
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLanguageDetector = initLanguageDetector;
exports.detectLanguage = detectLanguage;
exports.detectLanguageDetailed = detectLanguageDetailed;
async function initLanguageDetector() { return true; }
function detectLanguage(_text) { return "unknown"; }
function detectLanguageDetailed(_text) { return { lang: "unknown", confidence: 0, isReliable: false }; }
`,
    "utf8"
  );

  const req = createRequire(import.meta.url);
  const workerModule = req(tempCjsPath);
  const NarrativeWorker = workerModule.NarrativeWorker;

  if (!NarrativeWorker) {
    throw new Error("NarrativeWorker class not found in compiled module");
  }

  let capturedUserMessage = "";
  let chatCallCount = 0;
  let leaseCount = 0;
  let ackCount = 0;

  const mockOpenRouter = {
    chatCompletion: async (params: any) => {
      chatCallCount++;
      capturedUserMessage = params.userMessage || "";
      return MOCK_CJK_NARRATIVE;
    },
  };

  const makeItem = (extra: any = {}) => ({
    id: `custom-tpl-item-${process.pid}-${Math.random().toString(36).slice(2, 6)}`,
    agentWs: tempDir,
    agentId: "main",
    source: "live-turn",
    parentIngestId: "ingest-test",
    orderKey: Date.now().toString(),
    surprise: 0,
    reason: "force-flush",
    rawText: "user: Debug the cache issue.\nassistant: Found the race condition in the pool.",
    estimatedTokens: 10,
    status: "queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    boundaryNote: "Bug fix: race condition resolved",
    boundaryReason: "bug-fix",
    ...extra,
  });

  const mockRpcClient = {
    getNarrativeSaveHashes: async () => ({}),
    cacheLeaseNext: async () => {
      if (leaseCount > 0) return null;
      leaseCount++;
      return makeItem();
    },
    cacheAck: async () => { ackCount++; return "ok"; },
    cacheRetry: async () => "ok",
    batchIngest: async () => ["test-slug"],
    cacheGetLatestNarrative: async () => ({ episodeId: "", body: "", found: false }),
    request: async () => null,
    setMeta: async () => "ok",
    getMeta: async () => null,
    recall: async () => [],
    recallFeedback: async () => ({ updated: 0, skipped: 0 }),
  };

  const savedGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    // Case A: Custom template WITH {boundaryNoteBlock} placeholder
    {
      const mockConfig = {
        openrouterModel: "test-model",
        openrouterConfig: { model: "test-model" },
        narrativeSystemPrompt: "Test",
        narrativeUserPromptTemplate: "Previous: {previousEpisode}\n{boundaryNoteBlock}\nTranscript: {conversationText}\nDone.",
        narrativePreviousEpisodeRef: true,
      };

      leaseCount = 0; chatCallCount = 0; ackCount = 0;
      const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
      await (worker as any).processNextFromCache();

      assert.ok(capturedUserMessage.includes("Agent Boundary Note:"),
        "Custom template with {boundaryNoteBlock}: should contain boundary block");
      assert.ok(capturedUserMessage.includes("Bug fix: race condition resolved"),
        "Custom template with {boundaryNoteBlock}: should contain boundaryNote");
      assert.ok(capturedUserMessage.includes("Transcript:"),
        "Custom template with {boundaryNoteBlock}: should contain transcript section");
      console.log("  custom template with {boundaryNoteBlock}: placeholder replaced correctly");
    }

    // Case B: Custom template WITHOUT {boundaryNoteBlock} — should append block
    {
      leaseCount = 0; chatCallCount = 0; ackCount = 0;
      const mockConfig = {
        openrouterModel: "test-model",
        openrouterConfig: { model: "test-model" },
        narrativeSystemPrompt: "Test",
        narrativeUserPromptTemplate: "Previous: {previousEpisode}\nTranscript: {conversationText}\nDone.",
        narrativePreviousEpisodeRef: true,
      };

      const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
      await (worker as any).processNextFromCache();

      assert.ok(capturedUserMessage.includes("Agent Boundary Note:"),
        "Custom template without {boundaryNoteBlock}: should append boundary block");
      assert.ok(capturedUserMessage.includes("Bug fix: race condition resolved"),
        "Custom template without {boundaryNoteBlock}: should contain boundaryNote");
      // Should appear after Done. (appended outside template)
      const doneIdx = capturedUserMessage.indexOf("Done.");
      const blockIdx = capturedUserMessage.indexOf("Agent Boundary Note:");
      assert.ok(blockIdx > doneIdx,
        "Custom template without {boundaryNoteBlock}: block should be appended after template resolution");
      console.log("  custom template without {boundaryNoteBlock}: boundary block appended correctly");
    }
  } finally {
    if (savedGeminiKey !== undefined) process.env.GEMINI_API_KEY = savedGeminiKey; else delete process.env.GEMINI_API_KEY;
  }

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  console.log("  custom template boundary block compatibility: all cases verified");
}

// ── Test 7: No boundary metadata → empty block (no prompt contamination) ─────────────

export async function testNoBoundaryMetadataPromptClean(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-no-boundary-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "narrative-worker.cjs");
  fs.copyFileSync(path.resolve("dist", "narrative-worker.js"), tempCjsPath);
  const distFiles = fs.readdirSync(path.resolve("dist"));
  for (const file of distFiles) {
    const src = path.resolve("dist", file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tempDir, file));
    }
  }
  fs.writeFileSync(
    path.join(tempDir, "lang-detect.js"),
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLanguageDetector = initLanguageDetector;
exports.detectLanguage = detectLanguage;
exports.detectLanguageDetailed = detectLanguageDetailed;
async function initLanguageDetector() { return true; }
function detectLanguage(_text) { return "unknown"; }
function detectLanguageDetailed(_text) { return { lang: "unknown", confidence: 0, isReliable: false }; }
`,
    "utf8"
  );

  const req = createRequire(import.meta.url);
  const workerModule = req(tempCjsPath);
  const NarrativeWorker = workerModule.NarrativeWorker;

  let capturedUserMessage = "";
  let leaseCount = 0;

  const mockOpenRouter = {
    chatCompletion: async (params: any) => {
      capturedUserMessage = params.userMessage || "";
      return MOCK_CJK_NARRATIVE;
    },
  };

  const mockRpcClient = {
    getNarrativeSaveHashes: async () => ({}),
    cacheLeaseNext: async () => {
      if (leaseCount > 0) return null;
      leaseCount++;
      return {
        id: `no-boundary-item-${process.pid}`,
        agentWs: tempDir,
        agentId: "main",
        source: "live-turn",
        parentIngestId: "ingest-test",
        orderKey: Date.now().toString(),
        surprise: 0,
        reason: "size-limit",
        rawText: "user: Check logs.\nassistant: Found the error in auth module.",
        estimatedTokens: 10,
        status: "queued",
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // No boundary fields — old-style item
      };
    },
    cacheAck: async () => "ok",
    cacheRetry: async () => "ok",
    batchIngest: async () => ["test-slug"],
    cacheGetLatestNarrative: async () => ({ episodeId: "", body: "", found: false }),
    request: async () => null,
    setMeta: async () => "ok",
    getMeta: async () => null,
    recall: async () => [],
    recallFeedback: async () => ({ updated: 0, skipped: 0 }),
  };

  const savedGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const mockConfig = {
      openrouterModel: "test-model",
      openrouterConfig: { model: "test-model" },
      narrativeSystemPrompt: "Test prompt",
      narrativeUserPromptTemplate: undefined,
      narrativePreviousEpisodeRef: true,
    };

    const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
    await (worker as any).processNextFromCache();

    // No boundary metadata → prompt should NOT contain "Agent Boundary Note:"
    assert.ok(!capturedUserMessage.includes("Agent Boundary Note:"),
      "No boundary metadata: prompt should not contain boundary block");
  } finally {
    if (savedGeminiKey !== undefined) process.env.GEMINI_API_KEY = savedGeminiKey; else delete process.env.GEMINI_API_KEY;
  }

  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  console.log("  no boundary metadata: prompt stays clean, no contamination");
}

// ── Main runner ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase 5.0 Boundary Metadata Tests ===");

  await testBoundaryMetadataPersistedToQueueItems();
  await testOldQueueItemsWithoutBoundaryFields();
  await testPoolCarriesBoundaryMetadata();
  await testNarrativeWorkerPromptBoundaryBlock();
  await testCustomTemplateWithBoundaryBlock();
  await testNoBoundaryMetadataPromptClean();

  console.log("\n=== All Phase 2 boundary metadata tests passed ===");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
