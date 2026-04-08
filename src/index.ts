import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { createHash } from "crypto";
import { Type } from "@sinclair/typebox";
import { EpisodicCoreClient, FileEventDebouncer, resolveSessionFile, ingestColdStartSession, ingestedSessions } from "./rpc-client";
import { buildRecallCalibration, loadConfig } from "./config";
import { EventSegmenter, Message, extractText } from "./segmenter";
import { EpisodicRetriever, RecallInjectionOutcome } from "./retriever";
import { EpisodicArchiver } from "./archiver";
import { AnchorStore } from "./anchor-store";
import { estimateTokens } from "./utils";
import { RecallFallbackReason, RecallMatchedBy } from "./types";

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
      description: "Character threshold that triggers a forced buffer flush regardless of surprise score (default 7200). Must be >= 500."
    })),
    maxCharsPerChunk: Type.Optional(Type.Integer({
      minimum: 500,
      description: "Max characters per chunk sent to batchIngest (default 9000). Setting this below maxBufferChars splits one flush into multiple episodes. Must be >= 500."
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
  agentStates: Map<string, AgentRuntimeState>;
  debouncers: Map<string, FileEventDebouncer>;
  watcherWorkspaces: Set<string>;
  watcherDegradedWorkspaces: Set<string>;
};
let _singleton: SingletonType | null = null;

const episodicClawPlugin = {
  id: "episodic-claw",
  name: "Episodic Memory",
  description: "D0/D1 hierarchical contextual memory and event stream for OpenClaw.",
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
        const rpcClient = new EpisodicCoreClient();
        const retriever = new EpisodicRetriever(rpcClient, cfg);
        _singleton = {
          rpcClient,
          retriever,
          sidecarStarted: false,
          cfg,
          agentStates: new Map(),
          debouncers: new Map(),
          watcherWorkspaces: new Set(),
          watcherDegradedWorkspaces: new Set(),
        };
        (global as any)[SINGLETON_KEY] = _singleton; // global に保存してプロセス全体で共有
        console.log("[Episodic Memory] Singleton created.");
      } else {
        console.log("[Episodic Memory] Singleton reused (BUG-1 guard active).");
      }

      const { rpcClient, retriever, cfg } = _singleton;
      const recallCalibration = buildRecallCalibration(cfg);
      // openClawGlobalConfig は gateway_start ハンドラ内の workspace 解決で使用
      const openClawGlobalConfig = api.runtime?.config?.loadConfig?.() || {};

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
          }
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
              const msgCount = await ingestColdStartSession(sessionFile, agentWs, rpcClient, hasApiKey);
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

        // ── セグメンテーション（fire-and-forget）──
        state.segmenter.processTurn(msgs, agentWs, agentId).catch(err => {
          console.log("[Episodic Memory] Fallback segmenter error in before_prompt_build:", err);
        });

        // ── メモリ注入（tokenBudget なし → 固定上限）──
        // before_prompt_build は tokenBudget を受け取らないため、安全側の固定値を使う。
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

          // before_prompt_build が既にセグメンテーション+メモリ注入を担当しているため、
          // assemble() では最小限の処理のみ行う（二重注入防止）。
          // 万一 before_prompt_build がブロックされた場合の保険として、
          // 簡易的なメモリ注入のみ実行する（トークン予算は ctx.tokenBudget を使用）。
          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) {
            return { messages: msgs, prependSystemContext: "", estimatedTokens: 0 };
          }
          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;

          // セグメンテーションは before_prompt_build で既に実行済みだが、
          // assemble() が呼ばれる = before_prompt_build がブロックされている可能性もあるため、
          // 保険として再実行する。
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
            return { messages: msgs, prependSystemContext: "", estimatedTokens: 0 };
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
            const prependSystemContext = anchorPrependText.trim();
            return { messages: msgs, prependSystemContext, estimatedTokens: estimateTokens(prependSystemContext) };
          }

          try {
            const recallOutcome = await retriever.retrieveRelevantContext(msgs, agentWs, k, maxRecallTokens);
            const prependSystemContext = [anchorPrependText, recallOutcome.text]
              .map((part) => part.trim())
              .filter((part) => part.length > 0)
              .join("\n\n");
            return {
              messages: msgs,
              prependSystemContext,
              estimatedTokens: estimateTokens(prependSystemContext),
            };
          } catch (err) {
            console.log("[Episodic Memory] assemble recall error:", err);
            const prependSystemContext = anchorPrependText.trim();
            return { messages: msgs, prependSystemContext, estimatedTokens: estimateTokens(prependSystemContext) };
          }
          },
        };
      });

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
        description: "Search explicitly within the agent's Episodic Memory for a given topic or keyword. Use this when the auto-retrieval isn't sufficient or you need specific historical facts.",
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
              return { content: [{ type: "text", text: "Nothing came back. I don't have any memories matching that." }] };
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
        slug: Type.String({ description: "The ID/Slug of the D1 summary episode" })
      });

      api.registerTool((ctx: any) => ({
        name: "ep-expand",
        description: "Expand a D1 semantic summary node to read its underlying raw chronological episodes (D0). Use this when you need specific details that were abstracted away.",
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
