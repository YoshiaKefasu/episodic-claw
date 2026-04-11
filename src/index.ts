import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { createHash } from "crypto";
import { Type } from "@sinclair/typebox";
import { EpisodicCoreClient, FileEventDebouncer, resolveSessionFile, ingestColdStartSession, ingestedSessions } from "./rpc-client";
import { buildRecallCalibration, loadConfig, buildToolFirstRecallConfig, resolveRuntimeBridgeMode } from "./config";
import { EventSegmenter, Message, extractText, SessionMappingCache, SessionMappingEntry, buildBeforeDispatchDelta, buildMessageSentDelta, normalizeConversationKey, getAllConversationKeys } from "./segmenter";
import { EpisodicRetriever, RecallInjectionOutcome } from "./retriever";
import { EpisodicArchiver } from "./archiver";
import { AnchorStore } from "./anchor-store";
import { estimateTokens } from "./utils";
import { OpenRouterClient } from "./openrouter-client";
import { NarrativeWorker } from "./narrative-worker";
import { NarrativePool } from "./narrative-pool";
import { RecallFallbackReason, RecallMatchedBy, RuntimeBridgeMode, ToolFirstRecallConfig, ToolFirstGateResult } from "./types";
import { ToolFirstRecallGate } from "./tool-first-gate";
import { instantDeterministicRewrite, isAttachmentDominant, stripAttachmentNoise } from "./retriever";
import { stripReasoningTagsFromText } from "./reasoning-tags";

