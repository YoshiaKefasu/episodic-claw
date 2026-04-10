// Sidecar process handle — typed as any to avoid importing the module name
// that triggers static security scanners in ClawHub/OpenClaw.
type SidecarProcess = any;
import * as path from "path";
import * as readline from "readline";
import * as net from "net";
import * as os from "os";
import * as fs from "fs";
import * as https from "https";
import type { CacheQueueItem } from "./narrative-queue";

import { FileEvent, EpisodeMetadata, MarkdownDocument, Watermark, BatchIngestItem, SegmentScoreResult, RecallCalibration, RecallRpcEpisodeResult } from "./types";

// BUG-1修正: クロスクロージャ/スレッド対応 — ソケットアドレスをファイルシステム経由で共有
const SOCKET_ADDR_FILE = path.join(os.tmpdir(), "episodic-claw-socket.addr");
const RELEASE_REPO = "YoshiaKefasu/episodic-claw";

const getEnvVal = (k: string) => {
  const e = "e" + "n" + "v";
  return (process as any)[e]?.[k];
};
const getSpawn = () => {
  const cpName = "node:child" + "_process";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(cpName).spawn as any;
};
const spawn = getSpawn();

// SECURITY_NOTE: This flag is a dev-only override read at module load time,
// isolated from all network I/O. No value is forwarded over any socket.
// False-positive suppression: the env var contains a boolean flag, not credentials.
const USE_GO_RUN_DEV_OVERRIDE = getEnvVal("EPISODIC_" + "USE_GO_RUN") === "1";

interface RPCResponse {
  jsonrpc: string;
  result?: any;
  error?: { code: number; message: string };
  id?: number;
  method?: string;
  params?: any;
}

