import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { Type } from "@sinclair/typebox";
import { EpisodicCoreClient } from "./rpc-client";
import { buildRecallCalibration, loadConfig } from "./config";
import { EventSegmenter, Message, extractText } from "./segmenter";
import { EpisodicRetriever } from "./retriever";
import { Compactor } from "./compactor";
import { estimateTokens } from "./utils";

export interface OpenClawPluginApi {
  // フック登録 — openclaw types.ts の PluginHookName に準拠
  on(
    hookName: "gateway_start" | "gateway_stop" | "before_prompt_build" | "session_start" | "session_end" | "before_model_resolve" | "before_agent_start" | string,
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

const PluginConfigSchema = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({
      description: "Enable or disable the plugin (default true)."
    })),
    reserveTokens: Type.Optional(Type.Integer({
      description: "Max tokens reserved for injected episode memories in the system prompt (default 6144)."
    })),
    recentKeep: Type.Optional(Type.Integer({
      description: "Number of recent turns to retain during compaction (default 30)."
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
      description: "(Planned — Phase 6) Path to a shared episodes directory across multiple agents. Has no effect in current version."
    })),
    allowCrossAgentRecall: Type.Optional(Type.Boolean({
      description: "(Planned — Phase 6) Whether to include other agents' episodes in recall results. Has no effect in current version."
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
  segmenter: EventSegmenter;
  retriever: EpisodicRetriever;
  compactor: Compactor;
  sidecarStarted: boolean;
  resolvedAgentWs: string;
  lastRecallResult: string;
  lastRecallTime: number;
  lastRecallFullKey: string;
  lastSetMetaTime: number;
  cfg: ReturnType<typeof loadConfig>;
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
        const retriever = new EpisodicRetriever(rpcClient, cfg);
        const compactor = new Compactor(rpcClient, segmenter, cfg.recentKeep ?? 30);
        const recallCalibration = buildRecallCalibration(cfg);
        _singleton = {
          rpcClient,
          segmenter,
          retriever,
          compactor,
          sidecarStarted: false,
          resolvedAgentWs: "",
          lastRecallResult: "",
          lastRecallTime: 0,
          lastRecallFullKey: "",
          lastSetMetaTime: 0,
          cfg,
        };
        (global as any)[SINGLETON_KEY] = _singleton; // global に保存してプロセス全体で共有
        console.log("[Episodic Memory] Singleton created.");
      } else {
        console.log("[Episodic Memory] Singleton reused (BUG-1 guard active).");
      }

      const { rpcClient, segmenter, retriever, compactor, cfg } = _singleton;
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

      api.on("gateway_start", async (event?: any, _ctx?: any) => {
        if (_singleton!.sidecarStarted) {
          console.log("[Episodic Memory] Sidecar already started, skipping duplicate gateway_start");
          return;
        }
        _singleton!.sidecarStarted = true;
        console.log("[Episodic Memory] Starting Go sidecar...", event?.port ? `(gateway port: ${event.port})` : "");
        await rpcClient.start();

        // 正しい workspace 解決ロジックの実装
        const cfgAgents = openClawGlobalConfig?.agents;
        let defaultAgentId = "main";
        if (cfgAgents?.list && Array.isArray(cfgAgents.list) && cfgAgents.list.length > 0) {
          const defaults = cfgAgents.list.filter((a: any) => a.default);
          defaultAgentId = (defaults[0] ?? cfgAgents.list[0])?.id?.trim() || "main";
        }

        let wsPath = "";
        const targetAgent = cfgAgents?.list?.find((a: any) => a.id === defaultAgentId);
        if (targetAgent && typeof targetAgent.workspace === 'string' && targetAgent.workspace.trim() !== '') {
          wsPath = targetAgent.workspace.trim();
        } else if (cfgAgents?.defaults?.workspace && typeof cfgAgents.defaults.workspace === 'string' && cfgAgents.defaults.workspace.trim() !== '') {
          wsPath = cfgAgents.defaults.workspace.trim();
        } else {
          const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
          const wsDirName = defaultAgentId === "main" ? "workspace" : `workspace-${defaultAgentId}`;
          wsPath = path.join(homeDir, ".openclaw", wsDirName);
        }

        // チルダ展開と絶対パスへの解決 (OpenClaw の resolveUserPath と同等)
        if (wsPath.startsWith("~/") || wsPath.startsWith("~\\")) {
          const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
          wsPath = path.join(homeDir, wsPath.slice(2));
        } else if (wsPath === "~") {
          wsPath = process.env.HOME || process.env.USERPROFILE || os.homedir();
        }
        wsPath = path.resolve(wsPath);

        _singleton!.resolvedAgentWs = path.join(wsPath, "episodes");
        console.log(`[Episodic Memory] Resolved workspace dir: ${_singleton!.resolvedAgentWs}`);
        // クロスクロージャ/スレッド共有用にワークスペースパスをファイルに保存
        try { fs.writeFileSync(path.join(os.tmpdir(), "episodic-claw-workspace.path"), _singleton!.resolvedAgentWs, "utf8"); } catch {};

        // ディレクトリが存在しない場合は自動作成
        await fs.promises.mkdir(_singleton!.resolvedAgentWs, { recursive: true });

        Promise.race([
          rpcClient.startWatcher(_singleton!.resolvedAgentWs),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Watcher Start Timeout")), 5000))
        ]).catch(err => {
          console.error("[Episodic Memory] Failed to start watcher.", err);
        });
      });

      api.on("gateway_stop", async (event?: any, _ctx?: any) => {
        console.log("[Episodic Memory] Stopping plugin...", event?.reason ? `(reason: ${event.reason})` : "");
        await rpcClient.stop();
        _singleton!.sidecarStarted = false;
      });

      // Fix C: before_reset フック — セッション消去前（buffer がまだ有効）に flush を開始
      // openclaw は void 発火のため完了保証はないが、最も早いタイミングで RPC を発行できる
      api.on("before_reset", async (_event?: any, ctx?: any) => {
        if (!_singleton!.resolvedAgentWs) return;
        const agentId = extractAgentId(ctx);
        console.log("[Episodic Memory] before_reset: flushing segmenter buffer...");
        try {
          await segmenter.forceFlush(_singleton!.resolvedAgentWs, agentId);
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
            ownsCompaction: true,
          },
          async ingest(ctx: any) {
            const msgs = (ctx.messages || []) as Message[];
            const agentId = extractAgentId(ctx);
            // BUG-1修正: クロスクロージャ/スレッド対応 — ファイルからワークスペースパスを復元
            if (!_singleton!.resolvedAgentWs) {
              try {
                const wp = fs.readFileSync(path.join(os.tmpdir(), "episodic-claw-workspace.path"), "utf8").trim();
                if (wp) { _singleton!.resolvedAgentWs = wp; console.log(`[Episodic Memory] ingest: loaded workspace from file: ${wp}`); }
              } catch {}
            }
            try {
              const boundaryCrossed = await segmenter.processTurn(msgs, _singleton!.resolvedAgentWs, agentId);
              // [Fix D-3] setMeta rate-limit: フォールバック連発時の spam を抑制
              const nowMeta = Date.now();
              if (nowMeta - _singleton!.lastSetMetaTime >= SET_META_INTERVAL_MS) {
                await rpcClient.setMeta("last_activity", nowMeta.toString(), _singleton!.resolvedAgentWs);
                _singleton!.lastSetMetaTime = nowMeta;
              }
            } catch (err) {
              console.error("[Episodic Memory] Error processing ingest:", err);
            }
            return { ingested: true };
          },
          async assemble(ctx: any) {
            const msgs = (ctx.messages || []) as Message[];
            const agentId = extractAgentId(ctx);
            // BUG-1修正: クロスクロージャ/スレッド対応 — ファイルからワークスペースパスを復元
            if (!_singleton!.resolvedAgentWs) {
              try {
                const wp = fs.readFileSync(path.join(os.tmpdir(), "episodic-claw-workspace.path"), "utf8").trim();
                if (wp) { _singleton!.resolvedAgentWs = wp; console.log(`[Episodic Memory] assemble: loaded workspace from file: ${wp}`); }
              } catch {}
            }

            // ⚠️ OpenClaw は ingest() をメモリフラッシュ時にしか呼ばないため、
            // 毎ターン確実に呼ばれる assemble() 内でセグメンテーションを発火させる。
            // fire-and-forget で assemble のレスポンス速度に影響しないようにする。
            segmenter.processTurn(msgs, _singleton!.resolvedAgentWs, agentId).catch(err => {
              console.log("[Episodic Memory] Segmenter error in assemble:", err);
            });

            const totalBudget = ctx.tokenBudget || 8192;
            const reserveTokens = cfg.reserveTokens ?? 6144;
            const maxEpisodicTokens = Math.max(0, totalBudget - reserveTokens);

            // [Fix D-2] recall debounce: フォールバック連発時の多重 RPC を抑制
            // コンテンツキー（最後のユーザーメッセージ）+ 時間キーの二重条件でキャッシュ判定。
            // 同一クエリ → 時間に関わらず cache hit、異なるクエリ → 即失効。
            // BUG-1 修正: _singleton 経由で共有（二重 register() でもキャッシュが引き継がれる）
            const now = Date.now();
            const lastUserMsg = msgs.filter(m => m.role === "user").slice(-1)[0];
            const recallKey = lastUserMsg
              ? extractText(lastUserMsg.content).trim().slice(0, 200)
              : "";
            // agentId を含めてキー化することでマルチエージェント環境での recall 結果漏洩を防ぐ（R-3 対応）
            const fullKey = `${agentId}:${recallKey}`;
            let episodicContext: string;
            const isCacheHit = fullKey
              && fullKey === _singleton!.lastRecallFullKey
              && (now - _singleton!.lastRecallTime < RECALL_DEBOUNCE_MS)
              && _singleton!.lastRecallResult;
            if (isCacheHit) {
              episodicContext = _singleton!.lastRecallResult;
              console.log(`[Episodic Memory] recall debounce: cache hit for same query (${now - _singleton!.lastRecallTime}ms since last recall)`);
            } else {
              episodicContext = await retriever.retrieveRelevantContext(msgs, _singleton!.resolvedAgentWs, 5, maxEpisodicTokens);
              _singleton!.lastRecallResult = episodicContext;
              _singleton!.lastRecallTime = now;
              _singleton!.lastRecallFullKey = fullKey;
            }
            return {
              messages: msgs,
              prependSystemContext: episodicContext,
              estimatedTokens: estimateTokens(episodicContext),
            };
          },
          async compact(ctx: any) {
            ctx.resolvedAgentWs = _singleton!.resolvedAgentWs;
            return await compactor.compact(ctx);
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
          if (!_singleton!.resolvedAgentWs) {
            return { content: [{ type: "text", text: "My memory isn't up yet — the gateway hasn't started. Try again in a moment." }] };
          }
          const p = (params || {}) as Record<string, unknown>;
          const k = typeof p.k === "number" ? p.k : 3;
          const topics = Array.isArray(p.topics)
            ? p.topics.filter((item): item is string => typeof item === "string")
            : [];
          // For ep-recall (explicit facet search), default to strict filtering when not specified.
          const strictTopics = typeof (p as any).strictTopics === "boolean" ? ((p as any).strictTopics as boolean) : true;
          try {
            const results = await rpcClient.recall(
              p.query as string || "",
              k,
              _singleton!.resolvedAgentWs,
              topics,
              strictTopics,
              recallCalibration
            );
            if (!results || results.length === 0) {
              return { content: [{ type: "text", text: "Nothing came back. I don't have any memories matching that." }] };
            }
            return {
              content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
              details: results
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
          if (!_singleton!.resolvedAgentWs) {
            return { content: [{ type: "text", text: "My memory isn't up yet — the gateway hasn't started. Try again in a moment." }] };
          }
          const agentId = extractAgentId(ctx);
          try {
            const p = (params || {}) as Record<string, unknown>;
            const raw: string = (p.content as string) || (p.summary as string) || "";

            if (!raw || typeof raw !== "string" || !raw.trim()) {
              return { content: [{ type: "text", text: "Nothing to save — the content was empty. Write something and I'll hold onto it." }] };
            }

            const runes = Array.from(raw);
            const content = runes.length > 3600 ? runes.slice(0, 3600).join("") + "\n...(truncated)" : raw;
            const topicSource = Array.isArray(p.topics) && p.topics.length > 0 ? p.topics : p.tags;
            const topics = normalizeTopics(topicSource);
            if (Array.isArray(p.tags) && p.tags.length > 0 && (!Array.isArray(p.topics) || p.topics.length === 0)) {
              console.warn("[Episodic Memory] ep-save: 'tags' is deprecated; use 'topics' instead.");
            }
            const slugRes = await rpcClient.generateEpisodeSlug({
              summary: content,
              agentWs: _singleton!.resolvedAgentWs,
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
          if (!_singleton!.resolvedAgentWs) {
            return { content: [{ type: "text", text: "My memory isn't up yet — the gateway hasn't started. Try again in a moment." }] };
          }
          try {
            const p = (params || {}) as Record<string, unknown>;
            const expanded = await rpcClient.expand(p.slug as string || "", _singleton!.resolvedAgentWs);
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
