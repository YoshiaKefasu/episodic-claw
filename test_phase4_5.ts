import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

function readJson(relPath: string): any {
  const absPath = path.resolve(relPath);
  return JSON.parse(fs.readFileSync(absPath, "utf8"));
}

function main() {
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

  console.log("phase4_5 smoke: ok");
}

main();
