import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import {
  MOCK_CJK_NARRATIVE,
  MOCK_LATIN_NARRATIVE
} from "./test_phase4_5_shared.ts";

export async function runNarrativeWorkerEmptyRawTextGuardRegression(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-empty-rawtext-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "narrative-worker.cjs");
  fs.copyFileSync(path.resolve("dist", "narrative-worker.js"), tempCjsPath);
  const distFiles = fs.readdirSync(path.resolve("dist"));
  for (const file of distFiles) {
    const src = path.resolve("dist", file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tempDir, file));
    }
  }
  // [v0.4.28a] Stub lang-detect.js for CJS require context — eld is ESM-only and cannot be require()'d.
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

  const makeItem = (rawText: string) => ({
    id: `item-${Math.random().toString(36).slice(2, 8)}`,
    agentWs: tempDir,
    agentId: "main",
    source: "live-turn",
    parentIngestId: "ingest-test",
    orderKey: Date.now().toString(),
    surprise: 0,
    reason: "force-flush",
    rawText,
    estimatedTokens: 10,
    status: "queued",
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const runCase = async (rawText: string, expectSkip: boolean): Promise<void> => {
    let chatCallCount = 0;
    let ackCount = 0;
    const retryErrors: string[] = [];
    let leaseCount = 0;

    const mockOpenRouter = {
      chatCompletion: async () => {
        chatCallCount++;
        return MOCK_CJK_NARRATIVE;
      },
    };

    const mockRpcClient = {
      // [v0.4.29c Fix] Mock added to satisfy NarrativeWorker.initContinuity()
      getNarrativeSaveHashes: async () => ({}),
      cacheLeaseNext: async () => {
        if (leaseCount > 0) return null;
        leaseCount++;
        return makeItem(rawText);
      },
      cacheAck: async () => {
        ackCount++;
        return "ok";
      },
      cacheRetry: async (_id: string, _workerId: string, errMsg: string) => {
        retryErrors.push(errMsg);
        return "ok";
      },
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
      narrativeUserPromptTemplate: undefined,
      narrativePreviousEpisodeRef: true,
    };

    const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
    await (worker as any).processNextFromCache();

    if (expectSkip) {
      assert.equal(chatCallCount, 0, "empty/blank rawText should skip LLM call");
      assert.equal(ackCount, 0, "empty/blank rawText should not ack as success");
      assert.ok(retryErrors.some((msg) => msg.includes("empty_raw_text")), "empty/blank rawText should route to cacheRetry with empty_raw_text");
    } else {
      assert.equal(chatCallCount, 1, "normal rawText should call LLM once");
      assert.equal(ackCount, 1, "normal rawText should ack on success");
      assert.equal(retryErrors.length, 0, "normal rawText should not go through retry error path");
    }
  };

  const savedGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    await runCase("", true);
    await runCase("   ", true);
    // [v0.4.28b] rawText must be realistic length — G5/G6 check LLM output, not rawText,
    // but longer rawText is more representative of real usage.
    await runCase("ユーザーがシステムの調子を尋ね、応答としてログの確認と解析結果を報告した。その後、修正コードを適用し動作確認を実施した。", false);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    if (savedGeminiKey !== undefined) process.env.GEMINI_API_KEY = savedGeminiKey; else delete process.env.GEMINI_API_KEY;
  }

  console.log("  empty rawText guard regression: empty/blank skip LLM and retry; normal text keeps success path");
}

