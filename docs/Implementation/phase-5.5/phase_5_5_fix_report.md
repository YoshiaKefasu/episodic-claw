# Phase 5.5 ブロッカー修正レポート

> **作成日**: 2026-03-20 22:55 (ICT, UTC+7)  
> **対象**: `src/rpc-client.ts` / `src/index.ts`  
> **前提**: Phase 5.5 E2E テストにて「Go sidecar socket not connected」エラーで ingest/assemble が全滅

---

## 根本原因（2 件）

### 🔴 Bug 1 — `socket` が再利用できない設計（rpc-client.ts）

**スタックトレース:**
```
Error: Go sidecar socket not connected
    at EpisodicCoreClient.request (.../rpc-client.ts:183:13)
```

**L183 のガード:**
```typescript
private async request<T>(...) {
  if (!this.socket || this.socket.destroyed) {
    throw new Error("Go sidecar socket not connected");
  }
```

**実際の問題 — `connectOpts` がフィールドに保存されていない:**

`start()` で `connectOpts` を生成してソケット接続するが、この変数は関数ローカルで、
フィールドに保存されていない。

```typescript
// start() 内だけにある（フィールドではない）
let connectOpts: net.NetConnectOpts;
```

一方 `this.socket` は `tryConnect()` 内で `net.createConnection(connectOpts, ...)` で作られるが、
`start()` の `Promise` スコープで `socket.on("error")` が受け取った後、**ソケットが壊れた場合でも
再接続ができない** — `connectOpts` はもうスコープ外だからだ。

**具体的な発生シナリオ（今回）:**

1. `gateway_start` フック → `rpcClient.start()` 成功 → `[Plugin] Connected to Go RPC socket` ✅
2. `watcher.start` RPC 送信 → Go サイドカー受け取る → 成功 ✅  
3. **その後、エージェント処理（非同期）が走る前に `readline` が何らかの理由でソケットを `destroyed` 状態にする**
4. `ingest` / `assemble` から `request()` が呼ばれると L183 のガードで即 throw → ❌

**決定的証拠 — `setupSocketReader()` が `readline` を使っている:**

```typescript
private setupSocketReader() {
  const rl = readline.createInterface({
    input: this.socket!,
    terminal: false,
  });
```

`readline.createInterface` が `input` ストリーム（`this.socket`）を完全に「consume」し、
unix socket が EOF（Go サイドカーが初期レスポンスを返した後に書き込みを止めると発生する）や
Half-Close を送ると、readline 側が `close` イベントを処理して **socket が暗黙的に `destroyed` 状態になる**。

---

### 🟡 Bug 2 — `resolvedAgentWs` フォールバックパスが WSL で不正（index.ts L57）

```typescript
} else {
  resolvedAgentWs = path.resolve(process.cwd(), "episodes");
}
```

`api.runtime?.extensionAPI?.resolveAgentWorkspaceDir` が未定義の場合（実際に `undefined` だった）、
`process.cwd()` ＝ **Gateway 起動ディレクトリ**（おそらく `/root` 等）に `episodes` をつなぐ。

結果: `/root/episodes`（前回スクリプトテストで手動作成したディレクトリ）が Watch 対象になり、
本来の `~/.openclaw/workspace-{agent}/episodes/` とは無関係なパスを監視してしまう。

その後 ingest で `resolvedAgentWs = "/root/episodes"` が RPC 呼び出しのパラメータとして使われるが、
**Go サイドカー側でこのパスの PebbleDB を開けない or 権限がない**可能性がある。

---

## 修正方針

### Fix 1 — `socket` と `connectOpts` をフィールドに保存して再接続可能にする（rpc-client.ts）

**変更点:**