export interface OpenClawPluginApi {
  // フック登録 — openclaw types.ts の PluginHookName に準拠
  on(
    hookName:
      | "gateway_start"
      | "gateway_stop"
      | "before_prompt_build"
      | "session_start"
      | "session_end"
      | "before_model_resolve"
      | "before_agent_start"
      | "before_compaction"
      | "after_compaction"
      | string,
    handler: (event?: any, ctx?: any) => void | Promise<void> | Record<string, unknown> | Promise<Record<string, unknown>>,
    opts?: { priority?: number }
  ): void;
  registerContextEngine(id: string, factory: () => any): void;
  registerTool(def: any | ((ctx: any) => any), opts?: { optional?: boolean }): void;
  runtime: {
    extensionAPI: any;
    config: {
      loadConfig: () => any;
    };
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// (シングルトンは register() 自身の Closure 内に閉じ込め、グローバル状態汚染を防ぐ)

function extractAgentId(ctx: any): string {
  if (!ctx) return "auto";
  if (typeof ctx.agentId === "string" && ctx.agentId) return ctx.agentId;
  if (ctx.agent && typeof ctx.agent.id === "string" && ctx.agent.id) return ctx.agent.id;
  if (ctx.runtimeContext && typeof ctx.runtimeContext.agentId === "string" && ctx.runtimeContext.agentId) return ctx.runtimeContext.agentId;
  if (typeof ctx.sessionKey === "string" && ctx.sessionKey.startsWith("agent:")) {
    const parts = ctx.sessionKey.split(":");
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  return "auto";
}

function normalizeTopics(rawTopics: unknown): string[] {
  if (!Array.isArray(rawTopics)) return [];

  const seen = new Set<string>();
  const topics: string[] = [];

  for (const raw of rawTopics) {
    if (typeof raw !== "string") continue;
    const normalized = raw.normalize("NFKC").trim();
    if (!normalized) continue;

    const clipped = Array.from(normalized).slice(0, 50).join("");
    const dedupeKey = clipped.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    topics.push(clipped);

    if (topics.length >= 10) break;
  }

  return topics;
}

type WorkspaceResolution = {
  agentId: string;
  agentWs: string;
  defaultAgentId: string;
  defaultWs: string;
};

type AnchorInjectionState = {
  anchorText: string;
  summaryText: string;
  anchorId: string;
  summaryId: string;
  // Eligible prompt-build lifetime only. A budget-truncated early return does not consume this.
  remainingEligibleAssembles: number;
  source: "compaction";
};

type AgentRuntimeState = {
  agentId: string;
  lastAgentWs: string;
  segmenter: EventSegmenter;
  archiver: EpisodicArchiver;
  anchorStore: AnchorStore;
  anchorInjection: AnchorInjectionState | null;
  lastSetMetaTime: number;
  // 結果ベース再注入防止
  lastInjectedResultHash: string;
  lastInjectionMessageCount: number;
};

const WORKSPACE_CACHE_PREFIX = "episodic-claw-workspace";

type PrependSystemContextStatus = "injected" | "skipped" | "truncated";

function logPrependSystemContextOutcome(args: {
  status: PrependSystemContextStatus;
  agentId: string;
  agentWs: string;
  queryHash: string;
  estimatedTokens: number;
  injectedEpisodeCount: number;
  truncatedEpisodeCount: number;
  reason?: string;
  firstEpisodeId?: string;
  topMatchedBy?: RecallMatchedBy | "";
  matchedByCounts?: Record<RecallMatchedBy, number>;
  fallbackReasons?: RecallFallbackReason[];
  topicsFallbackCount?: number;
  // v0.4.3 observability: recall query construction details
  eligibleRecentMessages?: number;
  skippedImageLikeMessages?: number;
  dominantScript?: string;
}): void {
  const parts = [
    `status=${args.status}`,
    `agentId=${args.agentId}`,
    `agentWs=${args.agentWs}`,
    `queryHash=${args.queryHash || "none"}`,
    `estimatedTokens=${args.estimatedTokens}`,
    `injectedEpisodeCount=${args.injectedEpisodeCount}`,
    `truncatedEpisodeCount=${args.truncatedEpisodeCount}`,
  ];
  if (args.firstEpisodeId) parts.push(`firstEpisodeId=${args.firstEpisodeId}`);
  if (args.topMatchedBy) parts.push(`topMatchedBy=${args.topMatchedBy}`);
  if (args.matchedByCounts) {
    parts.push(
      `matchedByCounts=semantic:${args.matchedByCounts.semantic},lexical:${args.matchedByCounts.lexical},both:${args.matchedByCounts.both}`
    );
  }
  if (typeof args.topicsFallbackCount === "number" && args.topicsFallbackCount > 0) {
    parts.push(`topicsFallbackCount=${args.topicsFallbackCount}`);
  }
  // v0.4.3 observability
  if (typeof args.eligibleRecentMessages === "number") parts.push(`eligibleRecentMessages=${args.eligibleRecentMessages}`);
  if (typeof args.skippedImageLikeMessages === "number") parts.push(`skippedImageLikeMessages=${args.skippedImageLikeMessages}`);
  if (args.dominantScript) parts.push(`dominantScript=${args.dominantScript}`);
  if (args.fallbackReasons && args.fallbackReasons.length > 0) {
    parts.push(`fallbackReasons=${args.fallbackReasons.join("|")}`);
  }
  if (args.reason) parts.push(`reason=${args.reason}`);
  console.log(`[Episodic Memory] prependSystemContext ${parts.join(" ")}`);
}

type AnchorInjectionStatus = "injected" | "skipped" | "expired";

function logAnchorInjectionOutcome(args: {
  status: AnchorInjectionStatus;
  agentId: string;
  agentWs: string;
  source: "compaction";
  anchorId?: string;
  summaryId?: string;
  estimatedTokens: number;
  // Current remaining eligible prompt-build window for temporary anchor injection.
  anchorInjectionWindow: number;
  reason?: string;
}): void {
  const parts = [
    `status=${args.status}`,
    `source=${args.source}`,
    `agentId=${args.agentId}`,
    `agentWs=${args.agentWs}`,
    `estimatedTokens=${args.estimatedTokens}`,
    `anchorInjectionWindow=${args.anchorInjectionWindow}`,
  ];
  if (args.anchorId) parts.push(`anchorId=${args.anchorId}`);
  if (args.summaryId) parts.push(`summaryId=${args.summaryId}`);
  if (args.reason) parts.push(`reason=${args.reason}`);
  console.log(`[Episodic Memory] anchorInjection ${parts.join(" ")}`);
}

function logCompactionEntry(args: {
  agentId: string;
  agentWs: string;
  force: boolean;
  compactionTarget?: string;
  hasCustomInstructions: boolean;
}): void {
  const parts = [
    `agentId=${args.agentId}`,
    `agentWs=${args.agentWs}`,
    `force=${args.force}`,
    `compactionTarget=${args.compactionTarget || "unknown"}`,
    `customInstructions=${args.hasCustomInstructions ? "present" : "absent"}`,
  ];
  console.log(`[Episodic Memory] compactEntry ${parts.join(" ")}`);
}

function resolveDefaultAgentId(cfgAgents: any): string {
  let defaultAgentId = "main";
  if (cfgAgents?.list && Array.isArray(cfgAgents.list) && cfgAgents.list.length > 0) {
    const defaults = cfgAgents.list.filter((a: any) => a.default);
    defaultAgentId = (defaults[0] ?? cfgAgents.list[0])?.id?.trim() || "main";
  }
  return defaultAgentId;
}

function resolveUserPath(rawPath: string): string {
  let wsPath = rawPath;
  if (wsPath.startsWith("~/") || wsPath.startsWith("~\\")) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    wsPath = path.join(homeDir, wsPath.slice(2));
  } else if (wsPath === "~") {
    wsPath = process.env.HOME || process.env.USERPROFILE || os.homedir();
  }
  return path.resolve(wsPath);
}

function resolveWorkspaceRoot(agentId: string, cfgAgents: any): string {
  let wsPath = "";
  const targetAgent = cfgAgents?.list?.find((a: any) => a.id === agentId);
  if (targetAgent && typeof targetAgent.workspace === "string" && targetAgent.workspace.trim() !== "") {
    wsPath = targetAgent.workspace.trim();
  } else if (cfgAgents?.defaults?.workspace && typeof cfgAgents.defaults.workspace === "string" && cfgAgents.defaults.workspace.trim() !== "") {
    wsPath = cfgAgents.defaults.workspace.trim();
  } else {
    const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const wsDirName = agentId === "main" ? "workspace" : `workspace-${agentId}`;
    wsPath = path.join(homeDir, ".openclaw", wsDirName);
  }
  return resolveUserPath(wsPath);
}

function workspaceCachePath(agentId: string): string {
  return path.join(os.tmpdir(), `${WORKSPACE_CACHE_PREFIX}.${agentId}.path`);
}

function readWorkspaceCache(agentId: string): string | null {
  try {
    const cached = fs.readFileSync(workspaceCachePath(agentId), "utf8").trim();
    return cached || null;
  } catch {
    return null;
  }
}

function writeWorkspaceCache(agentId: string, agentWs: string): void {
  try {
    fs.writeFileSync(workspaceCachePath(agentId), agentWs, "utf8");
  } catch {}
}

function resolveAgentWorkspaces(ctx: any, openClawGlobalConfig: any): WorkspaceResolution {
  const agentId = extractAgentId(ctx);
  const cfgAgents = openClawGlobalConfig?.agents;
  const defaultAgentId = resolveDefaultAgentId(cfgAgents);
  const agentRoot = resolveWorkspaceRoot(agentId, cfgAgents);
  const defaultRoot = resolveWorkspaceRoot(defaultAgentId, cfgAgents);
  const agentWs = path.join(agentRoot, "episodes");
  const cached = readWorkspaceCache(agentId);
  if (cached && cached !== agentWs) {
    console.warn(`[Episodic Memory] Workspace cache mismatch for ${agentId}: cached=${cached}, resolved=${agentWs}. Refreshing cache.`);
  }
  writeWorkspaceCache(agentId, agentWs);
  const defaultWs = path.join(defaultRoot, "episodes");
  return { agentId, agentWs, defaultAgentId, defaultWs };
}

function matchWorkspaceForPath(filePath: string, workspaces: Iterable<string>): string | null {
  const normalized = path.resolve(filePath);
  let bestMatch = "";
  for (const workspace of workspaces) {
    const normalizedWs = path.resolve(workspace);
    if (normalized === normalizedWs || normalized.startsWith(`${normalizedWs}${path.sep}`)) {
      if (normalizedWs.length > bestMatch.length) {
        bestMatch = normalizedWs;
      }
    }
  }
  return bestMatch || null;
}

const PluginConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({
      description: "Enable or disable the plugin (default true)."
    })),
    reserveTokens: Type.Optional(Type.Integer({
      description: "Max tokens reserved for injected episode memories in the system prompt (default 2048)."
    })),
    autoInjectGuardMinScore: Type.Optional(Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Minimum 0..1 score required before degraded HNSW fallback results may auto-inject into prependSystemContext (default 0.86)."
    })),
    anchorInjectionAssembles: Type.Optional(Type.Integer({
      description: "How many eligible prompt builds may temporarily inject the latest compaction anchor + summary (default 1). Budget-truncated early returns do not consume this window."
    })),
    dedupWindow: Type.Optional(Type.Integer({
      description: "Duplicate-message dedup window size (default 5). Increase to 10+ in high-fallback environments."
    })),
    maxBufferChars: Type.Optional(Type.Integer({
      minimum: 500,
      description: "Advanced: character threshold that forces the segmenter to flush regardless of surprise/time-gap boundaries. Default: 7200. Acts as a live flush guard to prevent unbounded buffer growth."
    })),
    maxCharsPerChunk: Type.Optional(Type.Integer({
      minimum: 500,
      description: "Deprecated (legacy-only): max characters per chunk for the old batchIngest path. No longer used in the v0.4.x narrative cache path. Retained for backward compatibility only. Default: 9000."
    })),
    sharedEpisodesDir: Type.Optional(Type.String({
      description: "Disabled and ignored. Shared episodes directories are no longer used at runtime."
    })),
    allowCrossAgentRecall: Type.Optional(Type.Boolean({
      description: "Disabled and ignored. Cross-agent recall is no longer used at runtime."
    })),
    segmentationLambda: Type.Optional(Type.Number({
      description: "Adaptive segmentation: threshold = mean + lambda * std."
    })),
    segmentationWarmupCount: Type.Optional(Type.Integer({
      description: "Adaptive segmentation: number of observations needed before dynamic scoring."
    })),
    segmentationMinRawSurprise: Type.Optional(Type.Number({
      description: "Adaptive segmentation: raw surprise floor below which boundaries are not cut."
    })),
    segmentationCooldownTurns: Type.Optional(Type.Integer({
      description: "Adaptive segmentation: cooldown turns after a detected boundary."
    })),
    segmentationStdFloor: Type.Optional(Type.Number({
      description: "Adaptive segmentation: minimum std floor to avoid over-sensitive scoring."
    })),
    segmentationFallbackThreshold: Type.Optional(Type.Number({
      description: "Adaptive segmentation: fixed threshold used during fallback or warmup."
    })),
    segmentationTimeGapMinutes: Type.Optional(Type.Number({
      minimum: 1,
      description: "Phase 3: Force segment boundary when user message gap exceeds this (minutes). Default: 15."
    })),
    recallSemanticFloor: Type.Optional(Type.Number({
      description: "Recall calibration: semantic relevance below this floor should not be overruled by usefulness/replay."
    })),
    recallUsefulnessClamp: Type.Optional(Type.Number({
      description: "Recall calibration: cap usefulness posterior contribution so it stays a correction term."
    })),
    recallReplayTieBreakMaxBoost: Type.Optional(Type.Number({
      description: "Recall calibration: maximum replay-state tie-break boost."
    })),
    recallReplayLowRetrievabilityBonus: Type.Optional(Type.Number({
      description: "Recall calibration: tiny extra boost when a replay candidate is clearly getting stale."
    })),
    recallTopicsMatchBoost: Type.Optional(Type.Number({
      description: "Recall calibration: bonus per matched topic."
    })),
    recallTopicsMismatchPenalty: Type.Optional(Type.Number({
      description: "Recall calibration: penalty when topics exist but none match."
    })),
    recallTopicsMissingPenalty: Type.Optional(Type.Number({
      description: "Recall calibration: penalty when the record has no topics at all. Usually zero."
    })),
    recallReInjectionCooldownTurns: Type.Optional(Type.Integer({
      minimum: 0,
      description: "Minimum total message turns before the same recalled episode set may be re-injected. Default: 24."
    })),
    lexicalRebuildIntervalDays: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 30,
      description: "How often the HealingWorker checks for gaps in the Lexical index. Default: 7 days."
    })),
    queryExcludedKeywords: Type.Optional(Type.Array(Type.String(), {
      description: "Keywords to exclude from recall queries. Add words here to prevent them from being used in memory search."
    })),
    recallQueryRecentMessageCount: Type.Optional(Type.Integer({
      minimum: 1,
      maximum: 12,
      description: "How many recent messages are used to build the deterministic recall query. Default: 4."
    })),
    // Narrative architecture (v0.4.0)
    openrouterApiKey: Type.Optional(Type.String({
      description: "OpenRouter API key for narrative generation. Falls back to OPENROUTER_API_KEY env var."
    })),
    openrouterModel: Type.Optional(Type.String({
      description: "Deprecated: legacy alias for openrouterConfig.model. Use openrouterConfig.model instead."
    })),
    narrativeSystemPrompt: Type.Optional(Type.String({
      description: "Custom system prompt for narrative generation. Inline text."
    })),
    narrativeUserPromptTemplate: Type.Optional(Type.String({
      description: "Custom user prompt template for narrative generation. Variables: {previousEpisode}, {conversationText}"
    })),
    maxPoolChars: Type.Optional(Type.Integer({
      minimum: 1000,
      description: "Advanced: maximum characters accumulated in the narrative pool before triggering a flush to the cache queue. Default: 15000. Acts as a pool flush guard to prevent context overflow."
    })),
    narrativePreviousEpisodeRef: Type.Optional(Type.Boolean({
      description: "Pass the full previous episode to the LLM for context continuity. Default: true."
    })),
    narrativeMaxTokens: Type.Optional(Type.Integer({
      minimum: 256,
      maximum: 32768,
      description: "Deprecated: legacy alias for openrouterConfig.maxTokens. Use openrouterConfig.maxTokens instead."
    })),
    narrativeTemperature: Type.Optional(Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Deprecated: legacy alias for openrouterConfig.temperature. Use openrouterConfig.temperature instead."
    })),
    openrouterConfig: Type.Optional(Type.Object({
      model: Type.Optional(Type.String()),
      maxTokens: Type.Optional(Type.Integer({ minimum: 256, maximum: 32768 })),
      temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      reasoning: Type.Optional(Type.Object({
        enabled: Type.Optional(Type.Boolean()),
        effort: Type.Optional(Type.String({ enum: ["none", "minimal", "low", "medium", "high", "xhigh"] })),
        maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        exclude: Type.Optional(Type.Boolean()),
      }, { description: "OpenRouter reasoning/thinking control. Default: enabled=true, effort=high." })),
    }, { description: "Nested OpenRouter config. Takes precedence over flat fields." })),
    enableBackgroundWorkers: Type.Optional(Type.Boolean({
      description: "Enables background maintenance workers (HealingWorker for index auto-rebuild, embedding 429 recovery). Default: true. Does not affect narrative generation."
    })),
    // Tool-first recall (v0.4.6)
    toolFirstRecall: Type.Optional(Type.Object({
      enabled: Type.Optional(Type.Boolean({ description: "Enable tool-first recall path. Default: true." })),
      k: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Default k for tool-first ep-recall calls. Default: 3." })),
    }, { description: "Tool-first recall configuration (v0.4.6). Controls the conditional gate pipeline for ep-recall." })),
    // Runtime Bridge Mode (v0.4.7)
    runtimeBridgeMode: Type.Optional(Type.String({
      enum: ["auto", "legacy_embedded", "cli_universal"],
      description: "Runtime bridge mode master switch (v0.4.7). Controls whether the plugin uses the universal bridge (before_dispatch/message_sent) or legacy embedded path. Default: \"auto\"."
    })),
  },
  { additionalProperties: false }
);

