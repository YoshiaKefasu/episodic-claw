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

function loadCompactorCtor(): typeof import("./src/compactor.ts").Compactor {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-compactor-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "compactor.cjs");
  fs.copyFileSync(path.resolve("dist", "compactor.js"), tempCjsPath);
  for (const file of [
    "large-payload.js",
    "rpc-client.js",
    "segmenter.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "types.js",
    "utils.js",
  ]) {
    fs.copyFileSync(path.join("dist", file), path.join(tempDir, file));
  }
  const require = createRequire(import.meta.url);
  return require(tempCjsPath).Compactor;
}

function loadCompactorModule(): typeof import("./src/compactor.ts") {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `episodic-claw-compactor-module-${process.pid}-`));
  const tempCjsPath = path.join(tempDir, "compactor.cjs");
  fs.copyFileSync(path.resolve("dist", "compactor.js"), tempCjsPath);
  for (const file of [
    "large-payload.js",
    "rpc-client.js",
    "segmenter.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "types.js",
    "utils.js",
  ]) {
    fs.copyFileSync(path.join("dist", file), path.join(tempDir, file));
  }
  const require = createRequire(import.meta.url);
  return require(tempCjsPath);
}

async function runAnchorInjectionSmoke(): Promise<void> {
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
    "large-payload.js",
    "compactor.js",
    "config.js",
    "index.js",
    "retriever.js",
    "rpc-client.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "segmenter.js",
    "types.js",
    "utils.js",
  ]) {
    fs.copyFileSync(path.join("dist", file), path.join(runtimeDist, file));
  }

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
  }
}

async function runDegradedFallbackGuardSmoke(): Promise<void> {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-retriever-runtime-"));
  const runtimeDist = path.join(runtimeRoot, "dist");
  fs.mkdirSync(runtimeDist, { recursive: true });
  for (const file of [
    "large-payload.js",
    "compactor.js",
    "config.js",
    "retriever.js",
    "rpc-client.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "segmenter.js",
    "types.js",
    "utils.js",
  ]) {
    const target = file === "retriever.js"
      ? path.join(runtimeDist, "retriever.cjs")
      : path.join(runtimeDist, file);
    fs.copyFileSync(path.join("dist", file), target);
  }
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
}

