import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, Module } from "node:module";
import { classifyRegistrationOrigin } from "./src/bug1-registration-origin.ts";

function makeMockApi() {
  const hooks: string[] = [];
  const api = {
    on(hookName: string) {
      hooks.push(`on:${hookName}`);
    },
    registerContextEngine(name: string) {
      hooks.push(`registerContextEngine:${name}`);
    },
    registerTool() {
      hooks.push("registerTool");
    },
    runtime: {
      config: {
        loadConfig() {
          return {
            agents: {
              list: [{ id: "main", default: true, workspace: "/tmp/workspace" }],
              defaults: { workspace: "/tmp/workspace" },
            },
          };
        },
      },
    },
  };
  return { api, hooks };
}

function withMockedGlobalErrorStack(stack: string, fn: () => void): void {
  const OriginalError = globalThis.Error;
  class MockError extends OriginalError {
    constructor(message?: string) {
      super(message);
      Object.defineProperty(this, "stack", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: stack,
      });
    }
  }

  try {
    globalThis.Error = MockError as unknown as ErrorConstructor;
    fn();
  } finally {
    globalThis.Error = OriginalError;
  }
}

const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-bug1-origin-"));
const runtimeDist = path.join(tempBase, "dist");
fs.mkdirSync(runtimeDist, { recursive: true });
const distJsFiles = [
  "anchor-store.js",
  "archiver.js",
  "bug1-registration-origin.js",
  "cjk-tokenizer.js",
  "compactor.js",
  "config.js",
  "gemini-direct-client.js",
  "index.js",
  "lang-detect.js",
  "large-payload.js",
  "narrative-pool.js",
  "narrative-queue.js",
  "narrative-worker.js",
  "openrouter-client.js",
  "reasoning-tags.js",
  "retriever.js",
  "rpc-client.js",
  "runtime-mode.js",
  "segmenter.js",
  "summary-escalation.js",
  "transcript-repair.js",
  "transport-retry.js",
  "types.js",
  "untrusted-metadata.js",
  "utils.js",
];
for (const file of distJsFiles) {
  fs.copyFileSync(path.join("dist", file), path.join(runtimeDist, file));
}

// Stub lang-detect.js and cjk-tokenizer.js for CJS require context — eld/kuromojin are ESM-only.
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
    const matches = text.match(/[\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}]{2,}/gu) || [];
    return { keywords: matches, lang: "ja" };
  }
  if (lang === "zh") {
    const chars = (text.match(/[\\p{Script=Han}]/gu) || []);
    const bigrams = [];
    for (let i = 0; i <= chars.length - 2; i++) bigrams.push(chars[i] + chars[i + 1]);
    return { keywords: bigrams, lang: "zh" };
  }
  if (lang === "ko") {
    const chars = (text.match(/[\\p{Script=Hangul}]/gu) || []);
    const bigrams = [];
    for (let i = 0; i <= chars.length - 2; i++) bigrams.push(chars[i] + chars[i + 1]);
    return { keywords: bigrams, lang: "ko" };
  }
  const cjkMatches = text.match(/[\\p{Script=Han}\\p{Script=Katakana}\\p{Script=Hiragana}\\p{Script=Hangul}]{2,}/gu) || [];
  return { keywords: cjkMatches, lang: lang || "unknown" };
}
`,
  "utf8"
);

const require = createRequire(path.join(runtimeDist, "index.js"));
const origNodePath = process.env.NODE_PATH;
process.env.NODE_PATH = path.resolve("node_modules");
Module._initPaths();
const pluginModule = require(path.join(runtimeDist, "index.js"));
const plugin = pluginModule.default ?? pluginModule;
process.env.NODE_PATH = origNodePath;
Module._initPaths();

assert.equal(
  classifyRegistrationOrigin(
    [
      "Error",
      "    at loadOpenClawPlugins (file:///tmp/openclaw/dist/loader.js:1:1)",
      "    at resolvePluginWebFetchProviders (file:///tmp/openclaw/dist/runtime-web-tools.js:1:1)",
      "    at resolveRuntimeWebTools (file:///tmp/openclaw/dist/runtime-web-tools.js:1:1)",
      "    at async prepareSecretsRuntimeSnapshot (file:///tmp/openclaw/dist/runtime.js:1:1)",
    ].join("\n")
  ),
  "web-fetch-snapshot"
);

assert.equal(
  classifyRegistrationOrigin(
    [
      "Error",
      "    at loadOpenClawPlugins (file:///tmp/openclaw/dist/loader.js:1:1)",
      "    at resolveRuntimePluginRegistry (file:///tmp/openclaw/dist/loader.js:1:1)",
      "    at ensureMemoryRuntime (file:///tmp/openclaw/dist/memory-runtime.js:1:1)",
      "    at resolveActiveMemoryBackendConfig (file:///tmp/openclaw/dist/memory-runtime.js:1:1)",
    ].join("\n")
  ),
  "memory-runtime"
);

assert.equal(
  classifyRegistrationOrigin(
    [
      "Error",
      "    at loadOpenClawPlugins (file:///tmp/openclaw/dist/loader.js:1:1)",
      "    at resolveRuntimePluginRegistry (file:///tmp/openclaw/dist/loader.js:1:1)",
      "    at ensureRuntimePluginsLoaded (file:///tmp/openclaw/dist/runtime.js:1:1)",
    ].join("\n")
  ),
  "embedded-runtime"
);

assert.equal(classifyRegistrationOrigin(undefined), "unknown");

const originalArgv = [...process.argv];
if (!process.argv.includes("test")) {
  process.argv.push("test");
}

try {
  withMockedGlobalErrorStack(
    [
      "Error",
      "    at loadOpenClawPlugins (file:///tmp/openclaw/dist/loader.js:1:1)",
      "    at resolvePluginWebFetchProviders (file:///tmp/openclaw/dist/runtime-web-tools.js:1:1)",
      "    at resolveRuntimeWebTools (file:///tmp/openclaw/dist/runtime-web-tools.js:1:1)",
      "    at async prepareSecretsRuntimeSnapshot (file:///tmp/openclaw/dist/runtime.js:1:1)",
    ].join("\n"),
    () => {
      const { api, hooks } = makeMockApi();
      plugin.register(api as never);
      assert.equal(hooks.length, 0, "web-fetch snapshot register should be a no-op");
    }
  );

  withMockedGlobalErrorStack(
    [
      "Error",
      "    at loadOpenClawPlugins (file:///tmp/openclaw/dist/loader.js:1:1)",
      "    at resolveRuntimePluginRegistry (file:///tmp/openclaw/dist/loader.js:1:1)",
      "    at ensureMemoryRuntime (file:///tmp/openclaw/dist/memory-runtime.js:1:1)",
      "    at resolveActiveMemoryBackendConfig (file:///tmp/openclaw/dist/memory-runtime.js:1:1)",
    ].join("\n"),
    () => {
      const { api, hooks } = makeMockApi();
      plugin.register(api as never);
      const firstCount = hooks.length;
      assert.ok(firstCount > 0, "first register should register hooks");
      plugin.register(api as never);
      assert.equal(hooks.length, firstCount, "duplicate api registration should be skipped");
    }
  );
} finally {
  process.argv.splice(0, process.argv.length, ...originalArgv);
}

console.log("BUG-1 registration origin tests passed ✅");