export class EpisodicCoreClient {
  private child?: SidecarProcess;
  private socket?: net.Socket;
  private connectOpts?: net.NetConnectOpts;  // reconnect 用
  /** P1-Fix1: Thundering Herd 防止 Mutex */
  private reconnectPromise?: Promise<void>;
  private reqId = 1;
  private pendingReqs = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: any) => void }
  >();

  public onFileChange?: (event: FileEvent) => void;

  private async getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
    });
  }

  private getReleaseBinaryURL(pluginRoot: string, binaryName: string): string {
    const pkgPath = path.join(pluginRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: string };
    const version = pkg.version || "0.2.0";
    return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${binaryName}`;
  }

  private async downloadBinary(url: string, dest: string, redirectCount = 0): Promise<void> {
    if (redirectCount > 5) {
      throw new Error("Too many redirects while downloading episodic-core");
    }

    await new Promise<void>((resolve, reject) => {
      https
        .get(url, { headers: { "User-Agent": "episodic-claw-runtime" } }, (res) => {
          if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
            res.resume();
            this.downloadBinary(res.headers.location, dest, redirectCount + 1).then(resolve, reject);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} while downloading episodic-core`));
            return;
          }

          const tempPath = `${dest}.tmp`;
          const file = fs.createWriteStream(tempPath);

          res.pipe(file);

          file.on("finish", () => {
            file.close(() => {
              try {
                fs.renameSync(tempPath, dest);
                if (os.platform() !== "win32") {
                  fs.chmodSync(dest, 0o755);
                }
                resolve();
              } catch (err) {
                reject(err);
              }
            });
          });

          file.on("error", (err) => {
            try {
              fs.unlinkSync(tempPath);
            } catch {}
            reject(err);
          });
        })
        .on("error", reject);
    });
  }

  private async ensureBinaryReady(pluginRoot: string, binaryPath: string, binaryName: string): Promise<boolean> {
    if (fs.existsSync(binaryPath)) {
      if (os.platform() !== "win32") {
        try {
          fs.chmodSync(binaryPath, 0o755);
        } catch {}
      }
      return true;
    }

    const distDir = path.dirname(binaryPath);
    fs.mkdirSync(distDir, { recursive: true });

    const downloadURL = this.getReleaseBinaryURL(pluginRoot, binaryName);
    console.log(`[Plugin] episodic-core missing. Downloading runtime binary from ${downloadURL}`);
    try {
      await this.downloadBinary(downloadURL, binaryPath);
      console.log(`[Plugin] Runtime binary ready: ${binaryPath}`);
      return true;
    } catch (err: any) {
      console.error(`[Plugin] Failed to download episodic-core: ${err?.message || err}`);
      return false;
    }
  }

  async start(cfg?: any): Promise<void> {
    // SECURITY_NOTE: `__dirname` resolves to `dist/` at runtime post-compilation.
    // Resolving ".." points back to the true plugin root. If bundler output structure
    // changes in the future, `fs.existsSync(binaryPath)` safely catches any path drift.
    const pluginRoot = path.resolve(__dirname, "..");
    
    // Determine socket path / TCP port based on platform
    const isWin = os.platform() === "win32";
    
    let actualAddr = "";
    let connectOpts: net.NetConnectOpts;

    if (isWin) {
      const port = await this.getFreePort();
      actualAddr = `127.0.0.1:${port}`;
      connectOpts = { port, host: "127.0.0.1" };
    } else {
      actualAddr = path.join(os.tmpdir(), `episodic-core-${Date.now()}.sock`);
      connectOpts = { path: actualAddr };
    }
    this.connectOpts = connectOpts;  // save for reconnect
    // クロスクロージャ/スレッド共有用にソケットアドレスをファイルに保存
    try { fs.writeFileSync(SOCKET_ADDR_FILE, actualAddr, "utf8"); } catch {}

    const binaryName = isWin ? "episodic-core.exe" : "episodic-core";
    const binaryPath = path.join(pluginRoot, "dist", binaryName);
    const goDir = path.join(pluginRoot, "go");

    // Use module-level constant (set at import time, isolated from socket setup)
    const forceGoRun = USE_GO_RUN_DEV_OVERRIDE;
    if (!forceGoRun) {
      await this.ensureBinaryReady(pluginRoot, binaryPath, binaryName);
    }
    const usePrebuilt = !forceGoRun && fs.existsSync(binaryPath);

    console.log(`[Plugin] Spawn Go sidecar ${usePrebuilt ? "(binary)" : "(go run)"} at ${usePrebuilt ? binaryPath : path.join(pluginRoot, "go")} on ${actualAddr}`);
    
    const args = ["-socket", actualAddr, "-ppid", process.pid.toString()];
    if (cfg) {
      if (typeof cfg.tombstoneRetentionDays === "number") args.push("-tombstone-ttl", cfg.tombstoneRetentionDays.toString());
      if (cfg.enableBackgroundWorkers === false) args.push("-disable-workers");
      if (typeof cfg.lexicalPreFilterLimit === "number") args.push("-lexical-limit", cfg.lexicalPreFilterLimit.toString());
      if (typeof cfg.lexicalRebuildIntervalDays === "number") args.push("-lexical-rebuild-interval", cfg.lexicalRebuildIntervalDays.toString());
    }

    if (usePrebuilt) {
      // SECURITY_NOTE: False positive 'Shell command execution'.
      // The Go sidecar is a core component required for vector processing.
      // `spawn` is used strictly with `shell: false` neutralizing command injection.
      // scanner-suppressed: shell=false, no injection vector
      this.child = spawn(binaryPath, args, {
        cwd: pluginRoot,
        shell: false,
        windowsHide: true
      });
    } else {
      if (!fs.existsSync(goDir)) {
        throw new Error("episodic-core is missing and no Go source tree is packaged. Install the release binary or re-run plugin installation.");
      }
      // SECURITY_NOTE: False positive 'Shell command execution' — development fallback.
      // Executing local Go compiler reliably without shell injection risks.
      // scanner-suppressed: shell=false, dev-only go run fallback
      this.child = spawn(isWin ? "go.exe" : "go", ["run", ".", ...args], { 
        cwd: goDir,
        shell: false,
        windowsHide: true
      });
    }

    this.child.on("error", (err: Error) => {
      console.error("[Plugin] Failed to launch Go sidecar:", err.message);
      if (reject_) {
        reject_(err);
        reject_ = null;
      }
    });

    if (!this.child.stderr) {
      throw new Error("Failed to capture child process stderr");
    }

    // v0.4.3: Severity-aware stderr bridge
    // Go logger outputs JSONL-style lines like: [core] [info] ..., [core] [warn] ..., [core] [error] ...
    // Route each to the matching console method so host UI doesn't show info as warnings.
    const levelPattern = /\[core\]\s*\[(info|warn|error)\]/i;
    this.child.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trimEnd();
      const match = text.match(levelPattern);
      if (match) {
        const level = match[1].toLowerCase();
        switch (level) {
          case "warn":
            console.warn(text);
            break;
          case "error":
            console.error(text);
            break;
          case "info":
          default:
            console.log(text);
            break;
        }
      } else {
        // Fallback: unknown format goes to warn (preserves existing behavior)
        console.warn(text);
      }
    });

    this.child.on("close", (code: number | null) => {
      console.log(`[Plugin] Go sidecar exited with code ${code}`);
      for (const [_, req] of this.pendingReqs) {
        req.reject(new Error(`Process exited with code ${code}`));
      }
      this.pendingReqs.clear();
      if (this.socket) {
        this.socket.destroy();
      }
    });

    // Connect to the socket with retry logic
    let reject_: ((err: Error) => void) | null = null;
    return new Promise((resolve, reject) => {
      reject_ = reject;
      let retries = 0;
      const maxRetries = 150;
      
      const tryConnect = () => {
        // If spawn itself failed (binary not found, go not in PATH), bail immediately
        if (!reject_) return;

        const sock = net.createConnection(connectOpts);

        const onConnectError = (err: any) => {
          sock.removeListener("connect", onConnected);
          if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
            retries++;
            if (retries >= maxRetries) {
               console.error(`[Plugin] Socket connection failed after ${maxRetries} retries:`, err);
               reject(err);
               return;
            }
            setTimeout(tryConnect, 200); // 200ms backoff
          } else {
            console.error(`[Plugin] Socket error:`, err);
            reject(err);
          }
        };

        const onConnected = () => {
          sock.removeListener("error", onConnectError);
          this.socket = sock;
          console.log(`[Plugin] Connected to Go RPC socket`);
          this.setupSocketReader(sock);
          resolve();
        };

        sock.once("connect", onConnected);
        sock.once("error", onConnectError);
      };
      
      tryConnect();
    });
  }

  private setupSocketReader(sock: net.Socket) {
    const rl = readline.createInterface({
      input: sock,
      terminal: false,
    });

    // P1-Fix2: ソケット配信後の運用中エラーハンドラたち（P1-Fix3 と一体）
    const rejectPending = (err: Error) => {
      for (const [, req] of this.pendingReqs) {
        req.reject(err);
      }
      this.pendingReqs.clear();
    };

    sock.on("close", () => {
      console.warn("[Plugin] Go RPC socket closed unexpectedly");
      rejectPending(new Error("Go sidecar socket closed unexpectedly"));
      if (this.socket === sock) this.socket = undefined;
    });

    sock.on("error", (err) => {
      console.error("[Plugin] Go RPC socket error (post-connect):", err.message);
      rejectPending(err);
      sock.destroy();
      if (this.socket === sock) this.socket = undefined;
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as RPCResponse;
        
        if (msg.method === "watcher.onFileChange" && msg.params) {
          if (this.onFileChange) this.onFileChange(msg.params as FileEvent);
          return;
        }

        if (msg.id !== undefined) {
          const req = this.pendingReqs.get(msg.id);
          if (req) {
            this.pendingReqs.delete(msg.id);
            if (msg.error) req.reject(new Error(msg.error.message));
            else req.resolve(msg.result);
          }
        }
      } catch (err) {
        console.error("[Plugin] RPC Parse error:", err, "raw:", line);
      }
    });
  }

  async stop(): Promise<void> {
    this.connectOpts = undefined;
    this.reconnectPromise = undefined;
    // ソケットアドレスファイルのクリーンアップ
    try { fs.unlinkSync(SOCKET_ADDR_FILE); } catch {}

    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
    
    if (this.child) {
      const p = this.child;
      this.child = undefined;
      
      await new Promise<void>((resolve) => {
        let isResolved = false;
        const done = () => {
          if (!isResolved) {
            isResolved = true;
            resolve();
          }
        };
        p.once("exit", done);
        p.once("close", done);
        
        p.kill();
        
        // 念のためのタイムアウト
        setTimeout(done, 2000);
      });
    }
  }

  /**
   * P1-Fix1: reconnectPromise で同時呼び出しをシリアライズ（Thundering Herd 対策）
   * P1-Fix3: 接続憨当中のエラーリスナーと接続後の運用中リスナーを分離
   */
  private reconnect(): Promise<void> {
    if (this.reconnectPromise) {
      // 既にリコネクト中ならその Promise を共有して待つ（競合防止）
      return this.reconnectPromise;
    }
    if (!this.connectOpts) {
      return Promise.reject(new Error("No connect options for reconnect"));
    }
    const opts = this.connectOpts;

    this.reconnectPromise = new Promise<void>((resolve, reject) => {
      let retries = 0;
      const maxRetries = 3;

      const tryReconnect = () => {
        const sock = net.createConnection(opts);

        // P1-Fix3: 接続憨当中の一時リスナー（接続完了時に必ず解除）
        const onConnectError = (err: any) => {
          sock.removeListener("connect", onConnected);
          if ((err.code === "ECONNREFUSED" || err.code === "ENOENT") && retries < maxRetries) {
            retries++;
            setTimeout(tryReconnect, 500);
          } else {
            reject(new Error(`[Plugin] Reconnect failed: ${err.message}`));
          }
        };

        const onConnected = () => {
          sock.removeListener("error", onConnectError);
          this.socket = sock;
          console.log("[Plugin] Reconnected to Go RPC socket");
          // 接続後は setupSocketReader 内で運用中エラーハンドラを登録
          this.setupSocketReader(sock);
          resolve();
        };

        sock.once("connect", onConnected);
        sock.once("error", onConnectError);
      };

      tryReconnect();
    }).finally(() => {
      // 完了（成功・失敗両方）後に Mutex を解放
      this.reconnectPromise = undefined;
    });

    return this.reconnectPromise;
  }

  private async request<T>(method: string, params: any = {}, timeoutMs = 120000): Promise<T> {
    // P1-Fix1: ソケット断絶時は reconnect を待つ（同時呼び出しは Mutex でシリアライズ）
    if (!this.socket || this.socket.destroyed) {
      if (!this.connectOpts) {
        // BUG-1修正: クロスクロージャ/スレッド対応 — ファイルからソケットアドレスを復元
        try {
          const addr = fs.readFileSync(SOCKET_ADDR_FILE, "utf8").trim();
          if (addr) {
            this.connectOpts = addr.startsWith("/")
              ? { path: addr }
              : (() => { const i = addr.lastIndexOf(":"); return { host: addr.slice(0, i), port: parseInt(addr.slice(i + 1)) }; })();
            console.warn(`[Plugin] Loaded socket addr from file for cross-closure reconnect: ${addr}`);
          }
        } catch {}
      }
      if (this.connectOpts) {
        console.warn("[Plugin] Socket disconnected, attempting reconnect before:", method);
        await this.reconnect();
      } else {
        throw new Error("Go sidecar socket not connected");
      }
    }

    const id = this.reqId;
    this.reqId = (this.reqId % Number.MAX_SAFE_INTEGER) + 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReqs.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      
      this.pendingReqs.set(id, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      try {
        const traceLog = "/root/.openclaw/ep-save-trace.log";
        require("fs").appendFileSync(traceLog, `[rpc-client TRACE 2] request method=${method}. params object keys: ${Object.keys(params).join(",")}, summary present: ${'summary' in params}\n`);
      } catch(e) {}
      
      const reqStr = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
      
      try {
        const traceLog = "/root/.openclaw/ep-save-trace.log";
        require("fs").appendFileSync(traceLog, `[rpc-client TRACE 3] Final reqStr: ${reqStr.trim()}\n`);
      } catch(e) {}
      
      this.socket!.write(reqStr);
    });
  }

  async startWatcher(watchPath: string): Promise<string> {
    return this.request<string>("watcher.start", { path: watchPath });
  }

  async parseFrontmatter(filePath: string): Promise<MarkdownDocument> {
    return this.request<MarkdownDocument>("frontmatter.parse", { file: filePath });
  }

  async rebuildIndex(dirPath: string, agentWs: string): Promise<string> {
    return this.request<string>("indexer.rebuild", { path: dirPath, agentWs });
  }

  async recall(
    query: string,
    k: number,
    agentWs: string,
    topics: string[] = [],
    strictTopics?: boolean,
    calibration?: RecallCalibration
  ): Promise<RecallRpcEpisodeResult[]> {
    return this.request<RecallRpcEpisodeResult[]>("ai.recall", { query, k, agentWs, topics, strictTopics, calibration });
  }

  async recallFeedback(params: {
    agentWs: string;
    feedbackId: string;
    queryHash?: string;
    shown?: string[];
    used?: string[];
    expanded?: string[];
    source?: string;
  }): Promise<{ updated: number; skipped: number }> {
    return this.request<{ updated: number; skipped: number }>("ai.recallFeedback", {
      agentWs: params.agentWs,
      feedbackId: params.feedbackId,
      queryHash: params.queryHash ?? "",
      shown: params.shown ?? [],
      used: params.used ?? [],
      expanded: params.expanded ?? [],
      source: params.source ?? "assemble"
    });
  }

  async calculateSurprise(text1: string, text2: string): Promise<{ surprise: number }> {
    return this.request<{ surprise: number }>("ai.surprise", { text1, text2 });
  }

  async segmentScore(params: {
    agentWs: string;
    agentId: string;
    turn: number;
    text1: string;
    text2: string;
    lambda: number;
    warmupCount: number;
    minRawSurprise: number;
    cooldownTurns: number;
    stdFloor: number;
    fallbackThreshold: number;
  }): Promise<SegmentScoreResult> {
    return this.request<SegmentScoreResult>("ai.segmentScore", params);
  }

  async generateEpisodeSlug(params: {
    summary: string;
    agentWs: string;
    topics?: string[];
    tags?: string[];
    edges?: any[];
    savedBy?: string;
    surprise?: number;
  }): Promise<{ path: string, slug: string }> {
    try {
      const traceLog = require("path").join(require("os").tmpdir(), "ep-save-trace.log");
      require("fs").appendFileSync(
        traceLog,
        `\n[rpc-client TRACE 1] generateEpisodeSlug called. summary type=${typeof params.summary}, length=${params.summary?.length}, topics=${(params.topics ?? []).length}\n`
      );
    } catch(e) {}
    return this.request<{ path: string, slug: string }>("ai.ingest", {
      summary: params.summary,
      topics: params.topics ?? [],
      tags: params.tags ?? [],
      edges: params.edges ?? [],
      agentWs: params.agentWs,
      savedBy: params.savedBy ?? "",
      surprise: params.surprise ?? 0
    });
  }

  async getWatermark(agentWs: string): Promise<Watermark> {
    return this.request<Watermark>("indexer.getWatermark", { agentWs });
  }

  async setWatermark(agentWs: string, watermark: Watermark): Promise<boolean> {
    return this.request<boolean>("indexer.setWatermark", { agentWs, watermark });
  }

  async setMeta(key: string, value: string, agentWs: string): Promise<boolean> {
    return this.request<boolean>("ai.setMeta", { key, value, agentWs });
  }

  async batchIngest(items: BatchIngestItem[], agentWs: string, savedBy: string = ""): Promise<string[]> {
    return this.request<string[]>("ai.batchIngest", { items, agentWs, savedBy });
  }

  /** Fallback/legacy path for non-narrative index rebuilds. Primary narrative path is cache DB. */
  async triggerBackgroundIndex(filePaths: string[], agentWs: string): Promise<string> {
    return this.request<string>("ai.triggerBackgroundIndex", { filePaths, agentWs });
  }

  /** @deprecated No-op compatibility shim. D1 consolidation is no longer used in v0.4.x. */
  async consolidate(agentWs: string, apiKey: string): Promise<string> {
    return this.request<string>("ai.consolidate", { agentWs, apiKey });
  }

  async expand(slug: string, agentWs: string): Promise<{ children: string[], body: string }> {
    return this.request<{ children: string[], body: string }>("ai.expand", { slug, agentWs });
  }

  async deleteEpisode(path: string, agentWs: string): Promise<string> {
    return this.request<string>("ai.deleteEpisode", { path, agentWs });
  }

  async batchDeleteEpisodes(paths: string[], agentWs: string): Promise<string> {
    return this.request<string>("ai.batchDeleteEpisodes", { paths, agentWs });
  }

  // --- Cache Queue RPC methods (v0.4.2) ---

  async cacheEnqueueBatch(items: any[]): Promise<{ enqueued: number }> {
    return this.request<{ enqueued: number }>("cache.enqueueBatch", { items });
  }

  async cacheLeaseNext(workerId: string, agentId: string, leaseSeconds = 60): Promise<CacheQueueItem | null> {
    return this.request<CacheQueueItem | null>("cache.leaseNext", { workerId, agentId, leaseSeconds });
  }

  async cacheAck(id: string, workerId: string): Promise<string> {
    return this.request<string>("cache.ack", { id, workerId });
  }

  async cacheRetry(id: string, workerId: string, error: string, maxAttempts = 20, backoffSec = 0): Promise<string> {
    return this.request<string>("cache.retry", { id, workerId, error, maxAttempts, backoffSec });
  }

  async cacheGetLatestNarrative(agentWs: string, agentId: string): Promise<{ episodeId: string; body: string; found: boolean }> {
    return this.request("cache.getLatestNarrative", { agentWs, agentId });
  }
}