```typescript
export class EpisodicCoreClient {
  private child?: ChildProcess;
  private socket?: net.Socket;
  private connectOpts?: net.NetConnectOpts;  // ← 追加
  private socketAddr = "";                    // ← 追加（ログ用）
  // ...

  async start() {
    // ...
    this.connectOpts = connectOpts;  // ← フィールドに保存
    this.socketAddr = actualAddr;    // ← ログ用
    // ...
  }

  // request() を修正: socket が壊れていたら自動再接続を試みる
  private async request<T>(method: string, params: any = {}, timeoutMs = 120000): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      // 再接続を試みる（最大 3 回、500ms 間隔）
      if (this.connectOpts) {
        await this.reconnect();
      } else {
        throw new Error("Go sidecar socket not connected and no reconnect info available");
      }
    }
    // ... (既存の処理)
  }

  private reconnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.connectOpts) return reject(new Error("No connect options"));
      let retries = 0;
      const maxRetries = 3;
      const tryReconnect = () => {
        this.socket = net.createConnection(this.connectOpts!, () => {
          console.log("[Plugin] Reconnected to Go RPC socket");
          this.setupSocketReader();
          resolve();
        });
        this.socket.on("error", (err: any) => {
          if ((err.code === "ECONNREFUSED" || err.code === "ENOENT") && retries < maxRetries) {
            retries++;
            setTimeout(tryReconnect, 500);
          } else {
            reject(err);
          }
        });
      };
      tryReconnect();
    });
  }
```

### Fix 2 — `resolvedAgentWs` のフォールバックを改善（index.ts L53-58）

WSL 上での安全なデフォルトパスとして `$HOME/.openclaw/episodes/default` を使う。

```typescript
if (api.runtime?.extensionAPI?.resolveAgentWorkspaceDir) {
  const defaultAgent = api.runtime.extensionAPI.resolveDefaultAgentId?.(openClawGlobalConfig) || "main";
  resolvedAgentWs = api.runtime.extensionAPI.resolveAgentWorkspaceDir(openClawGlobalConfig, defaultAgent);
} else {
  // フォールバック: $HOME/.openclaw/episodes/<agentId>
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();
  resolvedAgentWs = path.join(homeDir, ".openclaw", "episodes", "main");
  console.warn("[Episodic Memory] resolveAgentWorkspaceDir not available, using fallback:", resolvedAgentWs);
}
```

さらに、`gateway_start` フック内でディレクトリを自動作成する:

```typescript
// await rpcClient.start(); の直後に追加
await fs.promises.mkdir(resolvedAgentWs, { recursive: true });
```

---

## 影響範囲

| ファイル | 変更箇所 | 変更種別 |
|---|---|---|
| `src/rpc-client.ts` | `connectOpts` フィールド追加 + `reconnect()` メソッド追加 + `request()` 修正 | 機能追加 |
| `src/index.ts` | `resolvedAgentWs` フォールバックロジック変更 + `mkdir` 追加 | バグ修正 |

---

## 優先度

| # | 問題 | 優先度 | 修正難易度 |
|---|---|---|---|
| Fix 1 | socket 再接続機能 | 🔴 Critical | Medium（50行程度） |
| Fix 2 | フォールバックパス修正 | 🟡 High | Low（5行） |

---

## 次のステップ（第3ラウンドへの手順）

