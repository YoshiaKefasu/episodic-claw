import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, Module } from "node:module";
import {
  waitForTextContains,
  assertLogOrder,
  sleep
} from "./test_phase4_5_shared.ts";

export async function runGatewayStartSmoke(): Promise<void> {
  const previousArgv = [...process.argv];
  if (!process.argv.includes("test")) {
    process.argv.push("test");
  }

  const previousGemini = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;

  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-gateway-start-"));
  const agentRoot = path.join(tempBase, "workspace");
  const agentWs = path.join(agentRoot, "episodes");
  const nestedFile = path.join(agentWs, "episodes", "2026", "03", "31", "legacy_backlog_20260331_000001.md");
  const quarantineRoot = path.join(agentRoot, ".episodic-quarantine");
  const logPath = path.join(os.tmpdir(), "episodic-claw", new Date().toISOString().split("T")[0] + ".log");
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-runtime-"));
  const runtimeDist = path.join(runtimeRoot, "dist");
  const runtimeGo = path.join(runtimeRoot, "go");
  const observedSidecarLines: string[] = [];
  fs.mkdirSync(runtimeDist, { recursive: true });
  const distJsFiles = [
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
    "env-var.js",
    "runner_hardcoded.js",
    "runner.js",
    "summary-escalation.js",
    "segmenter.js",
    "transcript-repair.js",
    "transport-retry.js",
    "types.js",
    "utils.js",
    "bug1-registration-origin.js",
    "runtime-mode.js"
  ];
  for (const file of distJsFiles) {
    fs.copyFileSync(path.join("dist", file), path.join(runtimeDist, file));
  }

  // Stub lang-detect.js and cjk-tokenizer.js for CJS require context — eld/kuromojin are ESM-only.
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
  fs.cpSync("go", runtimeGo, { recursive: true });
  const require = createRequire(path.join(runtimeDist, "index.js"));
  process.env.NODE_PATH = path.resolve("node_modules");
  Module._initPaths();

  fs.rmSync(logPath, { force: true });
  fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
  fs.writeFileSync(nestedFile, "---\nid: legacy-1\ntitle: legacy\n---\nlegacy body\n", "utf8");

  const handlers = new Map<string, (event?: any, ctx?: any) => Promise<void> | void>();
  const previousLog = console.log;
  const previousWarn = console.warn;
  const collectObservedLine = (...args: any[]) => {
    const rendered = args
      .map((arg) => (typeof arg === "string" ? arg : String(arg)))
      .join(" ");
    for (const line of rendered.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) observedSidecarLines.push(trimmed);
    }
  };
  console.log = (...args: any[]) => {
    collectObservedLine(...args);
    return previousLog(...args);
  };
  console.warn = (...args: any[]) => {
    collectObservedLine(...args);
    return previousWarn(...args);
  };
  const mockApi = {
    on(hookName: string, handler: (event?: any, ctx?: any) => Promise<void> | void) {
      handlers.set(hookName, handler);
    },
    registerContextEngine() {},
    registerTool() {},
    runtime: {
      extensionAPI: {},
      config: {
        loadConfig() {
          return {
            agents: {
              list: [{ id: "main", default: true, workspace: agentRoot }],
              defaults: { workspace: agentRoot }
            },
          };
        }
      }
    }
  };

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

    const gatewayStart = handlers.get("gateway_start");
    const gatewayStop = handlers.get("gateway_stop");
    assert.ok(gatewayStart, "gateway_start handler should be registered");
    assert.ok(gatewayStop, "gateway_stop handler should be registered");

    const gatewayTimeline: string[] = [];
    gatewayTimeline.push("gateway_start:invoke");
    await gatewayStart!({ port: 0 }, {});
    gatewayTimeline.push("gateway_start:completed");

    const observedTimelineText = await waitForTextContains(() => {
      let fileText = "";
      try {
        fileText = fs.readFileSync(logPath, "utf8");
      } catch {}
      return `${observedSidecarLines.join("\n")}\n${fileText}`;
    }, [
      "Legacy nested episode tree isolated at",
      "Vector store is empty for",
      "Auto-Rebuild from Markdown",
      "HealingWorker: [Pass 3] Starting Stage 2 Batch Score update",
      "HealingWorker: [Pass 4] Starting GC (Tombstone older than 14 days)",
    ], 90000);

    assert.ok(!fs.existsSync(nestedFile), "nested tree should be removed from the active workspace");
    assert.ok(fs.existsSync(quarantineRoot), "quarantine root should exist after gateway_start");
    assert.ok(
      fs.readdirSync(quarantineRoot).some((name) => name.includes("nested-episodes")),
      "quarantine root should contain a migrated nested tree"
    );
    assert.ok(gatewayTimeline.indexOf("gateway_start:invoke") < gatewayTimeline.indexOf("gateway_start:completed"));
    assertLogOrder(observedTimelineText, [
      "Starting Go Sidecar on socket",
      "Method: watcher.start",
      "Legacy nested episode tree isolated at",
      "Vector store is empty for",
    ]);
    assertLogOrder(observedTimelineText, [
      "Method: watcher.start",
      "Legacy nested episode tree isolated at",
      "Vector store is empty for",
      "Starting Async Healing Worker for workspace:",
    ]);
    // Note: "Auto-Rebuild skipped: GEMINI_API_KEY not set" may appear at different positions
    // depending on async timing, so we check for existence rather than strict order
    assert.ok(observedTimelineText.includes("Auto-Rebuild skipped: GEMINI_API_KEY not set"),
      "HealingWorker should skip auto-rebuild when GEMINI_API_KEY is not set");

    await gatewayStop!({ reason: "test cleanup" }, {});
    await sleep(1000);
  } finally {
    console.log = previousLog;
    console.warn = previousWarn;
    process.argv.length = 0;
    process.argv.push(...previousArgv);
    if (previousGemini === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = previousGemini;
    }
  }
}
