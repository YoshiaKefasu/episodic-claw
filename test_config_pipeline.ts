/**
 * Config Pipeline Test — v0.4.15
 *
 * Automated verification that every field in EpisodicPluginConfig (types.ts)
 * is extracted by loadConfig() (config.ts). Prevents the recurring bug pattern
 * where a config field is defined in the type but silently dropped by loadConfig().
 *
 * Also verifies:
 * - Nested → flat field paths (openrouterConfig.model → openrouterModel, etc.)
 * - Default value consistency between code and openclaw.plugin.json
 * - Edge cases (0 values, undefined, nested extraction)
 *
 * Run: npx tsx test_config_pipeline.ts
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, normalizeOpenRouterReasoning } from "./src/config";
import type { EpisodicPluginConfig } from "./src/types";

// ─── Helpers ────────────────────────────────────────────────────────

import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;

function readSource(filename: string): string {
  return fs.readFileSync(path.join(ROOT, filename), "utf8");
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e: any) {
    failed++;
    const msg = e?.message ?? String(e);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name}`);
    console.log(`     ${msg}`);
  }
}

// ─── 1. Field Coverage: types.ts ↔ loadConfig() ────────────────────

console.log("\n=== 1. Field Coverage: types.ts ↔ loadConfig() ===\n");

test("every EpisodicPluginConfig field appears in loadConfig() output", () => {
  // Get all keys from the type by calling loadConfig({}) and checking undefined keys
  // loadConfig with empty input should return all fields with defaults
  const defaults = loadConfig({});

  // Manually enumerate all expected keys from types.ts EpisodicPluginConfig
  // (TypeScript types are erased at runtime, so we define the expected set here)
  const expectedKeys: (keyof EpisodicPluginConfig)[] = [
    "tombstoneRetentionDays",
    "enableBackgroundWorkers",
    "lexicalPreFilterLimit",
    "reserveTokens",
    "autoInjectGuardMinScore",
    "anchorInjectionAssembles",
    "dedupWindow",
    "maxBufferChars",
    "maxCharsPerChunk",
    "segmentationLambda",
    "segmentationWarmupCount",
    "segmentationMinRawSurprise",
    "segmentationCooldownTurns",
    "segmentationStdFloor",
    "segmentationFallbackThreshold",
    "segmentationTimeGapMinutes",
    "recallSemanticFloor",
    "recallUsefulnessClamp",
    "recallReplayTieBreakMaxBoost",
    "recallReplayLowRetrievabilityBonus",
    "recallTopicsMatchBoost",
    "recallTopicsMismatchPenalty",
    "recallTopicsMissingPenalty",
    "recallReInjectionCooldownTurns",
    "lexicalRebuildIntervalDays",
    "recallQueryRecentMessageCount",
    "queryExcludedKeywords",
    "openrouterApiKey",
    "openrouterModel",
    "openrouterMaxTokens",
    "narrativeSystemPrompt",
    "narrativeUserPromptTemplate",
    "maxPoolChars",
    "narrativePreviousEpisodeRef",
    "narrativeTemperature",
    "openrouterReasoning",
  ];

  const missingKeys: string[] = [];
  for (const key of expectedKeys) {
    if (!(key in defaults)) {
      missingKeys.push(key);
    }
  }
  assert.deepEqual(missingKeys, [], `Missing keys in loadConfig() output: ${missingKeys.join(", ")}`);
});

test("loadConfig() has no keys not in EpisodicPluginConfig", () => {
  const defaults = loadConfig({});

  const expectedKeys = new Set([
    "tombstoneRetentionDays",
    "enableBackgroundWorkers",
    "lexicalPreFilterLimit",
    "reserveTokens",
    "autoInjectGuardMinScore",
    "anchorInjectionAssembles",
    "dedupWindow",
    "maxBufferChars",
    "maxCharsPerChunk",
    "segmentationLambda",
    "segmentationWarmupCount",
    "segmentationMinRawSurprise",
    "segmentationCooldownTurns",
    "segmentationStdFloor",
    "segmentationFallbackThreshold",
    "segmentationTimeGapMinutes",
    "recallSemanticFloor",
    "recallUsefulnessClamp",
    "recallReplayTieBreakMaxBoost",
    "recallReplayLowRetrievabilityBonus",
    "recallTopicsMatchBoost",
    "recallTopicsMismatchPenalty",
    "recallTopicsMissingPenalty",
    "recallReInjectionCooldownTurns",
    "lexicalRebuildIntervalDays",
    "recallQueryRecentMessageCount",
    "queryExcludedKeywords",
    "openrouterApiKey",
    "openrouterModel",
    "openrouterMaxTokens",
    "narrativeSystemPrompt",
    "narrativeUserPromptTemplate",
    "maxPoolChars",
    "narrativePreviousEpisodeRef",
    "narrativeTemperature",
    "openrouterReasoning",
  ]);

  const extraKeys: string[] = [];
  for (const key of Object.keys(defaults)) {
    if (!expectedKeys.has(key)) {
      extraKeys.push(key);
    }
  }
  assert.deepEqual(extraKeys, [], `Extra keys in loadConfig() output not in type: ${extraKeys.join(", ")}`);
});

// ─── 2. Nested → Flat Field Extraction ──────────────────────────────

console.log("\n=== 2. Nested → Flat Field Extraction ===\n");

test("openrouterConfig.model → openrouterModel (with flat fallback)", () => {
  const cfg = loadConfig({ openrouterConfig: { model: "test-model" } });
  assert.equal(cfg.openrouterModel, "test-model");
});

test("openrouterConfig.model falls back to flat openrouterModel", () => {
  const cfg = loadConfig({ openrouterModel: "flat-model" });
  assert.equal(cfg.openrouterModel, "flat-model");
});

test("openrouterConfig.model takes precedence over flat openrouterModel", () => {
  const cfg = loadConfig({ openrouterConfig: { model: "nested-model" }, openrouterModel: "flat-model" });
  assert.equal(cfg.openrouterModel, "nested-model");
});

test("openrouterConfig.maxTokens → openrouterMaxTokens", () => {
  const cfg = loadConfig({ openrouterConfig: { maxTokens: 4096 } });
  assert.equal(cfg.openrouterMaxTokens, 4096);
});

test("openrouterMaxTokens is undefined when not set", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.openrouterMaxTokens, undefined);
});

test("openrouterConfig.temperature → narrativeTemperature", () => {
  const cfg = loadConfig({ openrouterConfig: { temperature: 0.7 } });
  assert.equal(cfg.narrativeTemperature, 0.7);
});

test("openrouterConfig.reasoning → openrouterReasoning", () => {
  const cfg = loadConfig({ openrouterConfig: { reasoning: { enabled: true, effort: "low" } } });
  assert.ok(cfg.openrouterReasoning, "openrouterReasoning should be defined");
  assert.equal(cfg.openrouterReasoning!.effort, "low");
});

// ─── 3. Default Value Consistency ────────────────────────────────────

console.log("\n=== 3. Default Value Consistency ===\n");

test("loadConfig({}) returns correct defaults for all fields", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.tombstoneRetentionDays, 14);
  assert.equal(cfg.enableBackgroundWorkers, true);
  assert.equal(cfg.lexicalPreFilterLimit, 1000);
  assert.equal(cfg.reserveTokens, 2048);
  assert.equal(cfg.autoInjectGuardMinScore, 0.86);
  assert.equal(cfg.anchorInjectionAssembles, 1);
  assert.equal(cfg.dedupWindow, 5);
  assert.equal(cfg.maxBufferChars, 7200);
  assert.equal(cfg.maxCharsPerChunk, 9000);
  assert.equal(cfg.segmentationLambda, 2.0);
  assert.equal(cfg.segmentationWarmupCount, 10);  // Phase 3: was 20
  assert.equal(cfg.segmentationMinRawSurprise, 0.05);
  assert.equal(cfg.segmentationCooldownTurns, 2);
  assert.equal(cfg.segmentationStdFloor, 0.01);
  assert.equal(cfg.segmentationFallbackThreshold, 0.2);
  assert.equal(cfg.segmentationTimeGapMinutes, 15);
  assert.equal(cfg.recallSemanticFloor, 0.35);
  assert.equal(cfg.recallUsefulnessClamp, 1.0);
  assert.equal(cfg.recallReplayTieBreakMaxBoost, 0.04);
  assert.equal(cfg.recallReplayLowRetrievabilityBonus, 0.01);
  assert.equal(cfg.recallTopicsMatchBoost, 0.05);
  assert.equal(cfg.recallTopicsMismatchPenalty, 0.10);
  assert.equal(cfg.recallTopicsMissingPenalty, 0.0);
  assert.equal(cfg.recallReInjectionCooldownTurns, 24);
  assert.equal(cfg.lexicalRebuildIntervalDays, 7);
  assert.equal(cfg.recallQueryRecentMessageCount, 4);
  assert.deepEqual(cfg.queryExcludedKeywords, []);
  assert.equal(cfg.openrouterModel, "openrouter/free");
  assert.equal(cfg.openrouterMaxTokens, undefined);  // No default max tokens
  assert.equal(cfg.narrativeTemperature, 0.4);
  assert.equal(cfg.maxPoolChars, 15000);
  assert.equal(cfg.narrativePreviousEpisodeRef, true);
});

test("segmentationWarmupCount default is 10 (not 20 — Phase 3 fix)", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.segmentationWarmupCount, 10);
});

test("recallReInjectionCooldownTurns default is 24 (not 10 — loadConfig has priority)", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.recallReInjectionCooldownTurns, 24);
});

// ─── 4. Edge Cases ──────────────────────────────────────────────────

console.log("\n=== 4. Edge Cases ===\n");

test("openrouterConfig.maxTokens: 0 passes through as 0 (not undefined)", () => {
  // Note: openrouterMaxTokens has no ?? fallback, so 0 should pass through
  const cfg = loadConfig({ openrouterConfig: { maxTokens: 0 } });
  assert.equal(cfg.openrouterMaxTokens, 0);
});

test("recallReInjectionCooldownTurns: 0 preserves user intent (disable guard)", () => {
  const cfg = loadConfig({ recallReInjectionCooldownTurns: 0 });
  assert.equal(cfg.recallReInjectionCooldownTurns, 0);
});

test("recallQueryRecentMessageCount is clamped to 1..12 range", () => {
  const tooLow = loadConfig({ recallQueryRecentMessageCount: 0 });
  assert.equal(tooLow.recallQueryRecentMessageCount, 1, "minimum should be 1");

  const tooHigh = loadConfig({ recallQueryRecentMessageCount: 100 });
  assert.equal(tooHigh.recallQueryRecentMessageCount, 12, "maximum should be 12");

  const justRight = loadConfig({ recallQueryRecentMessageCount: 5 });
  assert.equal(justRight.recallQueryRecentMessageCount, 5);
});

test("queryExcludedKeywords defaults to empty array when not set", () => {
  const cfg = loadConfig({});
  assert.ok(Array.isArray(cfg.queryExcludedKeywords));
  assert.equal(cfg.queryExcludedKeywords!.length, 0);
});

test("queryExcludedKeywords preserves user-provided array", () => {
  const cfg = loadConfig({ queryExcludedKeywords: ["url", "image", "link"] });
  assert.deepEqual(cfg.queryExcludedKeywords, ["url", "image", "link"]);
});

test("autoInjectGuardMinScore is clamped to 0..1 range", () => {
  const tooHigh = loadConfig({ autoInjectGuardMinScore: 5.0 });
  assert.equal(tooHigh.autoInjectGuardMinScore, 1.0, "above 1 should be clamped to 1");

  const negative = loadConfig({ autoInjectGuardMinScore: -0.5 });
  assert.equal(negative.autoInjectGuardMinScore, 0, "below 0 should be clamped to 0");

  const normal = loadConfig({ autoInjectGuardMinScore: 0.75 });
  assert.equal(normal.autoInjectGuardMinScore, 0.75);
});

test("narrativeTemperature is clamped to 0..1 range", () => {
  const tooHigh = loadConfig({ narrativeTemperature: 2.0 });
  assert.equal(tooHigh.narrativeTemperature, 1.0);

  const negative = loadConfig({ narrativeTemperature: -0.5 });
  assert.equal(negative.narrativeTemperature, 0);

  const viaNested = loadConfig({ openrouterConfig: { temperature: 0.8 } });
  assert.equal(viaNested.narrativeTemperature, 0.8);
});

test("normalizeOpenRouterReasoning: enabled=false returns undefined", () => {
  const result = normalizeOpenRouterReasoning({ enabled: false });
  assert.equal(result, undefined);
});

test("normalizeOpenRouterReasoning: maxTokens takes precedence over effort", () => {
  const result = normalizeOpenRouterReasoning({ enabled: true, effort: "low", maxTokens: 4096 });
  assert.equal(result!.maxTokens, 4096);
  assert.equal(result!.effort, undefined, "effort should be dropped when maxTokens is present");
});

// ─── 5. openclaw.plugin.json Default Consistency ────────────────────

console.log("\n=== 5. openclaw.plugin.json Default Consistency ===\n");

test("segmentationWarmupCount default in plugin.json matches loadConfig (10, not 20)", () => {
  const pluginJson = JSON.parse(readSource("openclaw.plugin.json"));
  const warmup = pluginJson.configSchema.properties.segmentationWarmupCount;
  assert.ok(warmup, "segmentationWarmupCount should exist in plugin.json schema");
  const desc = warmup.description ?? warmup.title ?? "";
  // The description should say "Default: 10" not "Default: 20"
  assert.match(desc, /Default:\s*10/, `segmentationWarmupCount description should say "Default: 10" but got: ${desc.slice(0, 60)}`);
});

test("recallReInjectionCooldownTurns default in plugin.json matches loadConfig (24)", () => {
  const pluginJson = JSON.parse(readSource("openclaw.plugin.json"));
  const cooldown = pluginJson.configSchema.properties.recallReInjectionCooldownTurns;
  assert.ok(cooldown, "recallReInjectionCooldownTurns should exist in plugin.json schema");
  const desc = cooldown.description ?? cooldown.title ?? "";
  assert.match(desc, /Default:\s*24/, `recallReInjectionCooldownTurns description should say "Default: 24" but got: ${desc.slice(0, 80)}`);
});

test("recallQueryRecentMessageCount default in plugin.json matches loadConfig (4)", () => {
  const pluginJson = JSON.parse(readSource("openclaw.plugin.json"));
  const field = pluginJson.configSchema.properties.recallQueryRecentMessageCount;
  assert.ok(field, "recallQueryRecentMessageCount should exist in plugin.json schema");
  const defaultValue = field.default;
  const desc = field.description ?? "";
  // Check either the "default" property or the description
  if (defaultValue !== undefined) {
    assert.equal(defaultValue, 4, `recallQueryRecentMessageCount default should be 4, got ${defaultValue}`);
  } else {
    assert.match(desc, /Default:\s*4/, `recallQueryRecentMessageCount description should say "Default: 4" but got: ${desc.slice(0, 80)}`);
  }
});

// ─── 6. Regression Guards (Previously Missing Fields) ─────────────────

console.log("\n=== 6. Regression Guards (Previously Missing Fields) ===\n");

test("REGRESSION: narrativePreviousEpisodeRef is not silently dropped (v0.4.13 fix)", () => {
  const cfg = loadConfig({ narrativePreviousEpisodeRef: false });
  assert.equal(cfg.narrativePreviousEpisodeRef, false, "user's false should be preserved, not overridden to default true");
});

test("REGRESSION: recallQueryRecentMessageCount is not silently dropped (v0.4.14 fix)", () => {
  const cfg = loadConfig({ recallQueryRecentMessageCount: 8 });
  assert.equal(cfg.recallQueryRecentMessageCount, 8);
});

test("REGRESSION: queryExcludedKeywords is not silently dropped (v0.4.14 fix)", () => {
  const cfg = loadConfig({ queryExcludedKeywords: ["test"] });
  assert.deepEqual(cfg.queryExcludedKeywords, ["test"]);
});

test("REGRESSION: openrouterMaxTokens is not silently dropped (v0.4.15 fix)", () => {
  const cfg = loadConfig({ openrouterConfig: { maxTokens: 2048 } });
  assert.equal(cfg.openrouterMaxTokens, 2048, "openrouterConfig.maxTokens should be extracted to openrouterMaxTokens");
});

test("REGRESSION: openrouterConfig nested fields are all destructured into flat fields", () => {
  // Verify that every nested openrouterConfig field has a corresponding flat output
  const cfg = loadConfig({
    openrouterConfig: {
      model: "test-model",
      maxTokens: 8192,
      temperature: 0.3,
      reasoning: { enabled: true, effort: "medium" },
    },
  });

  assert.equal(cfg.openrouterModel, "test-model", "openrouterConfig.model → openrouterModel");
  assert.equal(cfg.openrouterMaxTokens, 8192, "openrouterConfig.maxTokens → openrouterMaxTokens");
  assert.equal(cfg.narrativeTemperature, 0.3, "openrouterConfig.temperature → narrativeTemperature");
  assert.ok(cfg.openrouterReasoning, "openrouterConfig.reasoning → openrouterReasoning");
  assert.equal(cfg.openrouterReasoning!.enabled, true);
});

// ─── 7. v0.4.19a Bug #0: Config Propagation ────────────────────────────

console.log("\n=== 7. v0.4.19a Bug #0: Config Propagation ===\n");

test("loadConfig() receives plugin-specific config from api.pluginConfig", () => {
  const pluginSpecificConfig = {
    narrativeSystemPrompt: "inline system prompt",
    narrativeUserPromptTemplate: "inline user prompt",
    tombstoneRetentionDays: 30,
  };
  const cfg = loadConfig(pluginSpecificConfig);
  assert.equal(cfg.narrativeSystemPrompt, "inline system prompt");
  assert.equal(cfg.narrativeUserPromptTemplate, "inline user prompt");
  assert.equal(cfg.tombstoneRetentionDays, 30);
});

test("loadConfig() returns defaults when passed empty plugin-specific config", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.narrativeSystemPrompt, "");  // DEFAULT used
  assert.equal(cfg.narrativeUserPromptTemplate, "");  // DEFAULT used
  assert.equal(cfg.tombstoneRetentionDays, 14);  // default
});

test("loadConfig() does NOT extract narrativeSystemPrompt from global config top-level (Bug #0 regression guard)", () => {
  // This verifies the Bug #0 root cause: passing the global config to loadConfig()
  // means narrativeSystemPrompt is looked for at the top level, where it doesn't exist.
  // After Fix 0, index.ts no longer passes the global config — it passes pluginSpecificConfig.
  // This test ensures that if someone accidentally reverts the extraction logic,
  // the bug would be caught immediately.
  const globalConfig = {
    agents: { default: { id: "test" } },
    plugins: {
      entries: {
        "episodic-claw": {
          config: {
            narrativeSystemPrompt: "should NOT be found at top level",
          },
        },
      },
    },
  };
  const cfg = loadConfig(globalConfig);
  // narrativeSystemPrompt is NOT at globalConfig.narrativeSystemPrompt → undefined → ""
  assert.equal(cfg.narrativeSystemPrompt, "");  // Bug #0 in action!
});

test("index.ts extracts pluginConfig or falls back to plugins.entries[episodic-claw].config", () => {
  // Simulates the fix in index.ts: api.pluginConfig || globalConfig.plugins.entries["episodic-claw"].config
  const globalConfig = {
    plugins: {
      entries: {
        "episodic-claw": {
          config: {
            narrativeSystemPrompt: "custom prompt from entries",
          },
        },
      },
    },
  };

  // Case 1: api.pluginConfig is available (preferred)
  const pluginConfig = { narrativeSystemPrompt: "from api.pluginConfig" };
  const extracted1 = pluginConfig || globalConfig?.plugins?.entries?.["episodic-claw"]?.config || {};
  const cfg1 = loadConfig(extracted1);
  assert.equal(cfg1.narrativeSystemPrompt, "from api.pluginConfig");

  // Case 2: api.pluginConfig is undefined (fallback to entries)
  const extracted2 = undefined || globalConfig?.plugins?.entries?.["episodic-claw"]?.config || {};
  const cfg2 = loadConfig(extracted2);
  assert.equal(cfg2.narrativeSystemPrompt, "custom prompt from entries");

  // Case 3: Neither available — no episodic-claw entry
  const emptyGlobalConfig = {};
  const extracted3 = undefined || emptyGlobalConfig?.plugins?.entries?.["episodic-claw"]?.config || {};
  const cfg3 = loadConfig(extracted3);
  assert.equal(cfg3.narrativeSystemPrompt, "");  // DEFAULT
});

test("recallQueryRecentMessageCount propagates from plugin-specific config (Bug #0 + Bug #3 regression)", () => {
  const pluginSpecificConfig = {
    recallQueryRecentMessageCount: 2,
  };
  const cfg = loadConfig(pluginSpecificConfig);
  assert.equal(cfg.recallQueryRecentMessageCount, 2, "should use plugin-specific value, not default 4");
});

// ─── 8. v0.4.19a Bug #1: resolvePrompt Cross-Platform ────────────────────

console.log("\n=== 8. v0.4.19a Bug #1: resolvePrompt Cross-Platform ===\n");

test("resolvePrompt resolves Linux absolute path on Windows via HOME mapping", () => {
  const originalHome = process.env.HOME;
  const tmpDir = path.join(os.tmpdir(), "episodic-test-home");
  fs.mkdirSync(path.join(tmpDir, ".openclaw", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".openclaw", "prompts", "test.md"), "test content", "utf8");
  process.env.HOME = tmpDir;

  try {
    // Inject platform='win32' so the /home/ mapping candidate is added
    // even when running on Linux/macOS CI
    const cfg = loadConfig(
      { narrativeSystemPrompt: "/home/testuser/.openclaw/prompts/test.md" },
      { platform: "win32" }
    );
    // Should resolve via HOME mapping (skipping /home/testuser/ → HOME/)
    assert.equal(cfg.narrativeSystemPrompt, "test content");
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolvePrompt does NOT add /home/ mapping on non-Windows platform", () => {
  const originalHome = process.env.HOME;
  const tmpDir = path.join(os.tmpdir(), "episodic-test-no-mapping");
  fs.mkdirSync(path.join(tmpDir, ".openclaw", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".openclaw", "prompts", "test.md"), "test content", "utf8");
  process.env.HOME = tmpDir;

  try {
    // On Linux/macOS, /home/ paths should NOT be mapped to HOME
    const cfg = loadConfig(
      { narrativeSystemPrompt: "/home/testuser/.openclaw/prompts/test.md" },
      { platform: "linux" }
    );
    // path.resolve("/home/testuser/...") on Linux would try the actual path,
    // which doesn't exist in our tmpDir → returns ""
    assert.equal(cfg.narrativeSystemPrompt, "");
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolvePrompt resolves ~/ path on all platforms", () => {
  const tmpDir = path.join(os.tmpdir(), "episodic-test-tilde");
  fs.mkdirSync(path.join(tmpDir, ".openclaw", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, ".openclaw", "prompts", "test.md"), "tilde content", "utf8");
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;

  try {
    const cfg = loadConfig({
      narrativeSystemPrompt: "~/.openclaw/prompts/test.md"
    });
    assert.equal(cfg.narrativeSystemPrompt, "tilde content");
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("resolvePrompt returns inline text unchanged", () => {
  const cfg = loadConfig({
    narrativeSystemPrompt: "This is inline text, not a file path"
  });
  assert.equal(cfg.narrativeSystemPrompt, "This is inline text, not a file path");
});

test("resolvePrompt returns empty string for nonexistent file", () => {
  const cfg = loadConfig({
    narrativeSystemPrompt: "/nonexistent/path/prompt.md"
  });
  assert.equal(cfg.narrativeSystemPrompt, "");
});

test("resolvePrompt resolves Windows absolute path directly", () => {
  const tmpDir = path.join(os.tmpdir(), "episodic-test-win");
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, "prompt.md");
  fs.writeFileSync(filePath, "windows content", "utf8");

  try {
    const cfg = loadConfig({
      narrativeSystemPrompt: filePath
    });
    assert.equal(cfg.narrativeSystemPrompt, "windows content");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Summary ────────────────────────────────────────────────

console.log("\n" + "═".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  • ${f}`);
  }
}
console.log("═".repeat(60) + "\n");

process.exit(failed > 0 ? 1 : 0);