1. **Windows 側で上記修正を実施** → TS ビルド通過確認（`npm run build:ts`）
2. **WSL に dist/*.js と src/*.ts をコピー**（ソースコードは変更しない — WSL へ再コピーのみ）
3. **Gateway を再起動**して動作確認
4. **`openclaw agent --agent main -m "..."` で再テスト** → episodes/ ファイル自動生成を確認

---

## 第3ラウンド用 Opencode プロンプトへの追記指示

`opencode_phase_5_5_prompt.md` の Part A 冒頭に以下を追加してください:
### 🔍 第三者精査への対応（実装済み）

| 指摘 | 対応状況 | 実装内容 |
|---|---|---|
| P1: Thundering Herd（再接続競合） | ✅ **修正済み** | `reconnectPromise` フィールドを Mutex として使用。リコネクト中は同じ Promise を共有して await することでシリアライズ |
| P1: Pending Leak（宙吊りリクエスト） | ✅ **修正済み** | `setupSocketReader(sock)` に `sock.on("close")` / `sock.on("error")` を追加し、断絶時に `rejectPending()` で pendingReqs を全件即時 reject |
| P1: エラーハンドラの再試行ループ | ✅ **修正済み** | `tryReconnect()` 内で `sock.once("connect", onConnected)` と `sock.once("error", onConnectError)` を分離。`onConnected` 時に `removeListener("error")` で一時リスナーを解除し、その後 `setupSocketReader` で運用中の別ハンドラを登録 |
| P2: Go サイドカー側の切断原因 | 📌 **要WSL調査** | `reconnect` で絆創膏を貼りつつ、WSL 上の `/tmp/episodic-core.log` からソケット切断の Go 側ログを第3ラウンドで確認すること |

**TSビルド（tsc）: エラーゼロ確認済み（2026-03-20 23:05 ICT）**

---

## 🔍 Google Staff SWE による第三者精査（2026-03-20）

Phase 5.5 のブロッカーに対する修正案および実装済みのコード（`rpc-client.ts`, `index.ts`）を精査した。
**結論として、提案されたリコネクト実装には 3 つの重大な構造的欠陥（P1）があり、このままでは本番環境で深刻なバグ（リソースリーク・ハング・クラッシュ）を引き起こす。**

### 🔴 P1: リコネクトの競合（Thundering Herd）
`request()` メソッドで `!this.socket || this.socket.destroyed` の場合に都度 `await this.reconnect()` を呼んでいる。
複数のリクエストが同時に（非同期的に）発生した場合、**すべてのリクエストが同時に `reconnect()` をトリガー**し、Go サイドカーに対して無数の TCP/UNIX ソケット接続を同時並行で張りにいく競合状態（Race Condition）が発生する。
* **推奨修正**: `this.reconnectPromise` のような Promise キャッシュ（Mutex）を導入し、リコネクト処理中は他のリクエストをその Promise に await させて同期させること。

### 🔴 P1: ソケット切断時の既存リクエストのハング（Pending Leak）
ソケットが切断された際、実行中だった `pendingReqs` に対する `reject` 処理が存在しない。
Go サイドカープロセス自体が死んだ場合は `this.child.on("close")` で処理されるが、「プロセスは生きているがソケットだけ切れた（あるいは Go 側から EOF が来た）」場合、**既存のリクエストは 120 秒間（timeoutMs）虚無を待ち続けてからようやく Timeout エラーになる**。
* **推奨修正**: `this.socket.on("close")` または `error` ハンドラを確立後のソケットにアタッチし、発火時に `pendingReqs` を舐めて `socket closed unexpectedly` で即時 reject するロジックが必須。

### 🔴 P1: 接続後のエラーハンドラにおける意図せぬ再試行ループ
`reconnect()` 内の `sock.on("error")` ハンドラにおいて、接続が**成功した後**に何らかの通信エラー（`ECONNRESET`等）が発生した場合、スコープに残っている `retries` が `maxRetries` 未満であれば、**意図せず `tryReconnect()` を再度発火させてしまう**バグを含んでいる。
* **推奨修正**: 接続確立時（`resolve()` 時点）で接続試行時の `error` リスナーは `sock.removeAllListeners("error")`等 で外し、代わりに運用中の持続的な `error` と `close` イベントハンドラを設定すること。

### 🟠 P2: 「なぜ切断されたのか？」の根本原因の追求不足
レポートでは「readlineが何らかの理由でソケットを destroyed 状態にする」と推測しているが、`readline` は Go 側から **EOF (FIN) パケットを受け取らない限り** 勝手に close しない。つまり、**Go サイドカー側が RPC 接続を意図的に（またはパニックにより）クローズしているのが真の根本原因**の可能性が高い。
* **推奨修正**: 単にリコネクトで絆創膏を貼るだけでなく、Go サイドカー側（`episodic-core`）のログを確認し、「なぜコネクションが切られるのか？」を解決すべき。
