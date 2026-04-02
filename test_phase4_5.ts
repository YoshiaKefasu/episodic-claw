import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire, Module } from "node:module";

function readJson(relPath: string): any {
  const absPath = path.resolve(relPath);
  return JSON.parse(fs.readFileSync(absPath, "utf8"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLogContains(logPath: string, needles: string[], timeoutMs = 45000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = fs.readFileSync(logPath, "utf8");
      if (needles.every((needle) => text.includes(needle))) {
        return text;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for log entries: ${needles.join(" | ")}`);
}

function assertLogOrder(text: string, needles: string[]): void {
  let cursor = 0;
  for (const needle of needles) {
    const idx = text.indexOf(needle, cursor);
    assert.ok(idx >= 0, `Expected log entry not found in order: ${needle}`);
    cursor = idx + needle.length;
  }
}

async function runGatewayStartSmoke(): Promise<void> {
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
  const logPath = path.join(os.tmpdir(), "episodic-core.log");
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-runtime-"));
  const runtimeDist = path.join(runtimeRoot, "dist");
  const runtimeGo = path.join(runtimeRoot, "go");
  const observedSidecarLines: string[] = [];
  fs.mkdirSync(runtimeDist, { recursive: true });
  const distJsFiles = [
    "compactor.js",
    "config.js",
    "index.js",
    "retriever.js",
    "rpc-client.js",
    "runner_hardcoded.js",
    "runner.js",
    "segmenter.js",
    "types.js",
    "utils.js"
  ];
  for (const file of distJsFiles) {
    fs.copyFileSync(path.join("dist", file), path.join(runtimeDist, file));
  }
  fs.cpSync("go", runtimeGo, { recursive: true });
  const require = createRequire(path.join(runtimeDist, "index.js"));
  process.env.NODE_PATH = path.resolve("node_modules");
  Module._initPaths();

  fs.rmSync(logPath, { force: true });
  fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
  fs.writeFileSync(nestedFile, "---\nid: legacy-1\ntitle: legacy\n---\nlegacy body\n", "utf8");

  const handlers = new Map<string, (event?: any, ctx?: any) => Promise<void> | void>();
  const previousWarn = console.warn;
  console.warn = (...args: any[]) => {
    const rendered = args
      .map((arg) => (typeof arg === "string" ? arg : String(arg)))
      .join(" ");
    for (const line of rendered.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) observedSidecarLines.push(trimmed);
    }
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

    const logText = await waitForLogContains(logPath, [
      "Legacy nested episode tree isolated at",
      "Vector store is empty for",
      "triggering Auto-Rebuild from Markdown",
      "HealingWorker: [Pass 3] Starting Stage 2 Batch Score update...",
      "HealingWorker: [Pass 4] Starting GC (Tombstone older than 14 days)...",
    ]);

    assert.ok(!fs.existsSync(nestedFile), "nested tree should be removed from the active workspace");
    assert.ok(fs.existsSync(quarantineRoot), "quarantine root should exist after gateway_start");
    assert.ok(
      fs.readdirSync(quarantineRoot).some((name) => name.includes("nested-episodes")),
      "quarantine root should contain a migrated nested tree"
    );
    assert.ok(gatewayTimeline.indexOf("gateway_start:invoke") < gatewayTimeline.indexOf("gateway_start:completed"));
    assertLogOrder(logText, [
      "Starting Go Sidecar on socket",
      "Method: watcher.start",
      "Legacy nested episode tree isolated at",
      "Vector store is empty for",
    ]);
    assertLogOrder(observedSidecarLines.join("\n"), [
      "Method: watcher.start",
      "Legacy nested episode tree isolated at",
      "Vector store is empty for",
      "Starting Async Healing Worker for workspace:",
      "Auto-Rebuild skipped: GEMINI_API_KEY not set",
    ]);

    await gatewayStop!({ reason: "test cleanup" }, {});
    await sleep(1000);
  } finally {
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

async function main() {
  const pkg = readJson("package.json");
  const manifest = readJson("openclaw.plugin.json");
  const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
  const planSource = fs.readFileSync(path.resolve("docs", "v0.2.5_fix_plan.md"), "utf8");
  const configSource = fs.readFileSync(path.resolve("src", "config.ts"), "utf8");
  const indexSource = fs.readFileSync(path.resolve("src", "index.ts"), "utf8");
  const retrieverSource = fs.readFileSync(path.resolve("src", "retriever.ts"), "utf8");
  const rpcClientSource = fs.readFileSync(path.resolve("src", "rpc-client.ts"), "utf8");
  const postinstallSource = fs.readFileSync(path.resolve("scripts", "postinstall.cjs"), "utf8");

  assert.equal(pkg.version, "0.2.5", "package.json version should be 0.2.5");
  assert.equal(manifest.version, "0.2.5", "openclaw.plugin.json version should be 0.2.5");
  assert.match(changelog, /\[0\.2\.5\]/, "CHANGELOG should mention v0.2.5");
  assert.match(
    planSource,
    /5\.1\) freshness contract[\s\S]*eventual freshness/,
    "v0.2.5 fix plan should define the eventual freshness contract"
  );
  assert.match(
    configSource,
    /reserveTokens:\s*rawConfig\?\.reserveTokens\s*\?\?\s*2048/,
    "reserveTokens default should stay at 2048 in src/config.ts"
  );
  assert.match(
    configSource,
    /recentKeep:\s*rawConfig\?\.recentKeep\s*\?\?\s*96/,
    "recentKeep default should stay at 96 in src/config.ts"
  );
  assert.doesNotMatch(
    configSource,
    /sharedEpisodesDir|allowCrossAgentRecall/,
    "sharedEpisodesDir and allowCrossAgentRecall should be disabled in loadConfig"
  );
  assert.match(
    indexSource,
    /clearRecallCache\(state\);\s*await state\.segmenter\.processTurn\(msgs, agentWs, agentId\);/s,
    "ingest should clear recall cache before segmenting"
  );
  assert.match(
    indexSource,
    /await state\.segmenter\.processTurn\(msgs, agentWs, agentId\);\s*\/\/ \[Fix D-3\] setMeta rate-limit/s,
    "ingest should keep the post-segment cache invalidation path nearby"
  );
  assert.doesNotMatch(
    indexSource,
    /cfg\.allowCrossAgentRecall|legacyReadWs|sharedWs|lastLegacyWs/,
    "index.ts should not contain shared or cross-agent recall runtime paths"
  );
  assert.doesNotMatch(
    indexSource,
    /\/\/ fire-and-forget[\s\S]*?clearRecallCache\(state\);[\s\S]*?state\.segmenter\.processTurn\(msgs, agentWs, agentId\)/,
    "assemble should not clear recall cache before evaluating debounce hits"
  );
  assert.match(
    indexSource,
    /const results = \(primaryResults \?\? \[\]\)\.slice\(0, k\);/,
    "ep-recall should use only the agent workspace results"
  );
  assert.match(
    indexSource,
    /invalidateRecallCacheForWorkspace\(agentWs\);\s*const runes = Array\.from\(raw\);/s,
    "ep-save should invalidate recall caches for the whole workspace"
  );
  assert.doesNotMatch(
    retrieverSource,
    /legacyAgentWs|sources\.push|legacy workspace/,
    "retriever should no longer dual-read legacy workspaces"
  );
  assert.match(
    rpcClientSource,
    /event\?\.Path \?\? event\?\.path/,
    "file change events should accept both Path and path casing"
  );
  assert.match(
    postinstallSource,
    /const skipPostinstall = process\.env\.EPISODIC_SKIP_POSTINSTALL === "1";/,
    "postinstall should support EPISODIC_SKIP_POSTINSTALL"
  );
  assert.match(
    postinstallSource,
    /function warnAndContinue\(reason\)/,
    "postinstall should warn and continue when download fails"
  );
  assert.doesNotMatch(
    postinstallSource,
    /process\.exit\(1\)/,
    "postinstall should not hard-fail npm install on download errors"
  );

  await runGatewayStartSmoke();

  console.log("phase4_5 smoke: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