// ─── プロセスレベルのシングルトン（BUG-1 修正 v2）──────────────────────────────
// モジュールレベル変数（let _singleton）はモジュールキャッシュが無効な場合に
// 毎回 null にリセットされる。global に保存することで同一 Node.js プロセス内の
// 全モジュールインスタンスが同一オブジェクトを共有する。
const SINGLETON_KEY = Symbol.for("__episodic_claw_singleton__");
type SingletonType = {
  rpcClient: EpisodicCoreClient;
  retriever: EpisodicRetriever;
  sidecarStarted: boolean;
  cfg: ReturnType<typeof loadConfig>;
  tfConfig: ToolFirstRecallConfig;
  effectiveTfConfig: ToolFirstRecallConfig;
  tfGate: ToolFirstRecallGate;
  agentStates: Map<string, AgentRuntimeState>;
  debouncers: Map<string, FileEventDebouncer>;
  watcherWorkspaces: Set<string>;
  watcherDegradedWorkspaces: Set<string>;
  // Narrative architecture (v0.4.0)
  openRouterClient: OpenRouterClient | null;
  narrativeWorker: NarrativeWorker | null;
  // v0.4.7: Session mapping for message_sent resolution (TTL/LRU)
  sessionMapping: SessionMappingCache;
  // v0.4.7: Idempotency markers for hook-driven ingest
  ingestIdempotency: Map<string, number>; // key -> lastSeenMinuteBucket
  // v0.4.7: CLI Mode master switch
  runtimeBridgeMode: RuntimeBridgeMode;
  effectiveBridgeMode: "cli_universal" | "legacy_embedded";
};
let _singleton: SingletonType | null = null;