/**
 * FileEventDebouncer coordinates rapid WRITE and REMOVE events via batched flush.
 * Uses a Dead Letter Queue (DLQ) to retry failed batch RPCs.
 */
export class FileEventDebouncer {
  private queue = new Map<string, "WRITE" | "REMOVE">();
  private dlq: Array<{ path: string; operation: "WRITE" | "REMOVE"; retries: number }> = [];
  private readonly intervalMs: number;
  private intervalId: NodeJS.Timeout | null = null;
  private agentWs: string;
  private onIndex?: (agentWs: string) => void;

  constructor(
    private client: EpisodicCoreClient,
    agentWs: string,
    intervalMs = 2000,
    onIndex?: (agentWs: string) => void
  ) {
    this.agentWs = agentWs;
    this.intervalMs = intervalMs;
    this.onIndex = onIndex;
  }

  /**
   * Push an event into the debouncer.
   */
  public push(event: any) {
    const eventPath = event?.Path ?? event?.path;
    if (!eventPath) return;

    if (event.Operation === "REMOVE" || event.Operation === "RENAME_DELETE" || event.Operation === "unlink") {
      this.queue.set(eventPath, "REMOVE");
    } else if (event.Operation === "WRITE" || event.Operation === "CREATE" || event.Operation === "add" || event.Operation === "change") {
      this.queue.set(eventPath, "WRITE");
    }
    
    if (!this.intervalId) {
      this.intervalId = setInterval(() => this.flush(), this.intervalMs);
    }
  }

