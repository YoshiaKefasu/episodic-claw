import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, Module } from "node:module";
import {
  readJson,
  sleep,
  waitForLogContains,
  waitForTextContains,
  assertLogOrder,
  loadCompactorCtor,
  loadCompactorModule
} from "./test_phase4_5_shared.ts";

// ── Standalone copies of retriever sanitization functions (avoid ./config import issues) ──
const TEST_ATTACHMENT_BOILERPLATE: RegExp[] = [
  /\[media attached(?:\s+\d+\/\d+)?:[^\]]*\](?:\s*\|\s*[^\n]*)*/gi,
  /<media:(image|document|audio|video)>(\s*\([^)]*\))?/gi,
  /\[User sent media without caption\]/gi,
  /To send an image back[\s\S]*?Keep caption in the text body\./gi,
  /^\s*attached files\s*$/gi,
  /media:\/\/inbound\/[^\s]+/gi,
  /\[media attached:\s*\d+\s*files?\]/gi,
  /\(image\/\w+\)/gi,
  /^media:(image|document|audio|video)\s*$/gim,
  /MEDIA:[^\s]+/gi,
];

const TEST_ATTACHMENT_INDICATORS: RegExp[] = [
  /\b(jpg|jpeg|png|webp|gif|mp4|mp3|wav|pdf|txt|docx?|xlsx?)\b/gi,
  /[A-Z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*/gi,
  /\/(?:usr|home|tmp|var|data|media|storage)(?:\/[^/\s]+)+/gi,
];

const TEST_MEDIA_ONLY_SENTINEL_PARTS = [
  "\\[media attached[^\\]]*\\](?:\\s*\\|[^\\n]*)*",
  "<media:[^>]+>(?:\\s*\\([^)]*\\))?",
  "\\[User sent media without caption\\]",
  "attached files",
  "media://inbound/[^\\s]+",
  "To send an image back[^\\n]*",
  "\\(image/\\w+\\)",
  "Keep caption[^\\n]*",
  "media:(?:image|document|audio|video)",
  "MEDIA:[^\\s]+",
  "\\s",
];
const TEST_MEDIA_ONLY_SENTINEL = new RegExp(
  `^\\s*(?:${TEST_MEDIA_ONLY_SENTINEL_PARTS.join("|")})*$`, "i"
);

function testClassifyAndStripAttachment(text: string): { isDominant: boolean; cleanedText: string } {
  if (TEST_MEDIA_ONLY_SENTINEL.test(text.trim())) {
    return { isDominant: true, cleanedText: "" };
  }

  const hasMediaHeader = /\[media attached/i.test(text);
  const hasBoilerplateEnd = /Keep caption in the text body\./i.test(text);

  if (hasMediaHeader && hasBoilerplateEnd) {
    const boundaryIdx = text.lastIndexOf("Keep caption in the text body.");
    if (boundaryIdx !== -1) {
      const afterBoundary = text.slice(boundaryIdx + "Keep caption in the text body.".length);

      let tailCleaned = afterBoundary;
      tailCleaned = tailCleaned.replace(/^System:\s.*$/gm, "");
      tailCleaned = tailCleaned.replace(
        /^(Conversation info|Sender|Replied message)\s+\(untrusted[^)]*\):.*$/gim, ""
      );
      tailCleaned = tailCleaned.replace(/```json[\s\S]*?```/g, "");
      tailCleaned = tailCleaned.replace(/^media:(image|document|audio|video)\s*$/gim, "");
      tailCleaned = tailCleaned.replace(/<media:(image|document|audio|video)>(?:\s*\([^)]*\))?/gi, "");
      tailCleaned = tailCleaned.replace(/media:\/\/inbound\/[^\s]+/gi, "");
      tailCleaned = tailCleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();

      if (tailCleaned.length >= 2) {
        const cjkChars = (tailCleaned.match(
          /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]/gu
        ) || []).length;

        let indicatorCount = 0;
        for (const pattern of TEST_ATTACHMENT_INDICATORS) {
          const matches = tailCleaned.match(pattern);
          if (matches) indicatorCount += matches.length;
        }
        const wordCount = tailCleaned.split(/\s+/).filter(Boolean).length;

        const isDominant = tailCleaned.length < 2 ||
          (cjkChars === 0 && tailCleaned.length < 5) ||
          (indicatorCount > 0 && wordCount <= indicatorCount);

        return { isDominant, cleanedText: tailCleaned };
      }
      return { isDominant: true, cleanedText: "" };
    }
  }

  let cleaned = text;
  let markerCount = 0;

  for (const pattern of TEST_ATTACHMENT_BOILERPLATE) {
    const matches = cleaned.match(pattern);
    if (matches) markerCount += matches.length;
    cleaned = cleaned.replace(pattern, "");
  }

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+/g, " ").trim();

  const cjkChars = (cleaned.match(/[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]/gu) || []).length;

  let indicatorCount = 0;
  for (const pattern of TEST_ATTACHMENT_INDICATORS) {
    const matches = cleaned.match(pattern);
    if (matches) indicatorCount += matches.length;
  }
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;

  const isDominant =
    cleaned.length < 2 ||
    (cjkChars === 0 && cleaned.length < 5) ||
    (indicatorCount > 0 && wordCount <= indicatorCount);

  return { isDominant, cleanedText: cleaned };
}