const episodicClawPlugin = {
  id: "episodic-claw",
  name: "Episodic Memory",
  description: "Sequential narrative memory with Cache-and-Drain architecture. Safely splits massive chat logs into 64K chunks, narrativizes them via OpenRouter, and provides semantic recall with per-agent continuity.",
  kind: "memory",
  configSchema: PluginConfigSchema,
  register(api: OpenClawPluginApi) {
    try {
      // ─── CLIモードログ重複防止（global フラグ）──────────
      // register() が複数回呼ばれる環境で、初回のみログ出力する。
      // モジュールキャッシュが無効化される場合でも global はプロセス内で永続するため揮発しない。
      const CLI_SKIP_FLAG = Symbol.for("episodic.cli.skipped");
      const CLI_REGISTER_FLAG = Symbol.for("episodic.cli.registered");

      // CLIモード判定：OpenClaw固有のデーモンコマンド（gateway / agent / test）の場合のみ初期化を行う。
      // "start" は npm start / yarn start でも argv に現れるため意図的に除外している。
      const DAEMON_CMDS = ["gateway", "agent", "test"];
      const isDaemon = DAEMON_CMDS.some(cmd => process.argv.includes(cmd));
      if (!isDaemon) {
        if (!(global as any)[CLI_SKIP_FLAG]) {
          console.log("[Episodic Memory] CLI mode detected. Skipping plugin initialization to prevent blocks.");
          (global as any)[CLI_SKIP_FLAG] = true;
        }
        return;
      }

      // デーモンモード: 初回のみ登録ログを出力
      if (!(global as any)[CLI_REGISTER_FLAG]) {
        console.log("[Episodic Memory] Registering plugin...");
        (global as any)[CLI_REGISTER_FLAG] = true;
      }

      // ─── プロセスレベルシングルトン初期化（BUG-1 修正 v2: global 経由）──────────
      // モジュールキャッシュが無効化されている環境では let _singleton は毎回 null になる。
      // Symbol.for() キーで global に保存し、同一プロセス内全インスタンスで共有する。
      _singleton = (global as any)[SINGLETON_KEY] ?? null;
      if (!_singleton) {
        const openClawGlobalConfig = api.runtime?.config?.loadConfig?.() || {};
        const cfg = loadConfig(openClawGlobalConfig);
        const tfConfig = buildToolFirstRecallConfig(openClawGlobalConfig);
        const rbMode = resolveRuntimeBridgeMode(openClawGlobalConfig);

        // Resolve effective bridge mode
        let effMode: "cli_universal" | "legacy_embedded";
        if (rbMode === "cli_universal") {
          effMode = "cli_universal";
        } else if (rbMode === "legacy_embedded") {
          effMode = "legacy_embedded";
        } else {
          const isCliPath = process.env.OPENCLAW_CLI === "1" || process.argv.some(a => a.includes("openclaw"));
          if (isCliPath) {
            effMode = "cli_universal";
          } else {
            console.warn("[Episodic Memory] runtimeBridgeMode=auto: execution path undecidable, defaulting to cli_universal (safe side).");
            effMode = "cli_universal";
          }
        }

        // Force tool-first ON when effective mode is cli_universal
        const effectiveTfConfig = effMode === "cli_universal"
          ? { ...tfConfig, enabled: true }
          : tfConfig;

        const tfGate = new ToolFirstRecallGate(effectiveTfConfig);
        const rpcClient = new EpisodicCoreClient();
        const retriever = new EpisodicRetriever(rpcClient, cfg);

        const openRouterClient = cfg.openrouterApiKey
          ? new OpenRouterClient({
              apiKey: cfg.openrouterApiKey,
              model: cfg.openrouterModel,
              maxTokens: cfg.narrativeMaxTokens,
              temperature: cfg.narrativeTemperature,
              reasoning: cfg.openrouterReasoning,
            })
          : null;
        const narrativeWorker = openRouterClient
          ? new NarrativeWorker(openRouterClient, rpcClient, cfg)
          : null;

        _singleton = {
          rpcClient,
          retriever,
          sidecarStarted: false,
          cfg,
          tfConfig,
          effectiveTfConfig,
          tfGate,
          agentStates: new Map(),
          debouncers: new Map(),
          watcherWorkspaces: new Set(),
          watcherDegradedWorkspaces: new Set(),
          openRouterClient,
          narrativeWorker,
          sessionMapping: new SessionMappingCache(),
          ingestIdempotency: new Map(),
          runtimeBridgeMode: rbMode,
          effectiveBridgeMode: effMode,
        };
        (global as any)[SINGLETON_KEY] = _singleton;
        console.log(`[Episodic Memory] Singleton created. runtimeBridgeMode=${rbMode} effective=${effMode}`);
      } else {
        console.log("[Episodic Memory] Singleton reused (BUG-1 guard active).");
      }

      // _singleton is guaranteed non-null here (created above if missing)
      const s = _singleton!;
      const { rpcClient, retriever, cfg, tfConfig, effectiveTfConfig, tfGate, narrativeWorker, runtimeBridgeMode, effectiveBridgeMode } = s;
      const recallCalibration = buildRecallCalibration(cfg);
      // openClawGlobalConfig は gateway_start ハンドラ内の workspace 解決で使用
      const openClawGlobalConfig = api.runtime?.config?.loadConfig?.() || {};

      // CLI mode + tool-first: either one enabled is enough for tool-first path
      const effectiveToolFirstEnabled = effectiveBridgeMode === "cli_universal" || effectiveTfConfig.enabled;

      // 同一メモリ結果の再注入を防止するためのクールダウンターン数
      // 12往復の会話（ユーザー12 + アシスタント12）。1Mコンテキスト窓では十分な間隔。
      // openclaw.plugin.json の recallReInjectionCooldownTurns でユーザーが調整可能。
      // 0 に設定するとガードが無効化される。
      const recallReInjectionCooldownTurns = Math.max(0, cfg.recallReInjectionCooldownTurns ?? 10);

      // [Fix D-3] setMeta rate-limit（フォールバック連発対策）
      // ingest() が N 回呼ばれても setMeta は最大 5 秒に 1 回のみ発行する。
      const SET_META_INTERVAL_MS = 5000;

      const getAgentState = (agentId: string): AgentRuntimeState => {
        const existing = _singleton!.agentStates.get(agentId);
        if (existing) return existing;

        // Narrative architecture (v0.4.0) — pool is per-agent, worker is shared
        const pool = narrativeWorker ? new NarrativePool(cfg.maxPoolChars ?? 15000) : null;

        const segmenter = new EventSegmenter(
          rpcClient,
          cfg.dedupWindow,
          cfg.maxBufferChars,
          cfg.maxCharsPerChunk,
          {
            lambda: cfg.segmentationLambda,
            warmupCount: cfg.segmentationWarmupCount,
            minRawSurprise: cfg.segmentationMinRawSurprise,
            cooldownTurns: cfg.segmentationCooldownTurns,
            stdFloor: cfg.segmentationStdFloor,
            fallbackThreshold: cfg.segmentationFallbackThreshold,
            timeGapMinutes: cfg.segmentationTimeGapMinutes,
          },
          pool,
          narrativeWorker,
        );
        const archiver = new EpisodicArchiver(rpcClient, segmenter);
        const anchorStore = new AnchorStore(rpcClient);
          const state: AgentRuntimeState = {
            agentId,
            lastAgentWs: "",
            segmenter,
            archiver,
            anchorStore,
            anchorInjection: null,
            lastSetMetaTime: 0,
            lastInjectedResultHash: "",
            lastInjectionMessageCount: 0,
          };
        _singleton!.agentStates.set(agentId, state);
        return state;
      };

      const clearAnchorInjection = (state: AgentRuntimeState) => {
        state.anchorInjection = null;
      };

      const buildAnchorInjectionPayload = (state: AnchorInjectionState): string => {
        return [state.anchorText, state.summaryText]
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .join("\n\n");
      };

      const activateAnchorInjection = (
        state: AgentRuntimeState,
        result?: { anchor?: string; summary: string }
      ) => {
        // after_compaction is only a host notification hook. The payload carrier and
        // activation boundary live here in the plugin's notification path.
        const anchorText = result?.anchor?.trim() || "";
        const summaryText = result?.summary?.trim() || "";
        if (!anchorText && !summaryText) {
          clearAnchorInjection(state);
          return;
        }
        const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        state.anchorInjection = {
          anchorText,
          summaryText,
          anchorId: `anchor-${nonce}`,
          summaryId: `summary-${nonce}`,
          remainingEligibleAssembles: Math.max(1, cfg.anchorInjectionAssembles ?? 1),
          source: "compaction",
        };
      };

      const invalidateRecallCacheForWorkspace = (workspace: string) => {
        if (!workspace) return;
        for (const state of _singleton!.agentStates.values()) {
          if (state.lastAgentWs === workspace) {
            state.lastInjectedResultHash = "";
            state.lastInjectionMessageCount = 0;
          }
        }
      };

      const getDebouncerForWorkspace = (agentWs: string): FileEventDebouncer => {
        const existing = _singleton!.debouncers.get(agentWs);
        if (existing) return existing;
        const debouncer = new FileEventDebouncer(rpcClient, agentWs, 2000, invalidateRecallCacheForWorkspace);
        _singleton!.debouncers.set(agentWs, debouncer);
        return debouncer;
      };

      const ensureWatcher = async (agentWs: string): Promise<void> => {
        if (!agentWs) return;
        if (_singleton!.watcherWorkspaces.has(agentWs)) return;
        _singleton!.watcherWorkspaces.add(agentWs);
        try {
          await fs.promises.mkdir(agentWs, { recursive: true });
        } catch {}
        try {
          await Promise.race([
            rpcClient.startWatcher(agentWs),
            new Promise((_, reject) => setTimeout(() => reject(new Error("Watcher Start Timeout")), 5000))
          ]);
        } catch (err) {
          _singleton!.watcherWorkspaces.delete(agentWs);
          _singleton!.watcherDegradedWorkspaces.add(agentWs);
          console.warn("[Episodic Memory] Failed to start watcher; falling back to rebuildIndex.", err);
          try {
            await rpcClient.rebuildIndex(agentWs, agentWs);
            console.log(`[Episodic Memory] Rebuild fallback completed for ${agentWs}.`);
            invalidateRecallCacheForWorkspace(agentWs);
          } catch (rebuildErr) {
            console.error("[Episodic Memory] Rebuild fallback failed.", rebuildErr);
          }
        }
      };

      const prepareWorkspaces = async (resolution: WorkspaceResolution) => {
        await ensureWatcher(resolution.agentWs);
      };

      api.on("gateway_start", async (event?: any, _ctx?: any) => {
        if (_singleton!.sidecarStarted) {
          console.log("[Episodic Memory] Sidecar already started, skipping duplicate gateway_start");
          return;
        }
        _singleton!.sidecarStarted = true;
        console.log("[Episodic Memory] Starting Go sidecar...", event?.port ? `(gateway port: ${event.port})` : "");
        await rpcClient.start(_singleton!.cfg);

        const defaultAgentId = resolveDefaultAgentId(openClawGlobalConfig?.agents);
        const resolution = resolveAgentWorkspaces({ agentId: defaultAgentId }, openClawGlobalConfig);
        console.log(`[Episodic Memory] Resolved default workspace dir: ${resolution.agentWs}`);
        await prepareWorkspaces(resolution);
        if (_singleton!.watcherDegradedWorkspaces.size > 0) {
          console.warn("[Episodic Memory] One or more watcher workspaces are degraded; rebuild fallback is active.");
        }

        // Connect the onFileChange raw event to the Debouncer
        rpcClient.onFileChange = (event) => {
          const eventPath = event?.Path ?? event?.path;
          if (!eventPath) return;
          const matched = matchWorkspaceForPath(eventPath, _singleton!.watcherWorkspaces);
          if (!matched) return;
          const debouncer = getDebouncerForWorkspace(matched);
          debouncer.push(event);
        };

        // ─── Narrative Worker Start (v0.4.2) ─────────────────────────────────────
        // Initialize continuity state and start polling the cache queue.
        if (_singleton!.narrativeWorker) {
          const agents = [{ agentWs: resolution.agentWs, agentId: defaultAgentId }];
          await _singleton!.narrativeWorker.initContinuity(agents);
          _singleton!.narrativeWorker.start();
          console.log("[Episodic Memory] Narrative worker started (cache queue polling).");
        }

        // ─── Cold-Start Ingestion ────────────────────────────────────────────────
        // On first install, ingest existing .jsonl session into .md episodes.
        // Fire-and-forget to avoid blocking startup.
        (async () => {
          // Resolve state directory here (index.ts) to avoid process.env access in rpc-client.ts
          const stateDir = process.env.OPENCLAW_STATE_DIR
            ? process.env.OPENCLAW_STATE_DIR
            : path.join(os.homedir(), ".openclaw");

          // Get all configured agent IDs
          const cfgAgents = openClawGlobalConfig?.agents;
          const allAgentIds = cfgAgents?.list?.map((a: any) => a.id) ?? [defaultAgentId];

          for (const targetAgentId of allAgentIds) {
            const agentResolution = resolveAgentWorkspaces({ agentId: targetAgentId }, openClawGlobalConfig);
            const { agentWs, agentId } = agentResolution;
            if (!agentWs || !agentId) continue;
            const sessionKey = `${agentId}`;
            if (ingestedSessions.has(sessionKey)) continue;

            // 永続チェック: 既に .md ファイルが存在する場合は「構築済み」とみなしてスキップ
            try {
              if (fs.existsSync(agentWs)) {
                const entries = fs.readdirSync(agentWs, { withFileTypes: true });
                const hasExistingEpisodes = entries.some(e => e.isDirectory() && /^\d{4}$/.test(e.name));
                if (hasExistingEpisodes) {
                  console.log(`[Episodic Memory] Cold-Start: episodes directory already exists for ${agentId}, skipping.`);
                  ingestedSessions.add(sessionKey);
                  continue;
                }
              }
            } catch {
              // Ignore permission errors
            }

            const sessionFile = resolveSessionFile(agentId, stateDir);
            if (!sessionFile) continue;

            const hasApiKey = !!process.env.GEMINI_API_KEY;
            console.log(`[Episodic Memory] Cold-Start: found session file ${sessionFile} for ${agentId} (API key: ${hasApiKey ? "yes" : "no"})`);
            try {
              // Pass wake callback to resume worker from idle backoff after cold-start enqueue
              const onWake = _singleton?.narrativeWorker?.wake.bind(_singleton.narrativeWorker);
              const msgCount = await ingestColdStartSession(sessionFile, agentWs, agentId, rpcClient, hasApiKey, onWake);
              console.log(`[Episodic Memory] Cold-Start: ingested ${msgCount} messages from session for ${agentId}.`);
              ingestedSessions.add(sessionKey);
            } catch (err) {
              console.error(`[Episodic Memory] Cold-Start ingestion failed for ${agentId}:`, err);
            }
          }
        })();
      });

      api.on("gateway_stop", async (event?: any, _ctx?: any) => {
        console.log("[Episodic Memory] Stopping plugin...", event?.reason ? `(reason: ${event.reason})` : "");

        // Narrative architecture (v0.4.0) — graceful stop of narrative worker
        if (_singleton!.narrativeWorker) {
          console.log("[Episodic Memory] Stopping narrative worker...");
          await Promise.race([
            _singleton!.narrativeWorker.stop(),
            new Promise(resolve => setTimeout(resolve, 15000)),
          ]);
          console.log("[Episodic Memory] Narrative worker stopped.");
        }

        await rpcClient.stop();
        _singleton!.sidecarStarted = false;
      });

      // Fix C: before_reset フック — セッション消去前（buffer がまだ有効）に flush を開始
      // openclaw は void 発火のため完了保証はないが、最も早いタイミングで RPC を発行できる
      api.on("before_reset", async (_event?: any, ctx?: any) => {
        const { agentId, agentWs } = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
        if (!agentWs) return;
        const state = getAgentState(agentId);
        console.log("[Episodic Memory] before_reset: flushing segmenter buffer...");
        try {
          await state.segmenter.forceFlush(agentWs, agentId);
          console.log("[Episodic Memory] before_reset: flush complete");
        } catch (err) {
          console.error("[Episodic Memory] before_reset: forceFlush error", err);
        }
      });

      // ─── v0.4.7: Bridge ingress hooks (provider-agnostic ingest) ─────────────
      // Only active when effectiveBridgeMode === "cli_universal". When false,
      // legacy embedded path (before_prompt_build/assemble) handles all ingest.
      //
      // Primary: before_dispatch fires before CLI/Embedded split, guaranteeing
      // ingest runs for both paths. Uses processIncrementalTurn (not processTurn)
      // because the payload is a single-turn delta, not cumulative history.
      //
      // Secondary: message_sent captures assistant-side text for complete
      // episodic capture (prevents "user-only" degraded state).

      // Idempotency key: sessionKey + role + normalizedTextHash + minuteBucket
      function buildIdempotencyKey(sessionKey: string, role: string, text: string): string {
        const minuteBucket = Math.floor(Date.now() / 60000);
        const textHash = createHash("sha256").update(text).digest("hex").slice(0, 16);
        return `${sessionKey}:${role}:${textHash}:${minuteBucket}`;
      }

      function checkAndMarkIdempotency(key: string): boolean {
        const existing = _singleton!.ingestIdempotency.get(key);
        if (existing !== undefined) return false; // duplicate
        _singleton!.ingestIdempotency.set(key, Date.now());
        // Prune old entries (> 5 minutes ago)
        const cutoff = Date.now() - 5 * 60 * 1000;
        for (const [k, v] of _singleton!.ingestIdempotency) {
          if (v < cutoff) _singleton!.ingestIdempotency.delete(k);
        }
        return true;
      }

      // ── Bridge ingress: only when effectiveBridgeMode === "cli_universal" ──
      if (effectiveBridgeMode === "cli_universal") {
        api.on("before_dispatch", async (event: any, ctx: any) => {
          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) {
            console.log("[Episodic Memory] before_dispatch: no workspace resolved, skipping.");
            return;
          }

          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;

          // Build session mapping for message_sent resolution
          // Register under ALL available keys from ctx to prevent key mismatch
          const allKeys = getAllConversationKeys(ctx);
          if (allKeys.length > 0) {
            const sessionKey = ctx?.sessionKey || `agent:${agentId}`;
            const entry: SessionMappingEntry = {
              sessionKey,
              agentId,
              agentWs,
              expiresAt: 0, // set by SessionMappingCache
            };
            for (const key of allKeys) {
              _singleton!.sessionMapping.set(key, entry);
            }
          }

          // Build delta Message[] from real before_dispatch event shape
          // (event.content / event.body — NOT event.messages)
          const messages = buildBeforeDispatchDelta(event);
          if (messages.length === 0) {
            console.log("[Episodic Memory] before_dispatch: no content/body in payload, skipping.");
            return;
          }

          // Idempotency guard
          const primaryMsg = messages[messages.length - 1];
          const primaryText = extractText(primaryMsg.content).trim();
          if (primaryText) {
            const sessionKey = ctx?.sessionKey || `agent:${agentId}`;
            const idemKey = buildIdempotencyKey(sessionKey, primaryMsg.role || "user", primaryText);
            if (!checkAndMarkIdempotency(idemKey)) {
              console.log(`[Episodic Memory] before_dispatch: duplicate detected (idemKey=${idemKey.slice(0, 40)}...), skipping.`);
              return;
            }
          }

          console.log(`[Episodic Memory] before_dispatch: source=bridge_ingress sessionKey=${ctx?.sessionKey || "n/a"} agentId=${agentId} agentWs=${agentWs} messages=${messages.length}`);

          // Use incremental ingest (NOT processTurn) — payload is single-turn delta
          state.segmenter.processIncrementalTurn(messages, agentWs, agentId, "before_dispatch").catch(err => {
            console.error("[Episodic Memory] before_dispatch: incremental ingest error:", err);
          });

          // [Fix D-3] setMeta rate-limit
          const nowMeta = Date.now();
          if (nowMeta - state.lastSetMetaTime >= SET_META_INTERVAL_MS) {
            await rpcClient.setMeta("last_activity", nowMeta.toString(), agentWs);
            state.lastSetMetaTime = nowMeta;
          }
        });

        // Secondary: message_sent — captures assistant-side text
        api.on("message_sent", async (event: any, ctx: any) => {
          // Resolve session from conversation/channel via short-lived mapping
          // Try ALL available keys from ctx in priority order, use first hit
          const allKeys = getAllConversationKeys(ctx);
          if (allKeys.length === 0) {
            console.log("[Episodic Memory] message_sent: no conversation/session key in ctx, no-op.");
            return;
          }

          let mapping: SessionMappingEntry | null = null;
          let resolvedKey: string | null = null;
          for (const key of allKeys) {
            const entry = _singleton!.sessionMapping.get(key);
            if (entry) {
              mapping = entry;
              resolvedKey = key;
              break;
            }
          }

          if (!mapping) {
            console.log(`[Episodic Memory] message_sent: session mapping unresolved for keys=[${allKeys.join(", ")}], no-op (safe guard).`);
            return;
          }

          const { agentId, agentWs } = mapping;
          const state = getAgentState(agentId);

          // Build delta from real message_sent event shape
          // (event.content + event.success — NOT event.messages)
          // buildMessageSentDelta already checks success === true internally
          const messages = buildMessageSentDelta(event);
          if (messages.length === 0) {
            // Distinguish: success=false vs no content
            const evtSuccess = event?.success;
            if (evtSuccess !== true) {
              console.log(`[Episodic Memory] message_sent: success=${evtSuccess}, no-op.`);
            } else {
              console.log("[Episodic Memory] message_sent: no content in payload, skipping.");
            }
            return;
          }

          // Idempotency guard
          const primaryMsg = messages[messages.length - 1];
          const primaryText = extractText(primaryMsg.content).trim();
          if (primaryText) {
            const idemKey = buildIdempotencyKey(mapping.sessionKey, primaryMsg.role || "assistant", primaryText);
            if (!checkAndMarkIdempotency(idemKey)) {
              console.log(`[Episodic Memory] message_sent: duplicate detected (idemKey=${idemKey.slice(0, 40)}...), skipping.`);
              return;
            }
          }

          console.log(`[Episodic Memory] message_sent: source=bridge_ingress sessionKey=${mapping.sessionKey} agentId=${agentId} messages=${messages.length}`);

          state.segmenter.processIncrementalTurn(messages, agentWs, agentId, "message_sent").catch(err => {
            console.error("[Episodic Memory] message_sent: incremental ingest error:", err);
          });
        });
      }


      // ─── before_compaction hook ────────────────────────────────────────────────
      // Fires immediately before OpenClaw's LLM compaction runs.
      // Flush segmenter + archive all unprocessed messages losslessly.
      api.on("before_compaction", async (_event?: any, ctx?: any) => {
        const { agentId, agentWs } = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
        if (!agentWs) return;
        await prepareWorkspaces({ agentId, agentWs, defaultAgentId: agentId, defaultWs: agentWs });
        const state = getAgentState(agentId);
        state.lastAgentWs = agentWs;
        console.log("[Episodic Memory] before_compaction: protecting memories...");
        try {
          await state.archiver.forceFlush(agentWs, agentId);
          const sessionFile = ctx?.sessionFile || _event?.sessionFile;
          if (typeof sessionFile === "string" && sessionFile.length > 0) {
            await state.archiver.archiveUnprocessed({ sessionFile, agentWs, agentId });
          } else {
            console.warn("[Episodic Memory] before_compaction: no sessionFile in ctx — skipping archive.");
          }
          state.lastInjectedResultHash = "";
          state.lastInjectionMessageCount = 0;
          console.log("[Episodic Memory] before_compaction: memories protected.");
        } catch (err) {
          console.error("[Episodic Memory] before_compaction: error (non-fatal, compaction continues):", err);
        }
      });

      // ─── after_compaction hook ─────────────────────────────────────────────────
      // Fires after OpenClaw's LLM compaction completes.
      // If an ep-anchor was written, read it and inject it into the next assemble().
      api.on("after_compaction", async (_event?: any, ctx?: any) => {
        const { agentId, agentWs } = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
        if (!agentWs) return;
        const state = getAgentState(agentId);
        console.log("[Episodic Memory] after_compaction: checking for anchor...");
        try {
          const anchorText = await state.anchorStore.read(agentWs);
          if (anchorText) {
            activateAnchorInjection(state, { anchor: anchorText, summary: "" });
            await state.anchorStore.consume(agentWs);
            console.log("[Episodic Memory] after_compaction: anchor injected.");
          } else {
            console.log("[Episodic Memory] after_compaction: no anchor found, proceeding without.");
          }
          state.lastInjectedResultHash = "";
          state.lastInjectionMessageCount = 0;
        } catch (err) {
          console.error("[Episodic Memory] after_compaction: error (non-fatal):", err);
        }
      });

      // ─── before_prompt_build フック: セグメンテーション + メモリ注入 ─────────────
      // assemble() が呼ばれない環境（contextEngine slot が "legacy" など）でのフォールバック。
      // OpenClaw の contextEngine slot 設定に関係なく毎ターン確実に呼ばれる。
      // event: { prompt: string, messages: unknown[] }
      // ctx: { runId, agentId, sessionKey, sessionId, workspaceDir, ... }
      // 戻り値: { prependSystemContext?: string }
      api.on("before_prompt_build", async (event: any, ctx: any) => {
        const msgs = ((event && event.messages) || []) as Message[];
        const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
        const { agentId, agentWs } = resolution;
        if (!agentWs) return {};

        await prepareWorkspaces(resolution);
        const state = getAgentState(agentId);
        state.lastAgentWs = agentWs;

        // ── Tool-first gate: if enabled, strict no-op — bridge ingress handles ingest ──
        // When effectiveToolFirstEnabled=true (runtimeBridgeMode=cli_universal forces ON),
        // before_dispatch/message_sent are the primary ingest path via processIncrementalTurn.
        // Calling processTurn here would cause duplicate ingest of the same messages.
        // Do NOT call tfGate.evaluate() — ep-recall tool handles recall gating.
        if (effectiveToolFirstEnabled) {
          console.log(`[Episodic Memory] before_prompt_build source=tool_first skip_reason=no_op agentId=${agentId}`);
          return {};
        }

        // ── Fallback path (tool-first disabled) — original behavior ──
        // ── セグメンテーション（fire-and-forget）──
        state.segmenter.processTurn(msgs, agentWs, agentId).catch(err => {
          console.log("[Episodic Memory] Fallback segmenter error in before_prompt_build:", err);
        });

        const ESTIMATED_MAX_EPISODIC_TOKENS = 1024;
        const k = 5;

        // アンカー注入（after_compaction でセットされた状態があれば）
        let anchorPrependText = "";
        let anchorTokens = 0;
        const anchorState = state.anchorInjection;
        if (anchorState) {
          const anchorPayload = buildAnchorInjectionPayload(anchorState);
          const anchorWindow = anchorState.remainingEligibleAssembles;
          anchorState.remainingEligibleAssembles = Math.max(0, anchorState.remainingEligibleAssembles - 1);

          if (!anchorPayload) {
            logAnchorInjectionOutcome({
              status: "skipped",
              source: anchorState.source,
              agentId,
              agentWs,
              anchorId: anchorState.anchorId,
              summaryId: anchorState.summaryId,
              estimatedTokens: 0,
              anchorInjectionWindow: anchorWindow,
              reason: "empty_payload",
            });
            clearAnchorInjection(state);
          } else {
            const estimatedAnchorTokens = estimateTokens(anchorPayload);
            if (estimatedAnchorTokens > ESTIMATED_MAX_EPISODIC_TOKENS) {
              logAnchorInjectionOutcome({
                status: "skipped",
                source: anchorState.source,
                agentId,
                agentWs,
                anchorId: anchorState.anchorId,
                summaryId: anchorState.summaryId,
                estimatedTokens: estimatedAnchorTokens,
                anchorInjectionWindow: anchorWindow,
                reason: "anchor_budget_exceeded",
              });
            } else {
              anchorPrependText = anchorPayload;
              anchorTokens = estimatedAnchorTokens;
              logAnchorInjectionOutcome({
                status: "injected",
                source: anchorState.source,
                agentId,
                agentWs,
                anchorId: anchorState.anchorId,
                summaryId: anchorState.summaryId,
                estimatedTokens: estimatedAnchorTokens,
                anchorInjectionWindow: anchorWindow,
              });
            }

            if (anchorState.remainingEligibleAssembles <= 0) {
              clearAnchorInjection(state);
            }
          }
        }

        const maxRecallTokens = Math.max(0, ESTIMATED_MAX_EPISODIC_TOKENS - anchorTokens);
        if (maxRecallTokens <= 0) {
          const prependSystemContext = anchorPrependText.trim();
          return prependSystemContext ? { prependSystemContext } : {};
        }

        try {
          const recallOutcome = await retriever.retrieveRelevantContext(msgs, agentWs, k, maxRecallTokens);

          // ── 結果ベース再注入防止 (ターン数ベース) ──
          const episodeIds = recallOutcome.episodeIds || [];
          const resultHash = episodeIds.sort().join("|");
          const currentHash = resultHash ? createHash("sha1").update(resultHash).digest("hex") : "";
          const currentMsgCount = msgs.length;
          const turnsSinceLastInjection = currentMsgCount - state.lastInjectionMessageCount;
          const isSameResult = currentHash && currentHash === state.lastInjectedResultHash;
          const isWithinCooldown = recallReInjectionCooldownTurns > 0 && turnsSinceLastInjection < recallReInjectionCooldownTurns;

          if (isSameResult && isWithinCooldown) {
            console.log(`[Episodic Memory] recall re-injection guard: same ${episodeIds.length} episode(s), skipping (${turnsSinceLastInjection} turns since last injection)`);
            const prependSystemContext = anchorPrependText.trim();
            return prependSystemContext ? { prependSystemContext } : {};
          }

          if (currentHash) {
            state.lastInjectedResultHash = currentHash;
            state.lastInjectionMessageCount = currentMsgCount;
          }
          // ── 再注入防止終了 ──

          const status: PrependSystemContextStatus =
            recallOutcome.reason === "injected"
              ? (recallOutcome.truncatedEpisodeCount > 0 ? "truncated" : "injected")
              : "skipped";

          const queryParts = msgs.slice(-5)
            .map(m => {
              const content = extractText(m.content).trim();
              return content ? `${m.role}: ${content}` : "";
            })
            .filter(part => part.length > 0);
          const fullQuery = queryParts.join("\n").trim();
          const queryHash = fullQuery ? createHash("sha1").update(fullQuery).digest("hex") : "";

          logPrependSystemContextOutcome({
            status,
            agentId,
            agentWs,
            queryHash: recallOutcome.queryHash || queryHash,
            estimatedTokens: estimateTokens(recallOutcome.text),
            injectedEpisodeCount: recallOutcome.injectedEpisodeCount,
            truncatedEpisodeCount: recallOutcome.truncatedEpisodeCount,
            reason: status === "skipped" ? recallOutcome.reason : undefined,
            firstEpisodeId: recallOutcome.firstEpisodeId,
            topMatchedBy: recallOutcome.diagnostics.topMatchedBy,
            matchedByCounts: recallOutcome.diagnostics.matchedByCounts,
            fallbackReasons: recallOutcome.diagnostics.fallbackReasons,
            topicsFallbackCount: recallOutcome.diagnostics.topicsFallbackCount,
            // v0.4.3 observability
            eligibleRecentMessages: recallOutcome.recallQueryDebug?.eligibleRecentMessages,
            skippedImageLikeMessages: recallOutcome.recallQueryDebug?.skippedImageLikeMessages,
            dominantScript: recallOutcome.recallQueryDebug?.dominantScript,
          });

          const prependSystemContext = [anchorPrependText, recallOutcome.text]
            .map((part) => part.trim())
            .filter((part) => part.length > 0)
            .join("\n\n");

          return prependSystemContext ? { prependSystemContext } : {};
        } catch (err) {
          console.log("[Episodic Memory] before_prompt_build recall error:", err);
          return anchorPrependText.trim() ? { prependSystemContext: anchorPrependText.trim() } : {};
        }
      });

      api.registerContextEngine("episodic-claw", () => {
        return {
          info: {
            id: "episodic-claw",
            name: "Episodic Memory Engine",
                        // Compaction is fully delegated to OpenClaw default LLM compaction.
            // episodic-claw reacts to before_compaction / after_compaction hooks.
          },
        async ingest(ctx: any) {
          const msgs = (ctx.messages || []) as Message[];
          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) return { ingested: false };
          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;
          try {
            state.lastInjectedResultHash = "";
            state.lastInjectionMessageCount = 0;
            await state.segmenter.processTurn(msgs, agentWs, agentId);
            // [Fix D-3] setMeta rate-limit: フォールバック連発時の spam を抑制
            const nowMeta = Date.now();
            if (nowMeta - state.lastSetMetaTime >= SET_META_INTERVAL_MS) {
              await rpcClient.setMeta("last_activity", nowMeta.toString(), agentWs);
              state.lastSetMetaTime = nowMeta;
            }
            state.lastInjectedResultHash = "";
            state.lastInjectionMessageCount = 0;
          } catch (err) {
            console.error("[Episodic Memory] Error processing ingest:", err);
          }
          return { ingested: true };
        },
        async assemble(ctx: any) {
          const msgs = (ctx.messages || []) as Message[];
          console.log(`[Episodic Memory] assemble() called (${msgs.length} messages) — contextEngine slot IS set to "episodic-claw"`);

          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) {
            return { messages: msgs, systemPromptAddition: "", estimatedTokens: 0 };
          }
          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;

          // ── Tool-first gate: if enabled, strict no-op — bridge ingress handles ingest ──
          // When effectiveToolFirstEnabled=true (runtimeBridgeMode=cli_universal forces ON),
          // before_dispatch/message_sent are the primary ingest path via processIncrementalTurn.
          // Calling processTurn here would cause duplicate ingest of the same messages.
          // Only allow anchor injection if available.
          if (effectiveToolFirstEnabled) {
            let anchorPrependText = "";
            const anchorState = state.anchorInjection;
            if (anchorState) {
              const anchorPayload = buildAnchorInjectionPayload(anchorState);
              if (anchorPayload) {
                anchorPrependText = anchorPayload;
              }
              anchorState.remainingEligibleAssembles = Math.max(0, anchorState.remainingEligibleAssembles - 1);
              if (anchorState.remainingEligibleAssembles <= 0) {
                clearAnchorInjection(state);
              }
            }

            // Return no-op for recall, only anchor text if any
            const systemPromptAddition = anchorPrependText.trim();
            return {
              messages: msgs,
              systemPromptAddition,
              estimatedTokens: systemPromptAddition ? estimateTokens(systemPromptAddition) : 0,
            };
          }

          // ── Fallback path (tool-first disabled) — original behavior ──
          // Insurance: re-run segmenter in case before_prompt_build was blocked.
          state.segmenter.processTurn(msgs, agentWs, agentId).catch(err => {
            console.log("[Episodic Memory] Segmenter error in assemble (fallback):", err);
          });

          const totalBudget = typeof ctx.tokenBudget === "number" && ctx.tokenBudget > 0
            ? ctx.tokenBudget
            : 0;
          const reserveTokens = cfg.reserveTokens ?? 2048;
          const maxEpisodicTokens = Math.max(0, totalBudget - reserveTokens);
          const k = 5;

          if (maxEpisodicTokens <= 0) {
            return { messages: msgs, systemPromptAddition: "", estimatedTokens: 0 };
          }

          // アンカー注入
          let anchorPrependText = "";
          let anchorTokens = 0;
          const anchorState = state.anchorInjection;
          if (anchorState) {
            const anchorPayload = buildAnchorInjectionPayload(anchorState);
            anchorState.remainingEligibleAssembles = Math.max(0, anchorState.remainingEligibleAssembles - 1);
            if (anchorPayload) {
              const estimatedAnchorTokens = estimateTokens(anchorPayload);
              if (estimatedAnchorTokens <= maxEpisodicTokens) {
                anchorPrependText = anchorPayload;
                anchorTokens = estimatedAnchorTokens;
              }
            }
            if (anchorState.remainingEligibleAssembles <= 0) {
              clearAnchorInjection(state);
            }
          }

          const maxRecallTokens = Math.max(0, maxEpisodicTokens - anchorTokens);
          if (maxRecallTokens <= 0) {
            const systemPromptAddition = anchorPrependText.trim();
            return { messages: msgs, systemPromptAddition, estimatedTokens: estimateTokens(systemPromptAddition) };
          }

          try {
            const recallOutcome = await retriever.retrieveRelevantContext(msgs, agentWs, k, maxRecallTokens);
            const systemPromptAddition = [anchorPrependText, recallOutcome.text]
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
              .join("\n\n");
            return {
              messages: msgs,
              systemPromptAddition,
              estimatedTokens: estimateTokens(systemPromptAddition),
            };
          } catch (err) {
            console.log("[Episodic Memory] assemble recall error:", err);
            const systemPromptAddition = anchorPrependText.trim();
            return { messages: msgs, systemPromptAddition, estimatedTokens: estimateTokens(systemPromptAddition) };
          }
          },
        };
      });

      // ─── CLI Memory Prompt Guidance (Tool-first Recall Contract) ─────────────
      // For CLI path where before_prompt_build doesn't fire, we register a memory
      // prompt section that guides the model to use ep-recall conditionally.
      // This is the plugin-only bridge for CLI (A-2 in plan).
      // Uses api.registerMemoryCapability if available, otherwise falls back to
      // enhancing tool descriptions.

      // ── Warning: bridge ingress disabled (legacy_embedded mode) ──
      if (effectiveBridgeMode === "legacy_embedded") {
        console.warn("[Episodic Memory] runtimeBridgeMode=legacy_embedded: bridge ingress (before_dispatch/message_sent) is disabled. The agent will rely on legacy embedded path (before_prompt_build/assemble).");
      }

      const TOOL_FIRST_MEMORY_GUIDANCE = `## Episodic Memory Usage (tool-first)
- Before answering, check if the user's message references past conversations, ongoing tasks, or asks about something you discussed before.
- If it does: call ep-recall with a focused query built from the key topics. Use k=${tfConfig.k}.
- If ep-recall returns results: integrate them into your answer.
- If ep-recall returns nothing: answer normally without fabricating memory content.
- For simple acknowledgments (OK, thanks, etc.): skip ep-recall entirely.
- Your memory tools are ep-recall (search), ep-save (save), ep-expand (read full), and ep-anchor (session continuity). Always use these before any other memory tool.`;

      if (effectiveToolFirstEnabled && typeof (api as any).registerMemoryCapability === "function") {
        (api as any).registerMemoryCapability({
          promptBuilder: () => TOOL_FIRST_MEMORY_GUIDANCE,
        });
        console.log("[Episodic Memory] CLI memory prompt guidance registered via registerMemoryCapability.");
      }
      // If registerMemoryCapability is not available, the guidance is embedded in the
      // ep-recall tool description below as a fallback.

      const EpRecallSchema = Type.Object({
        query: Type.String({ description: "Search explicitly within the agent's Episodic Memory for a given topic or keyword" }),
        k: Type.Optional(Type.Number({ description: "Number of episodes to return (default 3)" })),
        topics: Type.Optional(Type.Array(Type.String(), {
          description: "Optional semantic topics filter (e.g. ['go-language', 'concurrency'])"
        })),
        strictTopics: Type.Optional(Type.Boolean({
          description: "When true, topics acts as a strict facet filter. When false, topics is only used as a soft rerank hint."
        })),
      });

      api.registerTool((ctx: any) => ({
        name: "ep-recall",
        description: `Search explicitly within the agent's Episodic Memory for a given topic or keyword. Use this when the auto-retrieval isn't sufficient or you need specific historical facts. IMPORTANT: Call this conditionally — only when the user's message references past events, ongoing tasks, comparisons, or re-confirmation. Skip for simple acknowledgments (OK, thanks, etc.). If no results are returned, answer normally without fabricating memory content.`,
        parameters: EpRecallSchema,
        execute: async (_toolCallId: string, params: any) => {
          // [A-3] gateway_start 前に呼ばれた場合に空パスで RPC が発行されるのを防ぐ
          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) {
            return { content: [{ type: "text", text: "My memory isn't up yet — the gateway hasn't started. Try again in a moment." }] };
          }
          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;

          // ── v0.4.6: Deterministic filter enforcement in execute path ──
          // CLI path may not run before_prompt_build/assemble hooks, so we MUST
          // run the gate here. Filter order: novelty -> intent -> fingerprint -> negative cache.
          // If filter says skip, return short no-op and DO NOT call RPC recall.
          // When runtimeBridgeMode=cli_universal, tool-first is forced ON.
          if (effectiveToolFirstEnabled) {
            // Build query using existing Parse/Rewrite logic (NOT raw user message).
            // Use instantDeterministicRewrite with recent user messages when available.
            const ctxMessages = (ctx?.messages || []) as Message[];
            let query: string;
            if (Array.isArray(ctxMessages) && ctxMessages.length > 0) {
              const recentMsgs = ctxMessages
                .filter((m: Message) => m.role === "user")
                .slice(-(cfg.recallQueryRecentMessageCount ?? 4));
              query = instantDeterministicRewrite(recentMsgs, cfg);
            } else {
              // Fallback to provided params.query if message context unavailable.
              query = (params && typeof params.query === "string") ? params.query : "";
            }

            // Run the lightweight filter check (fingerprint + negative cache).
            // Novelty/intent were already checked by the model's decision to call this tool,
            // but we still enforce fingerprint dedup and negative cache backoff.
            const gateResult = tfGate.evaluateForQuery(agentId, query);
            if (!gateResult.pass) {
              console.log(`[Episodic Memory] ep-recall source=tool_first_filter skip_reason=${gateResult.skipReason} agentId=${agentId}`);
              return { content: [{ type: "text", text: "No new memory context to check — moving on with your question." }] };
            }

            // Use the gate's query (which is the rewritten query) for the RPC call.
            // Override params.query with the gate's query for consistency.
            params = { ...params, query: gateResult.query };
          }

          const p = (params || {}) as Record<string, unknown>;
          const k = typeof p.k === "number" ? p.k : 3;
          const topics = Array.isArray(p.topics)
            ? p.topics.filter((item): item is string => typeof item === "string")
            : [];
          // For ep-recall (explicit facet search), default to strict filtering when not specified.
          const strictTopics = typeof (p as any).strictTopics === "boolean" ? ((p as any).strictTopics as boolean) : true;
          try {
            const primaryResults = await rpcClient.recall(
              p.query as string || "",
              k,
              agentWs,
              topics,
              strictTopics,
              recallCalibration
            );
            const results = (primaryResults ?? []).slice(0, k);
            if (!results || results.length === 0) {
              // Record no-hit for negative cache backoff
              if (p.query && typeof p.query === "string") {
                const queryFp = createHash("sha1").update((p.query as string).slice(0, tfConfig.maxFingerprintChars)).digest("hex");
                tfGate.recordNoHit(agentId, queryFp);
                console.log(`[Episodic Memory] ep-recall no-hit recorded fp=${queryFp.substring(0, 8)} agentId=${agentId}`);
              }
              return { content: [{ type: "text", text: "Nothing came back. I don't have any memories matching that." }] };
            }
            // Record hit — clear negative cache entry
            if (p.query && typeof p.query === "string") {
              const queryFp = createHash("sha1").update((p.query as string).slice(0, tfConfig.maxFingerprintChars)).digest("hex");
              tfGate.recordHit(agentId, queryFp);
            }
            const safeResults = results.map((res: any) => {
              const rawRecord = res?.Record ?? res?.record;
              if (!rawRecord || typeof rawRecord !== "object") {
                return res;
              }
              const { vector, Vector, ...rest } = rawRecord as Record<string, unknown>;
              return { ...res, Record: rest };
            });
            const lines: string[] = [];
            for (const res of safeResults) {
              const record = res?.Record ?? res?.record ?? {};
              const title = record.title || record.id || "Unknown";
              const date = record.timestamp ? new Date(record.timestamp).toISOString().split("T")[0] : "unknown date";
              const score = typeof res.Score === "number" ? res.Score.toFixed(3) : "N/A";
              const bodyText = (res.Body ?? res.body ?? "").toString().trim();
              lines.push(`[${title} · ${date} · relevance: ${score}]`);
              lines.push(bodyText.length > 0 ? bodyText : "(nothing stored here)");
              lines.push("");
            }
            return {
              content: [{ type: "text", text: lines.join("\n").trim() }],
              details: safeResults
            };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Ran into a snag trying to remember that: ${e.message}` }] };
          }
        }
      }));

      const EpSaveSchema = Type.Object({
        content: Type.String({
          description: "The content to save. Write freely in natural language. Paragraphs and line breaks are supported. Maximum 3600 characters.",
          maxLength: 3600
        }),
        topics: Type.Optional(Type.Array(Type.String(), {
          description: "Optional semantic topics for this memory (e.g. ['goroutine', 'concurrency'])"
        })),
        tags: Type.Optional(Type.Array(Type.String(), {
          description: "Deprecated alias for topics. Keep only for one release window."
        }))
      });

      api.registerTool((ctx: any) => ({
        name: "ep-save",
        description: "Manually save any critical memory, note, or observation into Episodic Memory. Write the content freely in natural language — use multiple paragraphs if needed. Max 3600 characters.",
        parameters: EpSaveSchema,
        execute: async (_toolCallId: string, params: any) => {
          // [A-3] gateway_start 前に呼ばれた場合に空パスで RPC が発行されるのを防ぐ
          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) {
            return { content: [{ type: "text", text: "My memory isn't up yet — the gateway hasn't started. Try again in a moment." }] };
          }
          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;
          try {
            const p = (params || {}) as Record<string, unknown>;
            const raw: string = (p.content as string) || (p.summary as string) || "";

            if (!raw || typeof raw !== "string" || !raw.trim()) {
              return { content: [{ type: "text", text: "Nothing to save — the content was empty. Write something and I'll hold onto it." }] };
            }
            invalidateRecallCacheForWorkspace(agentWs);
            const runes = Array.from(raw);
            const content = runes.length > 3600 ? runes.slice(0, 3600).join("") + "\n...(truncated)" : raw;
            const topicSource = Array.isArray(p.topics) && p.topics.length > 0 ? p.topics : p.tags;
            const topics = normalizeTopics(topicSource);
            if (Array.isArray(p.tags) && p.tags.length > 0 && (!Array.isArray(p.topics) || p.topics.length === 0)) {
              console.warn("[Episodic Memory] ep-save: 'tags' is deprecated; use 'topics' instead.");
            }
            const slugRes = await rpcClient.generateEpisodeSlug({
              summary: content,
              agentWs,
              topics,
              tags: ["manual-save"],
              edges: [],
              savedBy: agentId
            });

            return {
              content: [{ type: "text", text: `Got it — filed that away at ${slugRes.path}` }],
              details: { path: slugRes.path, slug: slugRes.slug }
            };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Something went wrong saving that: ${e.message}` }] };
          }
        }
      }));

      const EpExpandSchema = Type.Object({
        slug: Type.String({ description: "The ID/Slug of the episode to expand" })
      });

      api.registerTool((ctx: any) => ({
        name: "ep-expand",
        description: "Expand a saved episode to read its full narrative text. Use this when you need to see the complete episode content that was stored under a specific slug.",
        parameters: EpExpandSchema,
        execute: async (_toolCallId: string, params: any) => {
          // [A-3] gateway_start 前に呼ばれた場合に空パスで RPC が発行されるのを防ぐ
          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) {
            return { content: [{ type: "text", text: "My memory isn't up yet — the gateway hasn't started. Try again in a moment." }] };
          }
          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;
          try {
            const p = (params || {}) as Record<string, unknown>;
            let expanded = await rpcClient.expand(p.slug as string || "", agentWs);
            if (!expanded || !expanded.children || expanded.children.length === 0) {
              return { content: [{ type: "text", text: "Nothing underneath that one — either it doesn't exist yet or it's not a summary node." }] };
            }
            return {
              content: [{ type: "text", text: `Here's what's stored under that summary:\n${expanded.body}` }],
              details: expanded
            };
          } catch (e: any) {
             return { content: [{ type: "text", text: `Couldn't unpack that one: ${e.message}` }] };
          }
        }
      }));

      // ─── ep-anchor: セッションアンカーの保存 ───
      const EpAnchorSchema = Type.Object({
        anchorText: Type.String({
          description: "The current session state, progress, and immediate next steps. Keep it focused on what the next context window needs to resume seamlessly. Max 4000 characters.",
          maxLength: 4000
        }),
        summaryText: Type.Optional(Type.String({
          description: "Optional broader context or background summary for longer-running sessions. Max 4000 characters.",
          maxLength: 4000
        }))
      });

      api.registerTool((ctx: any) => ({
        name: "ep-anchor",
        description: "Save a session anchor that persists across context compaction. Use this to record your current progress, session state, and immediate next steps so the next context window can resume without re-reading the full conversation. Different from ep-save: ep-anchor is for session continuity (auto-injected after compaction), ep-save is for long-term episodic memory (searchable via ep-recall). Max 4000 characters total.",
        parameters: EpAnchorSchema,
        execute: async (_toolCallId: string, params: any) => {
          // [A-3] gateway_start 前に呼ばれた場合に空パスで RPC が発行されるのを防ぐ
          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) {
            return { content: [{ type: "text", text: "My memory isn't up yet — the gateway hasn't started. Try again in a moment." }] };
          }
          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;
          try {
            const p = (params || {}) as Record<string, unknown>;
            const anchorText: string = (p.anchorText as string) || "";
            const summaryText: string = (p.summaryText as string) || "";

            // 空文字バリデーション: 両方が空の場合は処理中断
            if (!anchorText.trim() && !summaryText.trim()) {
              return { content: [{ type: "text", text: "Nothing to anchor — both anchorText and summaryText were empty. Provide at least one." }] };
            }

            // コンテンツ結合
            const combined = [anchorText.trim(), summaryText.trim()].filter(Boolean).join("\n\n");

            // アンカーサイズ上限（4000文字）
            const runes = Array.from(combined);
            const content = runes.length > 4000 ? runes.slice(0, 4000).join("") + "\n...(truncated)" : combined;

            // アンカー保存
            const result = await state.anchorStore.write({
              content,
              agentWs,
              agentId,
            });

            // 次のリコール時に最新キャッシュが使われるように無効化
            invalidateRecallCacheForWorkspace(agentWs);

            return {
              content: [{ type: "text", text: `Anchor saved. Path: ${result.path}${result.slug ? `\nSlug: ${result.slug}` : ""}` }],
              details: result
            };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Something went wrong saving the anchor: ${e.message}` }] };
          }
        }
      }));

    } catch (err: any) {
      console.error("[Episodic Memory DEBUG] CRASH IN REGISTER:", err.stack || err);
      throw err;
    }
  }
};

export default episodicClawPlugin;