async function runCompactionModelSmoke(): Promise<void> {
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-compaction-"));
  const agentWs = path.join(tempBase, "episodes");
  const sessionFile = path.join(tempBase, "session.json");
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
  fs.writeFileSync(
    sessionFile,
    JSON.stringify(
      {
        messages,
      },
      null,
      2
    ),
    "utf8"
  );

  let lastWatermark: { dateSeq: string; absIndex: number } | null = null;
  const rpcClient = {
    async getWatermark() {
      return { dateSeq: "20260403-18", absIndex: 17 };
    },
    async setWatermark(_workspace: string, watermark: { dateSeq: string; absIndex: number }) {
      lastWatermark = watermark;
    },
    async triggerBackgroundIndex() {
      return "ok";
    },
    async batchIngest() {
      return [];
    },
  };
  const segmenter = {
    async forceFlush() {},
  };

  const { Compactor, DEFAULT_ANCHOR_BRIDGE_TEMPLATE, DEFAULT_COMPACTION_BRIDGE_TEMPLATE } = loadCompactorModule();
  const compactor = new Compactor(rpcClient as any, segmenter as any, 15);
  const result = await compactor.compact({
    sessionFile,
    resolvedAgentWs: agentWs,
    agentId: "main",
  });

  assert.equal(result.ok, true, "compaction should succeed");
  assert.equal(result.compacted, true, "compaction should rewrite the session");
  assert.match(result.result?.anchor ?? "", /\[Compaction Anchor\]/, "anchor payload should be returned");
  assert.match(result.result?.summary ?? "", /\[Compaction Summary\]/, "summary payload should be returned");
  // The bridge text embedded in the session file comes from the bridge templates, not the instruction prompts.
  assert.match(
    result.result?.anchor ?? "",
    new RegExp(DEFAULT_ANCHOR_BRIDGE_TEMPLATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{evictedCount\\}", "3").replace("\\{keptRawCount\\}", "15")),
    "default anchor bridge template should be embedded in the session anchor system message"
  );
  assert.match(
    result.result?.summary ?? "",
    new RegExp(DEFAULT_COMPACTION_BRIDGE_TEMPLATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{evictedCount\\}", "3")),
    "default compaction bridge template should be embedded in the session summary system message"
  );

  const rewritten = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(rewritten.messages.length, 17, "session should keep exactly anchor + summary + fresh tail");
  assert.equal(rewritten.messages[0]?.role, "system", "anchor should be first");
  assert.equal(rewritten.messages[1]?.role, "system", "summary should be second");
  assert.match(rewritten.messages[0]?.content ?? "", /\[Compaction Anchor\]/);
  assert.match(rewritten.messages[1]?.content ?? "", /\[Compaction Summary\]/);
  assert.equal(
    rewritten.messages[15]?.content,
    "Keep the newest study plan visible in the active window.",
    "fresh tail should preserve the newest user message"
  );
  assert.equal(
    rewritten.messages[16]?.content,
    "Understood. I will preserve the freshest plan details.",
    "fresh tail should preserve the newest assistant message"
  );
  assert.deepEqual(
    lastWatermark?.absIndex,
    16,
    "watermark should reset to the new anchor + summary + fresh tail boundary"
  );
  assert.match(
    lastWatermark?.dateSeq ?? "",
    /^\d{8}-0$/,
    "watermark should emit a compacted dateSeq with the processed-gap count"
  );

  const customSessionFile = path.join(tempBase, "session-custom.json");
  fs.writeFileSync(customSessionFile, JSON.stringify({ messages }, null, 2), "utf8");
  // The legacy compactor harness still accepts pre-compaction instruction prompts.
  // The bridge embedded in the rewritten session always comes from the fixed bridge templates.
  // Verify the compactor accepts custom instruction prompts without throwing.
  const customCompactor = new Compactor(rpcClient as any, segmenter as any, 15, {
    anchorPrompt: "Before trimming {evictedCount} messages, record the key decisions for later retrieval.",
    compactionPrompt: "Summarise {evictedCount} messages now entering episodic memory; {keptRawCount} messages remain hot.",
  });
  const customResult = await customCompactor.compact({
    sessionFile: customSessionFile,
    resolvedAgentWs: agentWs,
    agentId: "main",
  });
  // Bridge text in the output is still from DEFAULT_ANCHOR_BRIDGE_TEMPLATE / DEFAULT_COMPACTION_BRIDGE_TEMPLATE.
  assert.match(customResult.result?.anchor ?? "", /\[Compaction Anchor\]/, "custom-prompt compaction: anchor marker must be present");
  assert.match(customResult.result?.summary ?? "", /\[Compaction Summary\]/, "custom-prompt compaction: summary marker must be present");
  assert.match(
    customResult.result?.anchor ?? "",
    new RegExp(DEFAULT_ANCHOR_BRIDGE_TEMPLATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{evictedCount\\}", "3").replace("\\{keptRawCount\\}", "15")),
    "custom-prompt compaction: anchor bridge text still comes from fixed bridge template"
  );
  assert.match(
    customResult.result?.summary ?? "",
    new RegExp(DEFAULT_COMPACTION_BRIDGE_TEMPLATE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{evictedCount\\}", "3")),
    "custom-prompt compaction: summary bridge text still comes from fixed bridge template"
  );

}

async function runPhase7EscalationAndRepairSmoke(): Promise<void> {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-phase7-runtime-"));
  const runtimeDist = path.join(runtimeRoot, "dist");
  fs.mkdirSync(runtimeDist, { recursive: true });
  for (const file of [
    "large-payload.js",
    "rpc-client.js",
    "segmenter.js",
    "summary-escalation.js",
    "transcript-repair.js",
    "types.js",
    "utils.js",
  ]) {
    fs.copyFileSync(path.join("dist", file), path.join(runtimeDist, file));
  }
  const require = createRequire(import.meta.url);
  const { extractText } = require(path.join(runtimeDist, "segmenter.js"));
  const { buildSummaryForLevel } = require(path.join(runtimeDist, "summary-escalation.js"));
  const { sanitizeToolUseResultPairing } = require(path.join(runtimeDist, "transcript-repair.js"));

  const directoryListing = Array.from({ length: 420 }, (_, index) => `./workspace/episodes/2026/04/${String(index % 30 + 1).padStart(2, "0")}/item-${index}.md`).join("\n");
  const externalized = extractText(directoryListing);
  assert.match(
    externalized,
    /\[Large directory listing:/,
    "extractText should externalize oversized directory listings instead of passing raw noise through"
  );

  const noisyTranscript = [
    { role: "user", content: "Initial note." },
    { role: "assistant", content: "thinking:\nwe should inspect the archive\n[DEBUG] internal noise" },
    { role: "assistant", content: "Follow-up with the important bit." },
    { role: "user", content: "More context that should survive." },
  ];
  const normalSummary = buildSummaryForLevel(noisyTranscript, "normal");
  const aggressiveSummary = buildSummaryForLevel(noisyTranscript, "aggressive");
  const fallbackSummary = buildSummaryForLevel(noisyTranscript, "fallback");
  assert.match(normalSummary, /Initial note\./, "normal summary should keep the full transcript shape");
  assert.doesNotMatch(aggressiveSummary, /thinking:|^\[DEBUG\]/m, "aggressive summary should strip reasoning/debug noise");
  assert.ok(
    aggressiveSummary.length <= normalSummary.length,
    "aggressive summary should not be longer than the normal summary"
  );
  assert.ok(
    fallbackSummary.length <= normalSummary.length,
    "fallback summary should remain deterministic and compact"
  );

  const repaired = sanitizeToolUseResultPairing([
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call-1", name: "search" },
      ],
    },
    {
      role: "user",
      content: "intervening user message",
    },
    {
      role: "toolResult",
      toolUseId: "call-1",
      content: [{ type: "text", text: "late tool output" }],
    },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call-2", name: "read" },
      ],
    },
    {
      role: "assistant",
      content: "follow-up answer",
    },
  ] as any);

  const repairedRoles = repaired.map((message: any) => message.role);
  assert.ok(repairedRoles.includes("toolResult"), "sanitizer should preserve or synthesize tool results");
  assert.ok(
    repaired.find((message: any) => message.role === "toolResult" && (message.toolCallId === "call-2" || message.toolUseId === "call-2")),
    "sanitizer should insert a synthetic tool result when a tool_use has no matching result"
  );
  assert.ok(
    repaired.indexOf(repaired.find((message: any) => message.role === "toolResult" && (message.toolCallId === "call-1" || message.toolUseId === "call-1")) as any) >
      repaired.indexOf(repaired.find((message: any) => message.role === "assistant" && Array.isArray(message.content)) as any),
    "tool results should be reattached after their assistant tool_use"
  );

  const repairedContentBlock = sanitizeToolUseResultPairing([
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call-3", name: "lookup" },
      ],
    },
    {
      role: "toolResult",
      content: [
        { type: "tool_result", tool_use_id: "call-3", text: "content-block tool output" },
      ],
    },
  ] as any);
  assert.ok(
    repairedContentBlock.find((message: any) => {
      if (message.role !== "toolResult") return false;
      // Message-level fields may not exist for content-block-level matching.
      // Verify the message is retained by checking its content-block carries call-3.
      if (message.toolCallId === "call-3" || message.toolUseId === "call-3") return true;
      if (Array.isArray(message.content)) {
        return message.content.some((b: any) => b?.tool_use_id === "call-3");
      }
      return false;
    }),
    "sanitizer should detect content-block-level tool_use_id"
  );
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
  const logPath = path.join(os.tmpdir(), "episodic-claw", new Date().toISOString().split("T")[0] + ".log");
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "episodic-claw-runtime-"));
  const runtimeDist = path.join(runtimeRoot, "dist");
  const runtimeGo = path.join(runtimeRoot, "go");
  const observedSidecarLines: string[] = [];
  fs.mkdirSync(runtimeDist, { recursive: true });
  const distJsFiles = [
    "anchor-store.js",
    "archiver.js",
    "large-payload.js",
    "compactor.js",
    "config.js",
    "index.js",
    "retriever.js",
    "rpc-client.js",
    "runner_hardcoded.js",
    "runner.js",
    "summary-escalation.js",
    "segmenter.js",
    "transcript-repair.js",
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
      "Auto-Rebuild from Markdown",
      "HealingWorker: [Pass 3] Starting Stage 2 Batch Score update",
      "HealingWorker: [Pass 4] Starting GC (Tombstone older than 14 days)",
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
    const observedTimelineText = `${observedSidecarLines.join("\n")}\n${logText}`;
    assertLogOrder(observedTimelineText, [
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
  const planSource = fs.readFileSync(path.resolve("docs", "plans", "v0.2.x", "v0.2.5_fix_plan.md"), "utf8");
  const configSource = fs.readFileSync(path.resolve("src", "config.ts"), "utf8");
  const compactorSource = fs.readFileSync(path.resolve("src", "compactor.ts"), "utf8");
  const indexSource = fs.readFileSync(path.resolve("src", "index.ts"), "utf8");
  const retrieverSource = fs.readFileSync(path.resolve("src", "retriever.ts"), "utf8");
  const rpcClientSource = fs.readFileSync(path.resolve("src", "rpc-client.ts"), "utf8");
  const typesSource = fs.readFileSync(path.resolve("src", "types.ts"), "utf8");
  const postinstallSource = fs.readFileSync(path.resolve("scripts", "postinstall.cjs"), "utf8");
  const storeSource = fs.readFileSync(path.resolve("go", "internal", "vector", "store.go"), "utf8");
  const mainGoSource = fs.readFileSync(path.resolve("go", "main.go"), "utf8");

  assert.equal(pkg.version, "0.3.6-2", "package.json version should be 0.3.6-2");
  assert.equal(manifest.version, "0.3.6-2", "openclaw.plugin.json version should be 0.3.6-2");
  assert.ok(
    !("contextThreshold" in (manifest.configSchema as any).properties),
    "openclaw.plugin.json should no longer expose contextThreshold"
  );
  assert.ok(
    !("freshTailCount" in (manifest.configSchema as any).properties),
    "openclaw.plugin.json should no longer expose freshTailCount"
  );
  assert.ok(
    !("recentKeep" in (manifest.configSchema as any).properties),
    "openclaw.plugin.json should no longer expose recentKeep"
  );
  assert.ok(
    !("anchorPrompt" in (manifest.configSchema as any).properties),
    "openclaw.plugin.json should no longer expose anchorPrompt"
  );
  assert.ok(
    !("compactionPrompt" in (manifest.configSchema as any).properties),
    "openclaw.plugin.json should no longer expose compactionPrompt"
  );
  assert.match(changelog, /\[0\.3\.6\]/, "CHANGELOG should mention v0.3.6");
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
    /anchorInjectionAssembles:\s*Math\.max\(1,\s*rawConfig\?\.anchorInjectionAssembles\s*\?\?\s*1\)/,
    "anchorInjectionAssembles should default to 1 and stay clamped in src/config.ts"
  );
  assert.doesNotMatch(
    configSource,
    /contextThreshold|anchorPrompt|compactionPrompt|freshTailCount|recentKeep/,
    "src/config.ts should no longer expose compaction-era config fields"
  );
  assert.doesNotMatch(
    indexSource,
    /contextThreshold|anchorPrompt|compactionPrompt|freshTailCount|recentKeep/,
    "plugin schema should no longer expose compaction-era config fields"
  );
  assert.doesNotMatch(
    typesSource,
    /contextThreshold|anchorPrompt|compactionPrompt|freshTailCount|recentKeep/,
    "types.ts should no longer declare compaction-era config fields"
  );
  assert.match(
    compactorSource,
    /export const DEFAULT_ANCHOR_PROMPT =/,
    "compactor should export the built-in anchor prompt template"
  );
  assert.match(
    compactorSource,
    /export const DEFAULT_COMPACTION_PROMPT =/,
    "compactor should export the built-in compaction prompt template"
  );
  assert.doesNotMatch(
    configSource,
    /sharedEpisodesDir|allowCrossAgentRecall/,
    "sharedEpisodesDir and allowCrossAgentRecall should be disabled in loadConfig"
  );
  assert.match(
    indexSource,
    /state\.lastInjectedResultHash = ""[\s\S]*?await state\.segmenter\.processTurn\(msgs, agentWs, agentId\);/s,
    "ingest should clear re-injection guard before segmenting"
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
    /type AnchorInjectionState = \{[\s\S]*remainingEligibleAssembles: number;[\s\S]*source: "compaction";[\s\S]*\}/,
    "index.ts should define a separate compaction anchor injection state"
  );
  assert.match(
    indexSource,
    /before_prompt_build.*セグメンテーション.*メモリ注入/,
    "index.ts should register before_prompt_build hook for segmentation + memory injection fallback"
  );
  assert.match(
    indexSource,
    /after_compaction is only a host notification hook\./,
    "index.ts should document that after_compaction is notification-only and not the anchor payload carrier"
  );
  assert.match(
    indexSource,
    /anchorInjection:\s*null,/,
    "agent runtime state should initialize anchor injection storage"
  );
  assert.match(
    indexSource,
    /anchorInjectionAssembles: Type\.Optional\(Type\.Integer\(/,
    "plugin schema should expose anchorInjectionAssembles"
  );
  assert.match(
    indexSource,
    /console\.log\(`\[Episodic Memory\] anchorInjection \$\{parts\.join\(" "\)\}`\);/,
    "anchor injection should log through a dedicated anchorInjection channel"
  );
  assert.match(
    indexSource,
    /const prependSystemContext = \[anchorPrependText, recallOutcome\.text\][\s\S]*?\.join\("\\n\\n"\);/s,
    "assemble should combine anchor injection and recall injection at the final prependSystemContext merge point"
  );
  assert.match(
    indexSource,
    /const maxRecallTokens = Math\.max\(0, maxEpisodicTokens - anchorTokens\);/,
    "recall injection should remain separate and use the remaining prompt budget after anchor injection"
  );
  assert.match(
    indexSource,
    /const anchorText = await state\.anchorStore\.read\(agentWs\);\s*if \(anchorText\) \{\s*activateAnchorInjection\(state, \{ anchor: anchorText, summary: "" \}\);\s*await state\.anchorStore\.consume\(agentWs\);\s*console\.log\("\[Episodic Memory\] after_compaction: anchor injected\."\);/s,
    "after_compaction should arm the temporary anchor injection state from anchor.md without relying on compact() result"
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
    rpcClientSource,
    /async recall\([\s\S]*?\): Promise<RecallRpcEpisodeResult\[]> \{/,
    "rpc-client recall should expose a minimal typed recall result surface"
  );
  assert.match(
    typesSource,
    /export type RecallMatchedBy = "semantic" \| "lexical" \| "both";/,
    "types.ts should define RecallMatchedBy for recall diagnostics"
  );
  assert.match(
    typesSource,
    /fallbackReason\?: RecallFallbackReason \| "";/,
    "types.ts should expose fallbackReason on the typed recall result"
  );
  assert.match(
    retrieverSource,
    /type RecallDiagnostics = \{[\s\S]*matchedByCounts: Record<RecallMatchedBy, number>;[\s\S]*fallbackReasons: RecallFallbackReason\[];[\s\S]*topicsFallbackCount: number;[\s\S]*\}/,
    "retriever should retain recall diagnostics instead of collapsing everything to a string"
  );
  assert.match(
    retrieverSource,
    /const DEFAULT_AUTO_INJECT_GUARD_MIN_SCORE = 0\.86;/,
    "retriever should default the degraded fallback auto-inject confidence threshold to 0.86"
  );
  assert.match(
    retrieverSource,
    /reason:\s*"injected" \| "no_messages" \| "max_tokens_zero" \| "empty_query" \| "recall_empty" \| "recall_failed" \| "degraded_low_confidence";/,
    "retriever should expose degraded_low_confidence when fallback results are suppressed from auto-injection"
  );
  assert.match(
    configSource,
    /autoInjectGuardMinScore: clampUnitInterval\(rawConfig\?\.autoInjectGuardMinScore, 0\.86\)/,
    "loadConfig should clamp autoInjectGuardMinScore into the 0..1 range with a default of 0.86"
  );
  assert.match(
    indexSource,
    /autoInjectGuardMinScore: Type\.Optional\(Type\.Number\(\{[\s\S]*minimum: 0,[\s\S]*maximum: 1,[\s\S]*default 0\.86/ ,
    "plugin schema should expose autoInjectGuardMinScore as a 0..1 setting"
  );
  assert.match(
    indexSource,
    /topMatchedBy: recallOutcome\.diagnostics\.topMatchedBy,[\s\S]*matchedByCounts: recallOutcome\.diagnostics\.matchedByCounts,[\s\S]*fallbackReasons: recallOutcome\.diagnostics\.fallbackReasons,[\s\S]*topicsFallbackCount: recallOutcome\.diagnostics\.topicsFallbackCount,/,
    "index.ts should log recall diagnostics separately from anchor injection"
  );
  assert.match(
    storeSource,
    /MatchedBy\s+string\s+`json:\"matchedBy,omitempty\"`/,
    "ScoredEpisode should include matchedBy in the result items"
  );
  assert.match(
    storeSource,
    /FallbackReason\s+string\s+`json:\"fallbackReason,omitempty\"`/,
    "ScoredEpisode should include fallbackReason in the result items"
  );
  assert.match(
    storeSource,
    /func matchedByForCandidate\(fromLexical bool, fallbackReason string\) string \{/,
    "Go store should derive matchedBy from the actual candidate source"
  );
  assert.match(
    storeSource,
    /func composeRecallFallbackReason\(baseReason string, topicsFallback bool\) string \{/,
    "Go store should compose fallback reasons without changing the top-level RPC shape"
  );
  assert.match(
    storeSource,
    /if allowedIDs != nil \{\s*if _, ok := allowedIDs\[candidateID\]; !ok \{\s*return\s*\}\s*\}/,
    "store should count only topic-eligible candidates when deciding sparse-hit backfill"
  );
  assert.match(
    storeSource,
    /shouldBackfillSemantic := len\(candidates\) > 0 &&[\s\S]*len\(candidates\) < candidateK &&[\s\S]*!strings\.Contains\(fallbackReason, "embed_fallback_lexical_only"\)/,
    "store should only backfill semantic candidates when lexical hits are sparse and embed fallback is not lexical-only"
  );
  assert.match(
    storeSource,
    /appendCandidateUnique := func\(candidate rawScore\) \{/,
    "store should dedupe candidate collection safely before scoring"
  );
  assert.match(
    storeSource,
    /if len\(candidates\) == 0 \|\| shouldBackfillSemantic \{/,
    "store should preserve the zero-hit HNSW fallback while adding sparse-hit backfill"
  );
  assert.match(
    storeSource,
    /\[Recall\] empty_result fallbackReason=%s topicsFallback=%t strictTopics=%t lexicalHits=%d candidateCount=%d queryPresent=%t/,
    "store should log empty-result fallback diagnostics without expanding the RPC shape"
  );
  assert.match(
    storeSource,
    /MatchedBy is closer to scoring provenance than raw candidate origin:/,
    "store should document matchedBy as scoring provenance rather than a pure source label"
  );
  assert.match(
    mainGoSource,
    /recallFallbackReason := ""/,
    "handleRecall should track embed fallback reason explicitly"
  );
  assert.match(
    mainGoSource,
    /RecallWithQuery\(params\.Query, emb, params\.K, now, params\.Topics, strictTopics, params\.Calibration, recallFallbackReason\)/,
    "handleRecall should pass fallback reason into the recall result items"
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

  await runCompactionModelSmoke();
  await runPhase7EscalationAndRepairSmoke();
  await runAnchorInjectionSmoke();
  await runDegradedFallbackGuardSmoke();
  await runGatewayStartSmoke();

  console.log("phase4_5 smoke: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