export async function runLanguageGuardReaskHandoffRegression(): Promise<void> {
  const workerSource = fs.readFileSync(path.resolve("src", "narrative-worker.ts"), "utf8");
  const savedGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {

  // ── Source verification (structural) ──────────────────────────────
  // 4a. QualityGateResult has isLanguageGate field
  assert.ok(
    workerSource.includes("isLanguageGate: boolean"),
    "QualityGateResult should have isLanguageGate: boolean field"
  );
  // 4b. LANGUAGE_REASK_MAX constant exists
  assert.ok(
    workerSource.includes("LANGUAGE_REASK_MAX"),
    "LANGUAGE_REASK_MAX constant should exist"
  );
  // 4c. LANGUAGE_NAME_MAP constant exists
  assert.ok(
    workerSource.includes("LANGUAGE_NAME_MAP"),
    "LANGUAGE_NAME_MAP constant should exist"
  );
  // 4d. LANGUAGE_REASK_SUFFIX function exists
  assert.ok(
    workerSource.includes("LANGUAGE_REASK_SUFFIX"),
    "LANGUAGE_REASK_SUFFIX function should exist"
  );
  // 4e. G0 mismatch returns isLanguageGate: true when contentGateEnabled=true
  assert.ok(
    /onFail === ["']reask["'] \|\| onFail === ["']handoff["']/.test(workerSource),
    "G0 should check onFail=reask|handoff"
  );
  assert.ok(
    workerSource.includes("isLanguageGate: true"),
    "G0 should return isLanguageGate: true on mismatch with contentGateEnabled=true"
  );
  // 4f. G0 softwarn fallback when contentGateEnabled=false
  assert.ok(
    workerSource.includes("mismatch-\${onFail}-softwarn-fallback"),
    "G0 should softwarn-fallback when contentGateEnabled=false with onFail=reask|handoff"
  );
  // 4g. narrativizeWithModel handles isLanguageGate routing
  assert.ok(
    workerSource.includes("gateResult.isLanguageGate"),
    "narrativizeWithModel should check gateResult.isLanguageGate"
  );
  // 4h. Gemini path has dedicated language-gate routing (v0.4.29c)
  assert.ok(
    workerSource.includes("[v0.4.29c BUG-FIX] Language gate routing") || workerSource.includes("language-mismatch in Gemini phase"),
    "Gemini path should have dedicated language-gate handling (v0.4.29c BUG-FIX comment or legacy defensive log marker)"
  );
  console.log("  language guard source verification: isLanguageGate, constants, routing, Gemini path — all present");

  // ── Integration test: onFail=reask ──────────────────────────────
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-lang-reask-${process.pid}-`));
    const tempCjsPath = path.join(tempDir, "narrative-worker.cjs");
    fs.copyFileSync(path.resolve("dist", "narrative-worker.js"), tempCjsPath);
    const distFiles = fs.readdirSync(path.resolve("dist"));
    for (const file of distFiles) {
      const src = path.resolve("dist", file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(tempDir, file));
      }
    }
    // Custom stub: detectLanguageDetailed returns "en" to trigger mismatch with expectedLang="ja"
    fs.writeFileSync(
      path.join(tempDir, "lang-detect.js"),
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLanguageDetector = initLanguageDetector;
exports.detectLanguage = detectLanguage;
exports.detectLanguageDetailed = detectLanguageDetailed;
async function initLanguageDetector() { return true; }
function detectLanguage(_text) { return "en"; }
function detectLanguageDetailed(_text) { return { lang: "en", confidence: 0.95, isReliable: true }; }
`,
      "utf8"
    );
    const req = createRequire(import.meta.url);
    const workerModule = req(tempCjsPath);
    const NarrativeWorker = workerModule.NarrativeWorker;
    if (!NarrativeWorker) throw new Error("NarrativeWorker class not found in compiled module");

    let chatCallCount = 0;
    const userMessages: string[] = [];
    let leaseCount = 0;
    let ackCount = 0;

    const mockOpenRouter = {
      chatCompletion: async (params: any) => {
        chatCallCount++;
        if (params?.userMessage) userMessages.push(params.userMessage);
        return MOCK_LATIN_NARRATIVE; // English narrative → detected as "en"
      },
    };

    const mockRpcClient = {
      // [v0.4.29c Fix] Mock added to satisfy NarrativeWorker.initContinuity()
      getNarrativeSaveHashes: async () => ({}),
      cacheLeaseNext: async () => {
        if (leaseCount > 0) return null;
        leaseCount++;
        return {
          id: `lang-reask-item-${process.pid}`,
          agentWs: tempDir,
          agentId: "main",
          source: "live-turn",
          parentIngestId: "ingest-test",
          orderKey: Date.now().toString(),
          surprise: 0,
          reason: "force-flush",
          rawText: "ユーザーがシステムの調子を尋ね、応答としてログの確認と解析結果を報告した。その後、修正コードを適用し動作確認を実施した。",
          estimatedTokens: 10,
          status: "queued",
          attempts: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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

    // Config with expectedLanguage=ja + onFail=reask → G0 mismatch triggers reask
    // NOTE: openrouterModel="test-model" triggers custom-model path in buildRetryPhases(),
    // which sets contentGateEnabled=true for the primary phase (no need for GEMINI_API_KEY).
    // contentGateEnabled in mockConfig is dead code — phase-level value comes from buildRetryPhases().
    const mockConfig = {
      openrouterModel: "test-model",
      openrouterConfig: { model: "test-model" },
      narrativeSystemPrompt: "Test prompt",
      narrativeUserPromptTemplate: undefined,
      narrativePreviousEpisodeRef: true,
      narrativeExpectedLanguage: "ja",
      narrativeLanguageOnFail: "reask",
    };

    const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
    await (worker as any).processNextFromCache();

    // Test 1: reask should trigger a 2nd LLM call with language suffix appended
    assert.ok(chatCallCount >= 2, `onFail=reask should trigger at least 2 LLM calls (actual: ${chatCallCount})`);
    const hasSuffix = userMessages.some(msg => msg.includes("Japanese language"));
    assert.ok(hasSuffix, `reask should append LANGUAGE_REASK_SUFFIX with full language name; got messages: ${JSON.stringify(userMessages.slice(0, 2))}`);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    console.log(`  language guard reask: ${chatCallCount} LLM calls, suffix appended=${hasSuffix} — reask path verified`);
  }

  // ── Integration test: onFail=handoff ──────────────────────────────
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-lang-handoff-${process.pid}-`));
    const tempCjsPath = path.join(tempDir, "narrative-worker.cjs");
    fs.copyFileSync(path.resolve("dist", "narrative-worker.js"), tempCjsPath);
    const distFiles = fs.readdirSync(path.resolve("dist"));
    for (const file of distFiles) {
      const src = path.resolve("dist", file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(tempDir, file));
      }
    }
    // Same stub: returns "en" to trigger mismatch with expectedLang="ja"
    fs.writeFileSync(
      path.join(tempDir, "lang-detect.js"),
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initLanguageDetector = initLanguageDetector;
exports.detectLanguage = detectLanguage;
exports.detectLanguageDetailed = detectLanguageDetailed;
async function initLanguageDetector() { return true; }
function detectLanguage(_text) { return "en"; }
function detectLanguageDetailed(_text) { return { lang: "en", confidence: 0.95, isReliable: true }; }
`,
      "utf8"
    );
    const req = createRequire(import.meta.url);
    const workerModule = req(tempCjsPath);
    const NarrativeWorker = workerModule.NarrativeWorker;
    if (!NarrativeWorker) throw new Error("NarrativeWorker class not found in compiled module");

    let chatCallCount = 0;
    let leaseCount = 0;
    let ackCount = 0;

    const mockOpenRouter = {
      chatCompletion: async () => {
        chatCallCount++;
        return MOCK_LATIN_NARRATIVE; // English → detected as "en"
      },
    };

    const mockRpcClient = {
      // [v0.4.29c Fix] Mock added to satisfy NarrativeWorker.initContinuity()
      getNarrativeSaveHashes: async () => ({}),
      cacheLeaseNext: async () => {
        if (leaseCount > 0) return null;
        leaseCount++;
        return {
          id: `lang-handoff-item-${process.pid}`,
          agentWs: tempDir,
          agentId: "main",
          source: "live-turn",
          parentIngestId: "ingest-test",
          orderKey: Date.now().toString(),
          surprise: 0,
          reason: "force-flush",
          rawText: "ユーザーがシステムの調子を尋ね、応答としてログの確認と解析結果を報告した。その後、修正コードを適用し動作確認を実施した。",
          estimatedTokens: 10,
          status: "queued",
          attempts: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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

    // Config with expectedLanguage=ja + onFail=handoff → G0 mismatch triggers immediate handoff
    // NOTE: openrouterModel="test-model" triggers custom-model path in buildRetryPhases(),
    // which sets contentGateEnabled=true for primary+fallback phases.
    // The last fallback phase has no contentGateEnabled → softwarn-fallback → save succeeds.
    const mockConfig = {
      openrouterModel: "test-model",
      openrouterConfig: { model: "test-model" },
      narrativeSystemPrompt: "Test prompt",
      narrativeUserPromptTemplate: undefined,
      narrativePreviousEpisodeRef: true,
      narrativeExpectedLanguage: "ja",
      narrativeLanguageOnFail: "handoff",
    };

    const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
    await (worker as any).processNextFromCache();

    // Test 2: handoff causes immediate phase transition (return null) in content-gated phases.
    // Custom model path: 3 phases total. Phases 1-2 have contentGateEnabled=true → handoff.
    // Phase 3 has no contentGateEnabled → softwarn-fallback → save succeeds.
    // So we expect multiple LLM calls (proving phase handoff occurred) and a successful save.
    assert.ok(chatCallCount >= 2, `onFail=handoff should trigger LLM calls across multiple phases (actual: ${chatCallCount})`);
    assert.ok(ackCount >= 1, `onFail=handoff should eventually save via last-resort fallback phase (actual ack: ${ackCount})`);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    console.log(`  language guard handoff: ${chatCallCount} LLM calls, ${ackCount} ack — handoff path verified`);
  }

  // ── Integration test: unknown skip (no regression) ─────────────────
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-lang-unknown-${process.pid}-`));
    const tempCjsPath = path.join(tempDir, "narrative-worker.cjs");
    fs.copyFileSync(path.resolve("dist", "narrative-worker.js"), tempCjsPath);
    const distFiles = fs.readdirSync(path.resolve("dist"));
    for (const file of distFiles) {
      const src = path.resolve("dist", file);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(tempDir, file));
      }
    }
    // Standard stub: returns "unknown" → G0 skips mismatch entirely
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
    if (!NarrativeWorker) throw new Error("NarrativeWorker class not found in compiled module");

    let chatCallCount = 0;
    let leaseCount = 0;
    let ackCount = 0;

    const mockOpenRouter = {
      chatCompletion: async () => {
        chatCallCount++;
        return MOCK_CJK_NARRATIVE;
      },
    };

    const mockRpcClient = {
      // [v0.4.29c Fix] Mock added to satisfy NarrativeWorker.initContinuity()
      getNarrativeSaveHashes: async () => ({}),
      cacheLeaseNext: async () => {
        if (leaseCount > 0) return null;
        leaseCount++;
        return {
          id: `lang-unknown-item-${process.pid}`,
          agentWs: tempDir,
          agentId: "main",
          source: "live-turn",
          parentIngestId: "ingest-test",
          orderKey: Date.now().toString(),
          surprise: 0,
          reason: "force-flush",
          rawText: "ユーザーがシステムの調子を尋ね、応答としてログの確認と解析結果を報告した。その後、修正コードを適用し動作確認を実施した。",
          estimatedTokens: 10,
          status: "queued",
          attempts: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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

    // Config with expectedLanguage=ja but onFail=reask — unknown should skip mismatch entirely
    const mockConfig = {
      openrouterModel: "test-model",
      openrouterConfig: { model: "test-model" },
      narrativeSystemPrompt: "Test prompt",
      narrativeUserPromptTemplate: undefined,
      narrativePreviousEpisodeRef: true,
      narrativeExpectedLanguage: "ja",
      narrativeLanguageOnFail: "reask",
    };

    const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
    await (worker as any).processNextFromCache();

    // Test 3: unknown detection should NOT trigger reask — normal flow (1 LLM call)
    assert.equal(chatCallCount, 1, `lang=unknown should skip G0 mismatch and call LLM once (actual: ${chatCallCount})`);
    assert.equal(ackCount, 1, `lang=unknown should result in successful save (actual ack: ${ackCount})`);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    console.log(`  language guard unknown skip: ${chatCallCount} LLM call, ${ackCount} ack — G0 skip preserved, no regression`);
  }

  // ── Integration test: contentGateEnabled=false + onFail=reask → softwarn-fallback ────
  // Plan §5 item 3: "contentGateEnabled=false 時は onFail=reask|handoff 設定でも保存阻害しない"
  // Using default model path (openrouterModel unset → "openrouter/free") + no GEMINI_API_KEY
  // → buildRetryPhases() sets contentGateEnabled=false → G0 softwarn-fallbacks.
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-runtime-"));
    fs.mkdirSync(path.join(tempDir, "dist"), { recursive: true });
    const distDir = path.resolve("dist");
    for (const f of fs.readdirSync(distDir)) {
      if (f.endsWith(".js")) fs.copyFileSync(path.join(distDir, f), path.join(tempDir, "dist", f));
    }
    fs.writeFileSync(
      path.join(tempDir, "dist", "lang-detect.js"),
      `// Softwarn-fallback stub: returns en (mismatch with expectedLang=ja)
module.exports = { detectLanguage: () => "en", detectLanguageDetailed: () => ({ lang: "en", confidence: 0.99, isReliable: true }) };
`
    );
    const distRequire = createRequire(path.join(tempDir, "dist", "_dummy.js"));
    const compiled = distRequire(path.join(tempDir, "dist", "narrative-worker.js"));
    const NarrativeWorker = compiled.NarrativeWorker;
    if (!NarrativeWorker) throw new Error("NarrativeWorker class not found in compiled module");

    let chatCallCount = 0;
    let ackCount = 0;
    const userMessages: string[] = [];

    const mockOpenRouter = {
      chatCompletion: async (params: any) => {
        chatCallCount++;
        userMessages.push(params.userMessage || "");
        return MOCK_CJK_NARRATIVE;
      },
    };

    const mockRpcClient = {
      // [v0.4.29c Fix] Mock added to satisfy NarrativeWorker.initContinuity()
      getNarrativeSaveHashes: async () => ({}),
      cacheLeaseNext: async () => {
        if (ackCount > 0) return null;
        return {
          id: `lang-softwarn-item-${process.pid}`,
          agentWs: tempDir,
          agentId: "main",
          source: "live-turn",
          parentIngestId: "ingest-test",
          orderKey: Date.now().toString(),
          surprise: 0,
          reason: "force-flush",
          rawText: "ユーザーがシステムの調子を尋ねた。その後ログを確認し解析結果を報告した。",
          estimatedTokens: 10,
          status: "queued",
          attempts: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
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

    // Default model path (no openrouterModel) + no GEMINI_API_KEY:
    // - Google phases are skipped
    // - Round2 = openrouter-free-head (contentGateEnabled=true)
    // - Round3 = openrouter-free (contentGateEnabled=false)
    // So onFail=reask triggers reask in Round2, then hands off to Round3 for final save.
    const savedGeminiKeySoftwarn = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const mockConfig = {
        narrativeSystemPrompt: "Test prompt",
        narrativeUserPromptTemplate: undefined,
        narrativePreviousEpisodeRef: true,
        narrativeExpectedLanguage: "ja",
        narrativeLanguageOnFail: "reask",
      };

      const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
      await (worker as any).processNextFromCache();

      // Test 4: no custom model + onFail=reask should still save via Round3 fallback
      // Expected flow (v0.4.29c):
      //   openrouter-free-head attempt1 mismatch-reask
      //   openrouter-free-head attempt2 mismatch-reask -> reask exhausted -> handoff
      //   openrouter-free attempt1 softwarn-fallback -> save
      assert.equal(chatCallCount, 3, `no-custom-model + onFail=reask should call LLM 3 times (reask + fallback save) (actual: ${chatCallCount})`);
      assert.equal(ackCount, 1, `no-custom-model + onFail=reask should save successfully via fallback (actual ack: ${ackCount})`);
      // Reask must append language suffix at least once in Round2
      const hasSuffix = userMessages.some(msg => msg.includes("Japanese language"));
      assert.ok(hasSuffix, `reask path should append language suffix before handoff; got messages: ${JSON.stringify(userMessages)}`);

      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      console.log(`  language guard no-custom-model reask→fallback: ${chatCallCount} LLM calls, ${ackCount} ack, suffix=${hasSuffix} — handoff path verified`);
    } finally {
      // Restore GEMINI_API_KEY for subsequent tests (even if assertion throws)
      if (savedGeminiKeySoftwarn !== undefined) process.env.GEMINI_API_KEY = savedGeminiKeySoftwarn; else delete process.env.GEMINI_API_KEY;
    }
  }

  console.log("  language guard reask/handoff/unknown/softwarn regression: all 4 integration tests + source verification passed");
  } finally {
    if (savedGeminiKey !== undefined) process.env.GEMINI_API_KEY = savedGeminiKey; else delete process.env.GEMINI_API_KEY;
  }

}

// [v0.5.1] Test that narrativeSystemPrompt=false resolves to empty string (no-system mode)
// while custom user template placeholders are still resolved correctly.
export async function runNarrativeWorkerFalseSystemMode(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-false-system-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "narrative-worker.cjs");
  fs.copyFileSync(path.resolve("dist", "narrative-worker.js"), tempCjsPath);
  const distFiles = fs.readdirSync(path.resolve("dist"));
  for (const file of distFiles) {
    const src = path.resolve("dist", file);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(tempDir, file));
    }
  }
  // Stub lang-detect.js for CJS require context
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

  try {
    // Test 1: false mode → system prompt resolves to empty string
    {
      let capturedSystem: string | undefined;
      let capturedUser: string | undefined;
      const mockOpenRouter = {
        chatCompletion: async (params: { systemPrompt: string; userMessage: string }) => {
          capturedSystem = params.systemPrompt;
          capturedUser = params.userMessage;
          return "test narrative";
        },
      };
      const mockRpcClient = {
        getNarrativeSaveHashes: async () => ({}),
        cacheLeaseNext: async () => null,
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
      const mockConfig = {
        openrouterModel: "test-model",
        openrouterConfig: { model: "test-model" },
        narrativeSystemPrompt: false as const,
        narrativeUserPromptTemplate: "Previous: {previousEpisode}\nBoundary: {boundaryNoteBlock}\nLog: {conversationText}",
        narrativePreviousEpisodeRef: true,
      };

      const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
      // Access private resolveSystemPrompt via any cast
      const resolved = (worker as any).resolveSystemPrompt();
      assert.equal(resolved, "", "false should resolve to empty string in worker");

      // Test user template resolution
      const userResolved = (worker as any).resolveUserPrompt("prev-ep", "conv-text", undefined);
      assert.ok(userResolved.includes("prev-ep"), "user template should resolve {previousEpisode}");
      assert.ok(userResolved.includes("conv-text"), "user template should resolve {conversationText}");
      assert.ok(userResolved.includes("Previous:"), "user template should preserve custom structure");
      console.log("  ✓ false mode: system resolves to empty, user template placeholders resolved");
    }

    // Test 2: omitted system → DEFAULT_SYSTEM_PROMPT
    {
      const mockOpenRouter = {
        chatCompletion: async () => "test",
      };
      const mockRpcClient = {
        getNarrativeSaveHashes: async () => ({}),
        cacheLeaseNext: async () => null,
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
      const mockConfig = {
        openrouterModel: "test-model",
        openrouterConfig: { model: "test-model" },
        narrativeSystemPrompt: undefined,
        narrativeUserPromptTemplate: undefined,
        narrativePreviousEpisodeRef: true,
      };

      const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
      const resolved = (worker as any).resolveSystemPrompt();
      assert.ok(resolved.length > 0, "omitted system should fall back to DEFAULT_SYSTEM_PROMPT");
      assert.ok(resolved.includes("Distill"), "should be the default system prompt content");
      console.log("  ✓ omitted system: resolves to DEFAULT_SYSTEM_PROMPT");
    }

    // Test 3: false mode with no custom user template → default user template still works
    {
      const mockOpenRouter = {
        chatCompletion: async () => "test",
      };
      const mockRpcClient = {
        getNarrativeSaveHashes: async () => ({}),
        cacheLeaseNext: async () => null,
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
      const mockConfig = {
        openrouterModel: "test-model",
        openrouterConfig: { model: "test-model" },
        narrativeSystemPrompt: false as const,
        narrativeUserPromptTemplate: undefined,
        narrativePreviousEpisodeRef: true,
      };

      const worker = new NarrativeWorker(mockOpenRouter, mockRpcClient, mockConfig);
      const systemResolved = (worker as any).resolveSystemPrompt();
      assert.equal(systemResolved, "", "false mode system should be empty");

      const userResolved = (worker as any).resolveUserPrompt("prev", "conv", undefined);
      assert.ok(userResolved.includes("Previous episode"), "default user template should be used");
      assert.ok(userResolved.includes("conv"), "default user template should resolve {conversationText}");
      console.log("  ✓ false mode + no custom user: system empty, default user template active");
    }

  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }

  console.log("  narrative worker false system mode: all 3 tests passed");
}