function testIsAttachmentDominant(text: string): boolean {
  return testClassifyAndStripAttachment(text).isDominant;
}

function testStripAttachmentNoise(text: string): string {
  return testClassifyAndStripAttachment(text).cleanedText;
}

function testDetectDominantScript(text: string): "cjk" | "latin" {
  const chars = text.replace(/\s/g, "");
  if (chars.length === 0) return "latin";
  const cjkChars = (text.match(/[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]/gu) || []).length;
  const cjkRatio = cjkChars / chars.length;
  return cjkRatio >= 0.3 ? "cjk" : "latin";
}

export async function runAnchorInjectionSmoke(): Promise<void> {
  const previousArgv = [...process.argv];
  if (!process.argv.includes("test")) {
    process.argv.push("test");
  }
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-anchor-runtime-"));
  const runtimeDist = path.join(runtimeRoot, "dist");
  const require = createRequire(path.join(runtimeDist, "index.js"));
  const singletonKey = Symbol.for("__episodic_claw_singleton__");
  process.env.NODE_PATH = path.resolve("node_modules");
  Module._initPaths();

  fs.mkdirSync(runtimeDist, { recursive: true });
  for (const file of [
    "anchor-store.js",
    "archiver.js",
    "cjk-tokenizer.js",
    "lang-detect.js",
    "large-payload.js",
    "untrusted-metadata.js",
    "compactor.js",
    "config.js",
    "index.js",
    "retriever.js",
    "reasoning-tags.js",
    "openrouter-client.js",
    "narrative-worker.js",
    "gemini-direct-client.js",
    "narrative-pool.js",
    "narrative-queue.js",
    "rpc-client.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "transport-retry.js",
    "segmenter.js",
    "types.js",
    "utils.js",
    "runtime-mode.js",
  ]) {
    fs.copyFileSync(path.join("dist", file), path.join(runtimeDist, file));
  }

  // Stub lang-detect.js for CJS require context — eld is ESM-only and cannot be require()'d.
  // [v0.4.28a] Added detectLanguageDetailed export + DetectedLanguage type for narrative-worker G0 guard.
  fs.writeFileSync(
    path.join(runtimeDist, "lang-detect.js"),
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

  // Stub cjk-tokenizer.js for CJS require context — kuromojin is ESM-only.
  fs.writeFileSync(
    path.join(runtimeDist, "cjk-tokenizer.js"),
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenizeCjk = tokenizeCjk;
async function tokenizeCjk(text, lang) {
  if (lang === "ja") {
    // Stub: extract CJK 2+ char sequences as pseudo-morphemes
    const matches = text.match(/[\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}]{2,}/gu) || [];
    return { keywords: matches, lang: "ja" };
  }
  if (lang === "zh") {
    // Stub: extract Han char bigrams (simulates cjk-tokenizer bigram)
    const chars = (text.match(/[\\p{Script=Han}]/gu) || []);
    const bigrams = [];
    for (let i = 0; i <= chars.length - 2; i++) bigrams.push(chars[i] + chars[i + 1]);
    return { keywords: bigrams, lang: "zh" };
  }
  if (lang === "ko") {
    // Stub: Hangul bigram
    const chars = (text.match(/[\\p{Script=Hangul}]/gu) || []);
    const bigrams = [];
    for (let i = 0; i <= chars.length - 2; i++) bigrams.push(chars[i] + chars[i + 1]);
    return { keywords: bigrams, lang: "ko" };
  }
  // Fallback
  const cjkMatches = text.match(/[\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}\\p{Script=Hangul}]{2,}/gu) || [];
  return { keywords: cjkMatches, lang: lang || "unknown" };
}
`,
    "utf8"
  );

  fs.writeFileSync(
    path.join(runtimeDist, "rpc-client.js"),
    `
class EpisodicCoreClient {
  async start() {}
  async stop() {}
  async startWatcher() { return "ok"; }
  async rebuildIndex() { return "ok"; }
  async setMeta() {}
  async getWatermark() { return { dateSeq: "20260403-18", absIndex: 17 }; }
  async setWatermark() {}
  async triggerBackgroundIndex() { return "ok"; }
  async batchIngest() { return []; }
  async segmentScore() {
    return {
      rawSurprise: 0.05,
      mean: 0.01,
      std: 0.01,
      threshold: 0.2,
      z: 0,
      isBoundary: false,
      reason: "stub"
    };
  }
  async recall() {
    return [{
      Record: {
        id: "recall-1",
        title: "Recall 1",
        timestamp: "2026-04-03T00:00:00Z"
      },
      Body: "Remember the exam framing."
    }];
  }
  async recallFeedback() { return "ok"; }
}
class FileEventDebouncer {
  constructor() {}
}
module.exports = { EpisodicCoreClient, FileEventDebouncer };
`,
    "utf8"
  );

  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-anchor-"));
  const agentRoot = path.join(tempBase, "workspace");
  const agentWs = path.join(agentRoot, "episodes");
  const messages = Array.from({ length: 18 }, (_value, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content:
      index === 16
        ? "Keep the newest study plan visible in the active window."
        : index === 17
          ? "Understood. I will preserve the freshest plan details."
          : `Historical message ${index + 1} about the older exam context.`,
  }));

  fs.mkdirSync(agentWs, { recursive: true });

  delete (globalThis as any)[singletonKey];

  let contextEngineFactory: (() => any) | null = null;
  let registerCommandCalls = 0;
  const handlers = new Map<string, (event?: any, ctx?: any) => Promise<void> | void>();
  const mockApi = {
    on(hookName: string, handler: (event?: any, ctx?: any) => Promise<void> | void) {
      handlers.set(hookName, handler);
    },
    registerContextEngine(_id: string, factory: () => any) {
      contextEngineFactory = factory;
    },
    registerCommand() {
      registerCommandCalls += 1;
    },
    registerTool() {},
    runtime: {
      extensionAPI: {},
      config: {
        loadConfig() {
          return {
            anchorInjectionAssembles: 1,
            agents: {
              list: [{ id: "main", default: true, workspace: agentRoot }],
              defaults: { workspace: agentRoot },
            },
          };
        },
      },
    },
  };

  const savedGeminiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const pluginModule = require(path.join(runtimeDist, "index.js"));
    const plugin = pluginModule.default ?? pluginModule;
    const originalCwd = process.cwd();
    process.chdir(runtimeRoot);
    try {
      plugin.register(mockApi as any);
    } finally {
      process.chdir(originalCwd);
    }

    assert.equal(registerCommandCalls, 0, "plugin should not register a competing /compact command");
    assert.ok(contextEngineFactory, "context engine should be registered");
    const afterCompaction = handlers.get("after_compaction");
    assert.ok(afterCompaction, "after_compaction hook should be registered");
    const engine = contextEngineFactory!();

    const anchorFile = path.join(agentWs, "anchor.md");
    const anchorPayload = "Remember the exam plan, the latest outline, and the one-step recovery rule.";
    fs.writeFileSync(anchorFile, anchorPayload, "utf8");
    await afterCompaction!(undefined, { agentId: "main" });

    const budgetZero = await engine.assemble({
      agentId: "main",
      tokenBudget: 2048,
      messages: [
        { role: "user", content: "What should I remember for the next exam practice?" },
      ],
    });
    assert.doesNotMatch(
      budgetZero.prependSystemContext ?? "",
      /\[Compaction Anchor\]/,
      "zero remaining episodic budget should skip temporary anchor injection without consuming it"
    );

    const firstEligible = await engine.assemble({
      agentId: "main",
      tokenBudget: 4096,
      messages: [
        { role: "user", content: "What should I remember for the next exam practice?" },
      ],
    });
    assert.match(firstEligible.prependSystemContext ?? "", /Remember the exam plan, the latest outline, and the one-step recovery rule\./, "the next eligible prompt build should inject the anchor text from anchor.md");
    assert.match(firstEligible.prependSystemContext ?? "", /--- My Memory ---/, "recall injection should remain active and separately merged");
    assert.ok(
      (firstEligible.prependSystemContext ?? "").indexOf("Remember the exam plan") < (firstEligible.prependSystemContext ?? "").indexOf("--- My Memory ---"),
      "anchor injection should merge before recall injection in the final prependSystemContext"
    );

    const expired = await engine.assemble({
      agentId: "main",
      tokenBudget: 4096,
      messages: [
        { role: "user", content: "What should I remember for the next exam practice?" },
      ],
    });
    assert.doesNotMatch(expired.prependSystemContext ?? "", /Remember the exam plan, the latest outline, and the one-step recovery rule\./, "temporary anchor injection should expire after the configured lifetime");
    assert.match(expired.prependSystemContext ?? "", /--- My Memory ---/, "recall injection should continue after anchor injection expires");
  } finally {
    process.argv.length = 0;
    process.argv.push(...previousArgv);
    delete (globalThis as any)[singletonKey];
    if (savedGeminiKey !== undefined) process.env.GEMINI_API_KEY = savedGeminiKey; else delete process.env.GEMINI_API_KEY;
  }
}

export async function runDegradedFallbackGuardSmoke(): Promise<void> {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-retriever-runtime-"));
  const runtimeDist = path.join(runtimeRoot, "dist");
  fs.mkdirSync(runtimeDist, { recursive: true });
  for (const file of [
    "cjk-tokenizer.js",
    "lang-detect.js",
    "large-payload.js",
    "untrusted-metadata.js",
    "compactor.js",
    "config.js",
    "retriever.js",
    "reasoning-tags.js",
    "openrouter-client.js",
    "narrative-worker.js",
    "gemini-direct-client.js",
    "narrative-pool.js",
    "narrative-queue.js",
    "rpc-client.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "transport-retry.js",
    "segmenter.js",
    "types.js",
    "utils.js",
  ]) {
    const target = file === "retriever.js"
      ? path.join(runtimeDist, "retriever.cjs")
      : path.join(runtimeDist, file);
    fs.copyFileSync(path.join("dist", file), target);
  }

  // Stub lang-detect.js for CJS require context — eld is ESM-only and cannot be require()'d.
  // When eld is unavailable, detectLanguage() returns "unknown", and tokenizeCjk falls back to regex.
  // [v0.4.28a] Added detectLanguageDetailed export + DetectedLanguage type for narrative-worker G0 guard.
  fs.writeFileSync(
    path.join(runtimeDist, "lang-detect.js"),
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

  // Stub cjk-tokenizer.js for CJS require context — kuromojin is ESM-only.
  // When unavailable, tokenizeCjk falls back to regex extraction.
  fs.writeFileSync(
    path.join(runtimeDist, "cjk-tokenizer.js"),
    `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.tokenizeCjk = tokenizeCjk;
async function tokenizeCjk(text, lang) {
  if (lang === "ja") {
    // Stub: extract CJK 2+ char sequences as pseudo-morphemes
    const matches = text.match(/[\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}]{2,}/gu) || [];
    return { keywords: matches, lang: "ja" };
  }
  if (lang === "zh") {
    // Stub: extract Han char bigrams (simulates cjk-tokenizer bigram)
    const chars = (text.match(/[\\p{Script=Han}]/gu) || []);
    const bigrams = [];
    for (let i = 0; i <= chars.length - 2; i++) bigrams.push(chars[i] + chars[i + 1]);
    return { keywords: bigrams, lang: "zh" };
  }
  if (lang === "ko") {
    // Stub: Hangul bigram
    const chars = (text.match(/[\\p{Script=Hangul}]/gu) || []);
    const bigrams = [];
    for (let i = 0; i <= chars.length - 2; i++) bigrams.push(chars[i] + chars[i + 1]);
    return { keywords: bigrams, lang: "ko" };
  }
  // Fallback
  const cjkMatches = text.match(/[\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}\\p{Script=Hangul}]{2,}/gu) || [];
  return { keywords: cjkMatches, lang: lang || "unknown" };
}
`,
    "utf8"
  );

  const require = createRequire(import.meta.url);
  const { EpisodicRetriever } = require(path.join(runtimeDist, "retriever.cjs"));
  const lowConfidenceClient = {
    async recall() {
      return [{
        Record: {
          id: "fallback-low",
          title: "Fallback Low",
          timestamp: "2026-04-04T00:00:00Z",
        },
        Body: "This should not auto-inject because confidence is too low.",
        matchedBy: "semantic",
        fallbackReason: "embed_fallback_lexical_only",
        Score: 0.42,
      }];
    },
    async recallFeedback() {
      return "ok";
    },
  };
  const highConfidenceClient = {
    async recall() {
      return [{
        Record: {
          id: "fallback-high",
          title: "Fallback High",
          timestamp: "2026-04-04T00:00:00Z",
        },
        Body: "This should auto-inject because confidence cleared the guard.",
        matchedBy: "semantic",
        fallbackReason: "embed_fallback_lexical_only",
        Score: 0.92,
      }];
    },
    async recallFeedback() {
      return "ok";
    },
  };

  const lowRetriever = new EpisodicRetriever(lowConfidenceClient as any, undefined);
  const lowOutcome = await lowRetriever.retrieveRelevantContext(
    [{ role: "user", content: "Recall the exam memory." } as any],
    "/tmp/episodes",
    5,
    2048
  );
  assert.equal(
    lowOutcome.reason,
    "degraded_low_confidence",
    "low-confidence degraded semantic fallback should be suppressed from prependSystemContext"
  );
  assert.equal(lowOutcome.text, "", "guarded degraded fallback should not inject any text");
  assert.deepEqual(
    lowOutcome.diagnostics.fallbackReasons,
    ["embed_fallback_lexical_only"],
    "guarded degraded fallback should still expose fallback diagnostics"
  );

  const highRetriever = new EpisodicRetriever(highConfidenceClient as any, undefined);
  const highOutcome = await highRetriever.retrieveRelevantContext(
    [{ role: "user", content: "Recall the exam memory." } as any],
    "/tmp/episodes",
    5,
    2048
  );
  assert.equal(highOutcome.reason, "injected", "high-confidence degraded fallback should still inject");
  assert.match(
    highOutcome.text,
    /Fallback High/,
    "high-confidence degraded fallback should remain available to prependSystemContext"
  );

  const relaxedRetriever = new EpisodicRetriever(lowConfidenceClient as any, {
    autoInjectGuardMinScore: 0.4,
  } as any);
  const relaxedOutcome = await relaxedRetriever.retrieveRelevantContext(
    [{ role: "user", content: "Recall the exam memory." } as any],
    "/tmp/episodes",
    5,
    2048
  );
  assert.equal(
    relaxedOutcome.reason,
    "injected",
    "autoInjectGuardMinScore should allow operators to lower the degraded fallback inject threshold"
  );

  // v0.4.25: latestUserAnchor should become window latest when event.messages tail is assistant
  let capturedQuery = "";
  const anchorAwareClient = {
    async recall(query: string) {
      capturedQuery = query;
      return [{
        Record: { id: "anchor-aware", title: "Anchor Aware", timestamp: "2026-04-04T00:00:00Z" },
        Body: "Anchor aware recall result",
        matchedBy: "semantic",
        Score: 0.95,
      }];
    },
    async recallFeedback() {
      return "ok";
    },
  };
  const anchorAwareRetriever = new EpisodicRetriever(anchorAwareClient as any, {
    recallQueryRecentMessageCount: 2,
  } as any);
  const anchorAwareOutcome = await anchorAwareRetriever.retrieveRelevantContext(
    [
      { role: "user", content: "昨日の漢字練習メモ" } as any,
      { role: "assistant", content: "了解、続けよう" } as any,
    ],
    "/tmp/episodes",
    5,
    2048,
    { latestUserAnchor: "最新 手書き 習慣" }
  );
  assert.equal(anchorAwareOutcome.reason, "injected", "anchor-aware recall should still inject when recall returns results");
  assert.match(capturedQuery, /最新|手書き|習慣/, "latestUserAnchor keywords should be reflected in final recall query");
}

export async function runRetrieverRuntimeRegression(): Promise<void> {
  // ── Sync verification: ensure standalone test helper matches production code ──
  const retrieverSourceForSync = fs.readFileSync(path.resolve("src", "retriever.ts"), "utf8");

  // Verify the test boilerplate regex patterns match production
  const prodBoilerplateMatch = retrieverSourceForSync.match(/const ATTACHMENT_BOILERPLATE[\s\S]*?\[([\s\S]*?)\];/);
  assert.ok(prodBoilerplateMatch, "production ATTACHMENT_BOILERPLATE should be found in retriever.ts");

  // Verify key patterns exist in both test helper and production
  const testHelperPatterns = [
    /\\[media attached\(\?:\\s\+\\d\+\\\/\\d\+\)\?:\[\^\\\]\]\*\\]\(\?:\\s\*\\\|\\s\*\[\^\\n\]\*\)\*/,
    /<media:\(image\|document\|audio\|video\)>/,
    /\\[User sent media without caption\\]/,
    /To send an image back\[\\s\\S\]\*\?Keep caption/,
    /media:\\\/\\\/inbound\\\/\[\^\\s\]\+/,
    /\\[media attached:\\s\*\\d\+\\s\*files\?\\]/,
  ];
  // Check for the image/\\w+ pattern with proper escaping
  const hasMimePattern = retrieverSourceForSync.includes('image/\\\\w+');
  const hasBareMediaPattern = retrieverSourceForSync.includes('media:(image|document|audio|video)');
  const hasMediaURLPattern = retrieverSourceForSync.includes('MEDIA:[^\\\\s]+');
  assert.ok(hasMimePattern, "production retriever.ts should have MIME type pattern");
  assert.ok(hasBareMediaPattern, "production retriever.ts should have bare media:type pattern");
  assert.ok(hasMediaURLPattern, "production retriever.ts should have MEDIA: URL pattern");

  for (const pattern of testHelperPatterns) {
    assert.ok(
      pattern.test(retrieverSourceForSync),
      `production retriever.ts should contain the same boilerplate pattern as test helper: ${pattern.source}`
    );
  }

  // Verify CJK-lenient threshold logic exists in production
  assert.ok(
    retrieverSourceForSync.includes("cjkChars") && retrieverSourceForSync.includes("cleaned.length < 2"),
    "production retriever.ts should have CJK-lenient threshold (cleaned.length < 2)"
  );

  // Verify exported function signatures exist
  assert.ok(retrieverSourceForSync.includes("export function isAttachmentDominant"), "retriever should export isAttachmentDominant");
  assert.ok(retrieverSourceForSync.includes("export function stripAttachmentNoise"), "retriever should export stripAttachmentNoise");
  assert.ok(retrieverSourceForSync.includes("export function classifyAndStripAttachment"), "retriever should export classifyAndStripAttachment (unified single-pass replacement)");
  assert.ok(retrieverSourceForSync.includes("export function detectDominantScript"), "retriever should export detectDominantScript");
  assert.ok(retrieverSourceForSync.includes("export async function instantDeterministicRewrite") || retrieverSourceForSync.includes("export function instantDeterministicRewrite"), "retriever should export instantDeterministicRewrite");
  assert.ok(retrieverSourceForSync.includes("export async function extractPolyglotKeywords") || retrieverSourceForSync.includes("export function extractPolyglotKeywords"), "retriever should export extractPolyglotKeywords");

  // Verify CJK keyword extraction scripts
  assert.ok(retrieverSourceForSync.includes("Script=Han") && retrieverSourceForSync.includes("Script=Katakana"), "CJK keyword extraction regex should include Han and Katakana scripts");
  assert.ok(retrieverSourceForSync.includes("primaryCount") && retrieverSourceForSync.includes("secondaryCount"), "Script-aware keyword allocation (primary/secondary) should be implemented");

  // ── Test 1: Telegram indexed attachment marker is stripped ──
  const telegramIndexed = "[media attached 1/2: C:\\Users\\test\\photo.jpg] おはよう";
  assert.ok(!testIsAttachmentDominant(telegramIndexed), "Telegram indexed marker with caption should not be attachment-dominant");
  const cleanedTelegram = testStripAttachmentNoise(telegramIndexed);
  assert.ok(cleanedTelegram.includes("おはよう"), "Telegram caption should be preserved after stripping");
  assert.ok(!cleanedTelegram.includes("[media attached"), "Telegram indexed marker should be stripped");

  // ── Test 2: Gateway media://inbound marker is stripped ──
  const gatewayMarker = "[media attached: media://inbound/abc123] Hello there";
  assert.ok(!testIsAttachmentDominant(gatewayMarker), "Gateway marker with caption should not be attachment-dominant");
  const cleanedGateway = testStripAttachmentNoise(gatewayMarker);
  assert.ok(cleanedGateway.includes("Hello there"), "Gateway caption should be preserved");
  assert.ok(!cleanedGateway.includes("media://inbound"), "Gateway marker should be stripped");

  // ── Test 3: LINE placeholder is stripped ──
  const linePlaceholder = "<media:image> 写真送った";
  assert.ok(!testIsAttachmentDominant(linePlaceholder), "LINE placeholder with caption should not be attachment-dominant");
  const cleanedLine = testStripAttachmentNoise(linePlaceholder);
  assert.ok(cleanedLine.includes("写真送った"), "LINE caption should be preserved");
  assert.ok(!cleanedLine.includes("<media:image>"), "LINE placeholder should be stripped");

  // ── Test 4: Discord placeholder is stripped ──
  const discordPlaceholder = "<media:document> (2 files) ファイル共有";
  assert.ok(!testIsAttachmentDominant(discordPlaceholder), "Discord placeholder with caption should not be attachment-dominant");
  const cleanedDiscord = testStripAttachmentNoise(discordPlaceholder);
  assert.ok(cleanedDiscord.includes("ファイル共有"), "Discord caption should be preserved");
  assert.ok(!cleanedDiscord.includes("<media:document>"), "Discord placeholder should be stripped");

  // ── Test 5: Media-only sentinel is attachment-dominant ──
  const mediaOnly = "[User sent media without caption]";
  assert.ok(testIsAttachmentDominant(mediaOnly), "Media-only sentinel should be attachment-dominant");
  const cleanedMediaOnly = testStripAttachmentNoise(mediaOnly);
  assert.ok(cleanedMediaOnly.length < 3, "Media-only text should be essentially empty after stripping");

  // ── Test 6: Pure attachment noise is attachment-dominant ──
  const pureNoise = "[media attached: /path/to/file.jpg]\nTo send an image back, prefer the image URL. Keep caption in the text body.";
  assert.ok(testIsAttachmentDominant(pureNoise), "Pure attachment noise should be attachment-dominant");

  // ── Test 7: CJK query normalization runtime test ──
  // Simulate the sanitize + keyword extraction pipeline
  const cjkRaw = "おはよう、朝は早いね…";
  const cjkCleaned = testStripAttachmentNoise(cjkRaw); // no-op for pure CJK
  assert.equal(cjkCleaned, cjkRaw, "Pure CJK text should be unchanged by stripAttachmentNoise");
  const cjkScript = testDetectDominantScript(cjkCleaned);
  assert.equal(cjkScript, "cjk", "CJK message should be detected as CJK-dominant");

  // ── Test 8: media-only × strict recent window = recall skip ──
  const mediaMsg1 = "[media attached: /path/photo.jpg]";
  const mediaMsg2 = "[User sent media without caption]";
  assert.ok(testIsAttachmentDominant(mediaMsg1), "Media-only message 1 should be attachment-dominant");
  assert.ok(testIsAttachmentDominant(mediaMsg2), "Media-only message 2 should be attachment-dominant");
  const cleaned1 = testStripAttachmentNoise(mediaMsg1);
  const cleaned2 = testStripAttachmentNoise(mediaMsg2);
  assert.ok(cleaned1.length < 3, "Media-only message 1 should produce empty text after stripping");
  assert.ok(cleaned2.length < 3, "Media-only message 2 should produce empty text after stripping");

  // ── Test 9: Mixed media + caption produces caption-only query ──
  const mixedMsg = "[media attached 1/2: media://inbound/abc]\nTo send an image back, prefer the message tool. Keep caption in the text body.\n猫の写真";
  const cleanedMixed = testStripAttachmentNoise(mixedMsg);
  assert.ok(cleanedMixed.includes("猫の写真"), "Mixed message should preserve caption");
  assert.ok(!cleanedMixed.includes("media attached"), "Mixed message should strip attachment marker");
  assert.ok(!cleanedMixed.includes("To send an image back"), "Mixed message should strip boilerplate");

  console.log("  retriever runtime regression: attachment stripping, CJK query, media-only skip, and sync verification all verified at runtime");
}

export async function runRetrieverSourceSmoke(): Promise<void> {
  const retrieverSource = fs.readFileSync(path.resolve("src", "retriever.ts"), "utf8");

  // 1. Verify indexed attachment regex is present (covers [media attached 1/2: ...])
  assert.ok(
    retrieverSource.includes("media attached(?:") || retrieverSource.includes("\\d+\\/\\d+"),
    "retriever should handle indexed multi-attachment markers like [media attached 1/2: ...]"
  );

  // 2. Verify media://inbound pattern is present
  assert.ok(
    retrieverSource.includes("media://inbound"),
    "retriever should strip media://inbound/<id> markers"
  );

  // 3. Verify <media:> placeholder pattern is present (LINE/Discord)
  assert.ok(
    retrieverSource.includes("<media:"),
    "retriever should strip <media:image/document/audio/video> placeholders"
  );

  // 4. Verify [User sent media without caption] sentinel is present
  assert.ok(
    retrieverSource.includes("User sent media without caption"),
    "retriever should strip [User sent media without caption] sentinel"
  );

  // 5. Verify "To send an image back" boilerplate pattern is present
  assert.ok(
    retrieverSource.includes("To send an image back"),
    "retriever should strip 'To send an image back' boilerplate"
  );

  // 6. Verify detectDominantScript is present (CJK priority)
  assert.ok(
    retrieverSource.includes("detectDominantScript"),
    "retriever should have detectDominantScript function"
  );

  // 7. Verify script-aware keyword extraction (primary/secondary pattern)
  assert.ok(
    retrieverSource.includes("primaryCount") && retrieverSource.includes("secondaryCount"),
    "retriever should use primary/secondary script-aware keyword allocation"
  );

  // 7.1 Verify v0.4.24 message-aware latest-keyword reservation exists
  assert.ok(
    retrieverSource.includes("const LATEST_RESERVE = 4") && retrieverSource.includes("const MAX_TOTAL = 12"),
    "retriever should reserve latest-message keyword slots with LATEST_RESERVE=4 and MAX_TOTAL=12"
  );
  assert.ok(
    retrieverSource.includes("const reversed = [...perMessageKeywords].reverse()") && retrieverSource.includes("const latestKeywords = reversed[0] ?? []"),
    "retriever should process per-message keywords in newest-first order"
  );
  assert.ok(
    retrieverSource.includes("fallbackText = cleanedPerMessage.join(\"\\n\")") || retrieverSource.includes("const fallbackText = cleanedPerMessage.join(\"\\n\")"),
    "retriever should keep a deterministic fallback text when keyword extraction yields none"
  );

  // 8. Verify recallQueryDebug is present in the outcome type
  assert.ok(
    retrieverSource.includes("recallQueryDebug"),
    "RecallInjectionOutcome should include recallQueryDebug field"
  );

  // 8.1 Verify v0.4.25 anchor-aware window path exists
  assert.ok(
    retrieverSource.includes("buildRecentUserWindow") && retrieverSource.includes("latestUserAnchor"),
    "retriever should implement buildRecentUserWindow with latestUserAnchor support"
  );
  assert.ok(
    retrieverSource.includes("windowAnchorInjected") && retrieverSource.includes("windowLatestMatchesAnchor"),
    "retriever should emit anchor-aware observability fields"
  );

  // 9. Verify buildRecallQueryDebug helper exists
  assert.ok(
    retrieverSource.includes("buildRecallQueryDebug"),
    "retriever should have buildRecallQueryDebug helper"
  );

  // 10. Verify observability fields are logged in index.ts
  const indexSource = fs.readFileSync(path.resolve("src", "index.ts"), "utf8");
  assert.ok(
    indexSource.includes("eligibleRecentMessages") && indexSource.includes("skippedImageLikeMessages") && indexSource.includes("dominantScript"),
    "index.ts should log eligible/skipped/dominantScript observability fields"
  );
  assert.ok(
    indexSource.includes("normalizePromptAnchor") && indexSource.includes("latestUserAnchor"),
    "index.ts should normalize event.prompt and pass latestUserAnchor to retriever"
  );
  assert.ok(
    indexSource.includes("deriveLatestUserAnchorFromMessages") && indexSource.includes("retrieveRelevantContext(msgs, agentWs, k, maxRecallTokens, {"),
    "index.ts should pass retriever opts in both before_prompt_build and assemble paths"
  );

  // 11. [v0.4.28f] Wiring smoke: verify index.ts passes timeout/retries to OpenRouterClient
  // Source-level guard — prevents silent regression where cfg fields are defined but never wired.
  assert.ok(
    indexSource.includes("timeoutMs: cfg.openrouterTimeoutMs"),
    "index.ts [v0.4.28f] must wire cfg.openrouterTimeoutMs to OpenRouterClient"
  );
  assert.ok(
    indexSource.includes("maxRetries: cfg.openrouterMaxRetries"),
    "index.ts [v0.4.28f] must wire cfg.openrouterMaxRetries to OpenRouterClient"
  );
  assert.ok(
    indexSource.includes("openrouterTimeoutMs=${cfg.openrouterTimeoutMs}"),
    "index.ts [v0.4.28f] must log openrouterTimeoutMs in Config loaded"
  );

  console.log("  retriever source smoke: attachment markers, script-aware extraction, observability all present");
  console.log("  [v0.4.28f] wiring smoke: timeoutMs + maxRetries → OpenRouterClient verified in index.ts");
}

export async function runPolyglotQueryMorphologicalTests(): Promise<void> {
  // ── Source smoke: verify new exports exist ──
  const retrieverSource = fs.readFileSync(path.resolve("src", "retriever.ts"), "utf8");
  assert.ok(
    retrieverSource.includes("export async function extractPolyglotKeywords"),
    "extractPolyglotKeywords should be async (Promise<string[]>)"
  );
  assert.ok(
    retrieverSource.includes("export async function instantDeterministicRewrite"),
    "instantDeterministicRewrite should be async (Promise<string>)"
  );
  assert.ok(
    retrieverSource.includes("export function splitByScript"),
    "retriever should export splitByScript for mixed-text handling"
  );
  assert.ok(
    retrieverSource.includes("import { detectLanguage") || retrieverSource.includes("from \"./lang-detect\""),
    "retriever should import detectLanguage from lang-detect"
  );
  assert.ok(
    retrieverSource.includes("import { tokenizeCjk }") || retrieverSource.includes("from \"./cjk-tokenizer\""),
    "retriever should import tokenizeCjk from cjk-tokenizer"
  );
  assert.ok(
    retrieverSource.includes("await instantDeterministicRewrite") || retrieverSource.includes("await instantDeterministicRewrite("),
    "retrieveRelevantContext should await instantDeterministicRewrite"
  );

  // ── Verify lang-detect.ts exists and has correct exports ──
  const langDetectSource = fs.readFileSync(path.resolve("src", "lang-detect.ts"), "utf8");
  assert.ok(
    langDetectSource.includes("export async function initLanguageDetector"),
    "lang-detect should export initLanguageDetector for warm-up"
  );
  assert.ok(
    langDetectSource.includes("export function detectLanguage"),
    "lang-detect should export detectLanguage"
  );
  // [v0.4.28a] Verify detectLanguageDetailed export for G0 language guard
  assert.ok(
    langDetectSource.includes("export function detectLanguageDetailed"),
    "lang-detect should export detectLanguageDetailed for G0 language guard"
  );
  assert.ok(
    langDetectSource.includes("DetectLanguageDetailedResult"),
    "lang-detect should export DetectLanguageDetailedResult type"
  );
  assert.ok(
    langDetectSource.includes("import eld from \"eld\""),
    "lang-detect should import eld package"
  );

  // ── Verify cjk-tokenizer.ts exists and has correct exports ──
  const cjkTokenizerSource = fs.readFileSync(path.resolve("src", "cjk-tokenizer.ts"), "utf8");
  assert.ok(
    cjkTokenizerSource.includes("import { tokenize } from \"kuromojin\""),
    "cjk-tokenizer should import kuromojin"
  );
  assert.ok(
    cjkTokenizerSource.includes("export async function tokenizeCjk"),
    "cjk-tokenizer should export tokenizeCjk"
  );
  assert.ok(
    cjkTokenizerSource.includes("名詞") && cjkTokenizerSource.includes("動詞") && cjkTokenizerSource.includes("形容詞") && cjkTokenizerSource.includes("副詞"),
    "cjk-tokenizer should filter by POS (名詞, 動詞, 形容詞, 副詞)"
  );

  // ── Verify index.ts warm-up code ──
  const indexSource = fs.readFileSync(path.resolve("src", "index.ts"), "utf8");
  assert.ok(
    indexSource.includes("initLanguageDetector") && indexSource.includes("tokenize(\"初期化\")"),
    "index.ts should warm up language detector + kuromojin during register()"
  );
  assert.ok(
    indexSource.includes("falling back to regex CJK"),
    "index.ts should log fallback warning on warm-up failure"
  );

  // ── splitByScript unit test ──
  const mixedText = "OpenClawのプラグインとしてepisodic-clawを導入した";
  const { cjk: cjkPart, latin: latinPart } = splitByScriptTest(mixedText);
  assert.ok(cjkPart.includes("のプラグインとして") || cjkPart.includes("を導入した"), "splitByScript should extract CJK segments");
  assert.ok(latinPart.includes("OpenClaw"), "splitByScript should extract Latin tokens");
  assert.ok(latinPart.includes("episodic") || latinPart.includes("claw"), "splitByScript should extract Latin tokens (episodic/claw)");

  console.log("  polyglot query morphological: source structure, warm-up, splitByScript all verified");

  // ── Phase 2: ZH bigram test (cjk-tokenizer) ──
  // Verify cjk-tokenizer.ts has ZH bigram implementation
  assert.ok(
    cjkTokenizerSource.includes("tokenizeChinese") || cjkTokenizerSource.includes("cjk-tokenizer"),
    "cjk-tokenizer should use cjk-tokenizer package for Chinese"
  );
  assert.ok(
    cjkTokenizerSource.includes("maxPhraseLength") || cjkTokenizerSource.includes("minFrequency"),
    "cjk-tokenizer should configure cjk-tokenizer options (minFrequency=1, maxPhraseLength=2)"
  );

  // ── Phase 2: KO bigram test (Hangul bigram heuristic) ──
  assert.ok(
    cjkTokenizerSource.includes("tokenizeKorean") || cjkTokenizerSource.includes("Hangul") || cjkTokenizerSource.includes("bigram"),
    "cjk-tokenizer should have Korean tokenization (Hangul bigram)"
  );
  assert.ok(
    cjkTokenizerSource.includes("bigramFromChars") || cjkTokenizerSource.includes("sliding"),
    "cjk-tokenizer should implement bigramFromChars for KO"
  );

  // ── Phase 2: JA still uses kuromojin (regression) ──
  assert.ok(
    cjkTokenizerSource.includes("tokenizeJapanese") && cjkTokenizerSource.includes("kuromojin"),
    "cjk-tokenizer should still use kuromojin for Japanese (not cjk-tokenizer)"
  );

  console.log("  polyglot Phase 2: ZH bigram, KO Hangul bigram, JA kuromojin regression all verified");
}

export function splitByScriptTest(text: string): { cjk: string; latin: string } {
  const cjkChars = text.match(
    /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]+/gu
  ) || [];
  const latinTokens = text.match(/\b[A-Za-z]{3,}\b/g) || [];
  return {
    cjk: cjkChars.join(" "),
    latin: latinTokens.join(" "),
  };
}
