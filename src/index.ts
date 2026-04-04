import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { createHash } from "crypto";
import { Type } from "@sinclair/typebox";
import { EpisodicCoreClient, FileEventDebouncer } from "./rpc-client";
import { buildRecallCalibration, loadConfig } from "./config";
import { EventSegmenter, Message, extractText } from "./segmenter";
import { EpisodicRetriever, RecallInjectionOutcome } from "./retriever";
import { Compactor, DEFAULT_ANCHOR_PROMPT, DEFAULT_COMPACTION_PROMPT } from "./compactor";
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
    handler: (event?: any, ctx?: any) => void | Promise<void>,
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

type RecallCacheState = {
  lastRecallResult: RecallInjectionOutcome | null;
  lastRecallTime: number;
  lastRecallFullKey: string;
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
  compactor: Compactor;
  recallCache: RecallCacheState;
  anchorInjection: AnchorInjectionState | null;
  lastSetMetaTime: number;
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
    contextThreshold: Type.Optional(Type.Number({
      minimum: 0,
      maximum: 1,
      default: 0.85,
      description: "Ratio of the active token budget at which proactive compaction should trigger (default 0.85)."
    })),
    anchorPrompt: Type.Optional(Type.String({
      default: DEFAULT_ANCHOR_PROMPT,
      description: "Pre-compaction instruction given to the Agent just before the anchor system message is written. Supports {evictedCount}, {keptRawCount}, {freshTailCount}. Tells the Agent what to record before the context window is trimmed. Unset uses the current built-in wording."
    })),
    compactionPrompt: Type.Optional(Type.String({
      default: DEFAULT_COMPACTION_PROMPT,
      description: "Pre-compaction instruction given to the Agent just before the compaction summary system message is written. Supports {evictedCount}, {keptRawCount}, {freshTailCount}. Tells the Agent how to summarise the range about to be evicted. Unset uses the current built-in wording."
    })),
    autoInjectGuardMinScore: Type.Optional(Type.Number({
      minimum: 0,
      maximum: 1,
      description: "Minimum 0..1 score required before degraded HNSW fallback results may auto-inject into prependSystemContext (default 0.86)."
    })),
    anchorInjectionAssembles: Type.Optional(Type.Integer({
      description: "How many eligible prompt builds may temporarily inject the latest compaction anchor + summary (default 1). Budget-truncated early returns do not consume this window."
    })),
    freshTailCount: Type.Optional(Type.Integer({
      description: "Canonical config key. Number of freshest raw messages to retain during compaction (default 96)."
    })),
    recentKeep: Type.Optional(Type.Integer({
      description: "Legacy alias for freshTailCount. Kept for backward compatibility during the v0.3.0 transition."
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
      console.log("[Episodic Memory] Registering plugin...");

      // CLIモード判定：OpenClaw固有のデーモンコマンド（gateway / agent / test）の場合のみ初期化を行う。
      // "start" は npm start / yarn start でも argv に現れるため意図的に除外している。
      const DAEMON_CMDS = ["gateway", "agent", "test"];
      const isDaemon = DAEMON_CMDS.some(cmd => process.argv.includes(cmd));
      if (!isDaemon) {
         console.log("[Episodic Memory] CLI mode detected. Skipping plugin initialization to prevent blocks.");
         return;
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

      // [Fix D-2] assemble() recall debounce キャッシュ（フォールバック連発対策）
      // 時間キーだけでは不十分（フォールバック間隔が 1〜2 分のため）。
      // 最後のユーザーメッセージテキストをコンテンツキーとして追加し、
      // 同一クエリなら時間に関わらず cache hit、異なるクエリなら即失効する。
      // BUG-1 修正: _singleton 経由で状態を共有（二重 register() でもキャッシュが引き継がれる）
      const RECALL_DEBOUNCE_MS = 5000; // 5秒以内の同一クエリ再試行をカバー（安全マージン）

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
        const compactor = new Compactor(rpcClient, segmenter, cfg.freshTailCount ?? cfg.recentKeep ?? 96, {
          anchorPrompt: cfg.anchorPrompt,
          compactionPrompt: cfg.compactionPrompt,
        });
          const state: AgentRuntimeState = {
            agentId,
            lastAgentWs: "",
            segmenter,
            compactor,
            recallCache: {
              lastRecallResult: null,
              lastRecallTime: 0,
              lastRecallFullKey: "",
            },
            anchorInjection: null,
            lastSetMetaTime: 0,
          };
        _singleton!.agentStates.set(agentId, state);
        return state;
      };

      const clearRecallCache = (state: AgentRuntimeState) => {
        state.recallCache.lastRecallResult = null;
        state.recallCache.lastRecallTime = 0;
        state.recallCache.lastRecallFullKey = "";
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
        // activation boundary live here in the plugin's compact() success path.
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
            clearRecallCache(state);
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

      api.registerContextEngine("episodic-claw", () => {
        return {
          info: {
            id: "episodic-claw",
            name: "Episodic Memory Engine",
            // The plugin owns compaction execution once the host calls compact().
            // Proactive pressure checks are handled in assemble(); manual `/compact`
            // stays host-native and this engine remains the execution endpoint.
            ownsCompaction: true,
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
            clearRecallCache(state);
            await state.segmenter.processTurn(msgs, agentWs, agentId);
            // [Fix D-3] setMeta rate-limit: フォールバック連発時の spam を抑制
            const nowMeta = Date.now();
            if (nowMeta - state.lastSetMetaTime >= SET_META_INTERVAL_MS) {
              await rpcClient.setMeta("last_activity", nowMeta.toString(), agentWs);
              state.lastSetMetaTime = nowMeta;
            }
            clearRecallCache(state);
          } catch (err) {
            console.error("[Episodic Memory] Error processing ingest:", err);
          }
          return { ingested: true };
        },
        async assemble(ctx: any) {
          const msgs = (ctx.messages || []) as Message[];
          const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
          const { agentId, agentWs } = resolution;
          if (!agentWs) {
            return { messages: msgs, prependSystemContext: "", estimatedTokens: 0 };
          }
          await prepareWorkspaces(resolution);
          const state = getAgentState(agentId);
          state.lastAgentWs = agentWs;

          // ⚠️ OpenClaw は ingest() をメモリフラッシュ時にしか呼ばないため、
          // 毎ターン確実に呼ばれる assemble() 内でセグメンテーションを発火させる。
          // fire-and-forget で assemble のレスポンス速度に影響しないようにする。
          state.segmenter.processTurn(msgs, agentWs, agentId).catch(err => {
            console.log("[Episodic Memory] Segmenter error in assemble:", err);
          });

          const totalBudget = typeof ctx.tokenBudget === "number" && ctx.tokenBudget > 0
            ? ctx.tokenBudget
            : 0;
          const reserveTokens = cfg.reserveTokens ?? 2048;

          // --- Task 7D: Context Pressure Monitor ---
          // tokenBudget が正の値でない場合はホスト未初期化と判断しスキップ。
          if (totalBudget > 0) {
            const contextThreshold = Math.max(0, Math.min(1, cfg.contextThreshold ?? 0.85));
            const pressureThreshold = Math.floor(totalBudget * contextThreshold);
            const currentTokens = estimateTokens(
              msgs.map((m) => extractText(m.content)).join("\n")
            );
            if (
              typeof ctx.sessionFile === "string" &&
              ctx.sessionFile.length > 0 &&
              currentTokens > pressureThreshold &&
              !state.compactor.isCompacting
            ) {
              console.log(
                `[Episodic Memory] Context pressure detected: ${currentTokens} tokens > threshold ${pressureThreshold}. ` +
                `Triggering proactive compaction.`
              );
              state.compactor.compact({
                ...ctx,
                resolvedAgentWs: agentWs,
                force: false,
              }).then(result => {
                if (result.ok && result.compacted && result.result) {
                  activateAnchorInjection(state, result.result);
                }
                clearRecallCache(state);
              }).catch(err => {
                console.error("[Episodic Memory] Proactive compaction failed:", err);
              });
            }
          }
          const maxEpisodicTokens = Math.max(0, totalBudget - reserveTokens);
          const k = 5;
          const now = Date.now();
          const recentMessages = msgs.slice(-5);
          const queryParts = recentMessages
            .map(m => {
              const content = extractText(m.content).trim();
              return content ? `${m.role}: ${content}` : "";
            })
            .filter(part => part.length > 0);
          const fullQuery = queryParts.join("\n").trim();
          const queryHash = fullQuery ? createHash("sha1").update(fullQuery).digest("hex") : "";

          if (maxEpisodicTokens <= 0) {
            if (state.anchorInjection) {
              logAnchorInjectionOutcome({
                status: "skipped",
                source: state.anchorInjection.source,
                agentId,
                agentWs,
                anchorId: state.anchorInjection.anchorId,
                summaryId: state.anchorInjection.summaryId,
                estimatedTokens: 0,
                anchorInjectionWindow: state.anchorInjection.remainingEligibleAssembles,
                reason: "budget_truncated_to_zero",
              });
            }
            // budget_truncated_to_zero: reserve 後の budget が 0 以下。
            // This returns before anchor evaluation, so the eligible injection lifetime is not spent.
            logPrependSystemContextOutcome({
              status: "skipped",
              agentId,
              agentWs,
              queryHash,
              estimatedTokens: 0,
              injectedEpisodeCount: 0,
              truncatedEpisodeCount: 0,
              reason: "budget_truncated_to_zero",
            });
            return { messages: msgs, prependSystemContext: "", estimatedTokens: 0 };
          }

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
              if (estimatedAnchorTokens > maxEpisodicTokens) {
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

          const maxRecallTokens = Math.max(0, maxEpisodicTokens - anchorTokens);
          const fullKey = queryHash
            ? `${agentId}::${agentWs}::${maxRecallTokens}::${k}::${queryHash}`
            : "";

          let recallOutcome: RecallInjectionOutcome;
          const cache = state.recallCache;
          const isCacheHit = fullKey
            && fullKey === cache.lastRecallFullKey
            && (now - cache.lastRecallTime < RECALL_DEBOUNCE_MS)
            && cache.lastRecallResult;
          if (isCacheHit) {
            recallOutcome = cache.lastRecallResult!;
            console.log(`[Episodic Memory] recall debounce: cache hit for same query (${now - cache.lastRecallTime}ms since last recall)`);
          } else {
            recallOutcome = await retriever.retrieveRelevantContext(msgs, agentWs, k, maxRecallTokens);
            cache.lastRecallResult = recallOutcome;
            cache.lastRecallTime = now;
            cache.lastRecallFullKey = fullKey;
          }
          const estimatedTokens = estimateTokens(recallOutcome.text);
          const status: PrependSystemContextStatus =
            recallOutcome.reason === "injected"
              ? (recallOutcome.truncatedEpisodeCount > 0 ? "truncated" : "injected")
              : "skipped";
          logPrependSystemContextOutcome({
            status,
            agentId,
            agentWs,
            queryHash: recallOutcome.queryHash || queryHash,
            estimatedTokens,
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
          return {
            messages: msgs,
            prependSystemContext,
            estimatedTokens: estimateTokens(prependSystemContext),
          };
          },
          async compact(ctx: any) {
            const resolution = resolveAgentWorkspaces(ctx, openClawGlobalConfig);
            const { agentId, agentWs } = resolution;
            if (!agentWs) return { ok: false, compacted: false };
            await prepareWorkspaces(resolution);
            const state = getAgentState(agentId);
            state.lastAgentWs = agentWs;
            ctx.resolvedAgentWs = agentWs;
            logCompactionEntry({
              agentId,
              agentWs,
              force: ctx?.force === true,
              compactionTarget: typeof ctx?.compactionTarget === "string" ? ctx.compactionTarget : undefined,
              hasCustomInstructions:
                typeof ctx?.customInstructions === "string" && ctx.customInstructions.trim().length > 0,
            });
            clearRecallCache(state);
            const result = await state.compactor.compact(ctx);
            // The compaction payload is activated here, inside the plugin-owned compact path.
            // Host after_compaction remains notification-only and does not carry anchor/summary payloads.
            if (result.ok && result.compacted && result.result) {
              activateAnchorInjection(state, result.result);
            }
            clearRecallCache(state);
            return result;
          }
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
      
    } catch (err: any) {
      console.error("[Episodic Memory DEBUG] CRASH IN REGISTER:", err.stack || err);
      throw err;
    }
  }
};

export default episodicClawPlugin;