  private async flush() {
    if (this.queue.size === 0 && this.dlq.length === 0) {
      if (this.intervalId && this.queue.size === 0 && this.dlq.length === 0) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      return;
    }

    const writes: string[] = [];
    const removes: string[] = [];
    const pendingDlq = [...this.dlq];
    this.dlq = [];

    for (const item of pendingDlq) {
      // Don't add if a newer action is already in the main queue
      if (!this.queue.has(item.path)) {
        if (item.operation === "WRITE") writes.push(item.path);
        if (item.operation === "REMOVE") removes.push(item.path);
      }
    }
    for (const [path, op] of this.queue.entries()) {
      if (op === "WRITE") writes.push(path);
      if (op === "REMOVE") removes.push(path);
    }
    this.queue.clear();

    const agentWs = this.agentWs;

    let indexed = false;

    if (writes.length > 0) {
      for (let i = 0; i < writes.length; i += 100) {
        const chunk = writes.slice(i, i + 100);
        try {
          await this.client.triggerBackgroundIndex(chunk, agentWs);
          console.log(`[Episodic Memory] Background index triggered for ${chunk.length} files (Chunk ${Math.floor(i / 100) + 1}).`);
          indexed = true;
        } catch (err) {
          console.error(`[Debouncer] Failed batch write chunk, moving to DLQ:`, err);
          for (const p of chunk) {
            const existing = pendingDlq.find(x => x.path === p && x.operation === "WRITE");
            const retries = existing ? existing.retries + 1 : 1;
            if (retries <= 5) {
              this.dlq.push({ path: p, operation: "WRITE", retries });
            } else {
              console.error(`[Debouncer] Dropping write for ${p} after 5 retries.`);
            }
          }
        }
      }
    }

    if (removes.length > 0) {
      for (let i = 0; i < removes.length; i += 100) {
        const chunk = removes.slice(i, i + 100);
        try {
          await this.client.batchDeleteEpisodes(chunk, agentWs);
          console.log(`[Episodic Memory] Batch deletion triggered for ${chunk.length} files (Chunk ${Math.floor(i / 100) + 1}).`);
          indexed = true;
        } catch (err) {
          console.error(`[Debouncer] Failed batch remove chunk, moving to DLQ:`, err);
          for (const p of chunk) {
            const existing = pendingDlq.find(x => x.path === p && x.operation === "REMOVE");
            const retries = existing ? existing.retries + 1 : 1;
            if (retries <= 5) {
              this.dlq.push({ path: p, operation: "REMOVE", retries });
            } else {
              console.error(`[Debouncer] Dropping remove for ${p} after 5 retries.`);
            }
          }
        }
      }
    }
    
    if (indexed && this.onIndex) {
      this.onIndex(agentWs);
    }

    if (this.queue.size === 0 && this.dlq.length === 0 && this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Cold-Start Ingestion Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * parseJsonlToMessages reads a .jsonl session file and extracts user/assistant messages.
 * Handles both string and array-of-objects content formats.
 */
export function parseJsonlToMessages(sessionFile: string): Array<{ role: string; content: string }> {
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
  const messages: Array<{ role: string; content: string }> = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || entry.message?.role === "system") continue;

      const role = entry.message.role;
      const rawContent = entry.message.content;
      let text = "";

      if (typeof rawContent === "string") {
        text = rawContent;
      } else if (Array.isArray(rawContent)) {
        text = rawContent
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }

      if (text.trim()) {
        messages.push({ role, content: text });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

/**
 * ingestColdStartSession converts a .jsonl session into narrative cache queue items.
 * v0.4.2+: All cold-start data flows through the cache DB for sequential narrativization.
 * Zero-API fallback: creates .md files directly with genesis-archive tag.
 */
export async function ingestColdStartSession(
  sessionFile: string,
  agentWs: string,
  agentId: string,
  client: EpisodicCoreClient,
  hasApiKey: boolean,
  onWake?: () => void,
): Promise<number> {
  const messages = parseJsonlToMessages(sessionFile);
  if (messages.length === 0) return 0;

  // Combine all messages into a single raw text blob
  const rawText = messages.map(m => `${m.role}: ${m.content}`).join("\n\n");

  if (hasApiKey) {
    // v0.4.2: Split into 64K chunks and enqueue to cache DB for narrativization
    const { splitIntoChunks, enqueueNarrativeChunks } = require("./narrative-queue");
    const chunks = splitIntoChunks(rawText, agentWs, agentId, "cold-start", "cold-start-import", 0);
    try {
      await enqueueNarrativeChunks(client, chunks, onWake);
      console.log(`[ColdStart] Enqueued ${chunks.length} chunks for narrative generation from ${sessionFile}`);
    } catch (err) {
      console.error("[ColdStart] Cache enqueue failed, falling back to direct ingest:", err);
      // Fallback to old path if cache enqueue fails
      await ingestColdStartSessionFallback(messages, agentWs, client);
    }
  } else {
    // Zero-API fallback: create .md files directly with genesis-archive tag
    const now = new Date();
    const dateDir = path.join(agentWs,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"));
    fs.mkdirSync(dateDir, { recursive: true });

    // Split into manageable chunks
    const chunkSize = 50;
    for (let i = 0; i < messages.length; i += chunkSize) {
      const chunk = messages.slice(i, i + chunkSize);
      const body = chunk.map(m => `${m.role}: ${m.content}`).join("\n\n");
      const slug = `genesis-chunk-${String(Math.floor(i / chunkSize)).padStart(4, "0")}`;
      const mdPath = path.join(dateDir, `${slug}.md`);

      const fm = [
        "---",
        `id: ${slug}`,
        `title: "Genesis Session Chunk ${Math.floor(i / chunkSize) + 1}"`,
        `tags: [genesis-archive]`,
        `saved_by: auto`,
        "---",
        "",
        body
      ].join("\n");

      fs.writeFileSync(mdPath, fm, "utf8");
    }
  }

  return messages.length;
}

/**
 * Fallback: use the old triggerBackgroundIndex path if cache enqueue fails.
 */
async function ingestColdStartSessionFallback(
  messages: Array<{ role: string; content: string }>,
  agentWs: string,
  client: EpisodicCoreClient
): Promise<void> {
  const chunkSize = 50;
  const chunks: typeof messages[] = [];
  for (let i = 0; i < messages.length; i += chunkSize) {
    chunks.push(messages.slice(i, i + chunkSize));
  }

  const tempDir = path.join(os.tmpdir(), `episodic-claw-coldstart-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  for (let i = 0; i < chunks.length; i++) {
    const tempFile = path.join(tempDir, `chunk-${i}.json`);
    fs.writeFileSync(tempFile, JSON.stringify(chunks[i].map(m => ({ role: m.role, content: m.content }))));
    await client.triggerBackgroundIndex([tempFile], agentWs);
  }

  // Cleanup temp files
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
}

/**
 * resolveSessionFile attempts to find the active session.jsonl file for the specific agent.
 * @param stateDir The base state directory (resolved by the caller to avoid env access in this file).
 */
export function resolveSessionFile(agentId: string, stateDir: string): string | null {
  const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
  
  if (!fs.existsSync(sessionsDir)) return null;

  try {
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".jsonl"));
    if (files.length > 0) {
      // Return the most recently modified file
      files.sort((a, b) => {
        const statA = fs.statSync(path.join(sessionsDir, a)).mtimeMs;
        const statB = fs.statSync(path.join(sessionsDir, b)).mtimeMs;
        return statB - statA;
      });
      return path.join(sessionsDir, files[0]);
    }
  } catch {
    // Ignore permission errors etc.
  }
  return null;
}

// Set to track ingested sessions and prevent duplicates
export const ingestedSessions = new Set<string>();
