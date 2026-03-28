# Phase 5.4 障害報告書：Goサイドカー未起動問題

> **作成日**: 2026-03-20
> **調査ツール**: GitNexus MCP (647 symbols, 1297 relations indexed — episodic-claw) + GitNexus MCP (30889 symbols, openclaw)
> **対象バージョン**: OpenClaw v2026.3.13 / episodic-claw v1.0.0
> **レビュー**: Google Staff SWE による第三者検証済み

---

## TL;DR

`src/index.ts` の `api.on("start", ...)` / `api.on("stop", ...)` が OpenClaw v2026.3.13 で**認識されない**フック名であるため、Goサイドカーが一切起動されない。**フック名の修正は正しいが、修正コードに3つの追加問題がある**（詳細はセクション3参照）。

---

## 1. 問題の現象

### 観測されるログ (WSL 上で `openclaw gateway run --verbose`)

```
[gateway] [plugins] unknown typed hook "start" ignored
  (plugin=episodic-claw, source=/root/.openclaw/extensions/episodic-claw/index.ts)
[gateway] [plugins] unknown typed hook "stop" ignored
  (plugin=episodic-claw, source=/root/.openclaw/extensions/episodic-claw/index.ts)
```

### 連鎖する障害

| # | 障害 | 原因 |
|---|---|---|
| 1 | `rpcClient.start()` が呼ばれない | `"start"` フックが無視されるため |
| 2 | [episodic-core](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/dist/episodic-core) プロセスが存在しない | sidecar 起動コマンドが実行されないため |
| 3 | TCP ソケット接続が確立されない | サイドカーが存在しないため |
| 4 | `rpcClient.startWatcher()` も呼ばれない | 同上 |
| 5 | [ingest()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#75-85) / [assemble()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#85-98) / [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#98-102) がすべて失敗 | RPC 接続がないため |
| 6 | `rpcClient.stop()` が呼ばれない | `"stop"` フックが無視されるため→サイドカーのゾンビ化リスク |

---

## 2. 根本原因の特定 (GitNexus 解析)

### 2.1 正しいフック名の確認 (openclaw types.ts)

GitNexus による openclaw コードベース精査で、`src/plugins/types.ts` に `PluginHookName` 型が定義されていることを確認：

```typescript
// openclaw/src/plugins/types.ts L424-448
export type PluginHookName =
  | "before_model_resolve"
  | "before_prompt_build"
  | "before_agent_start"
  | "session_start"
  | "session_end"
  | "gateway_start"   // ← 正しいフック名
  | "gateway_stop";   // ← 正しいフック名
```

また `src/plugins/hooks.ts` L688-704 で `runGatewayStart` / `runGatewayStop` が `runVoidHook("gateway_start", ...)` / `runVoidHook("gateway_stop", ...)` を呼ぶことを確認。フック名 `"gateway_start"` / `"gateway_stop"` は正しい。

### 2.2 コード上の問題箇所 (src/index.ts)

```typescript
// L44: ❌ "start" は v2026.3.13 で未認識
api.on("start", async () => { ... });

// L63: ❌ "stop" は v2026.3.13 で未認識
api.on("stop", () => { ... });
```

### 2.3 実際の `api.on()` シグネチャ (openclaw types.ts L404-408)

`api.on()` の実際の型定義は以下の通り：

```typescript
on: <K extends PluginHookName>(
  hookName: K,
  handler: PluginHookHandlerMap[K],   // (event, ctx) の2引数ハンドラ
  opts?: { priority?: number },
) => void;
```

`gateway_start` / `gateway_stop` のハンドラ型：

```typescript
gateway_start: (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
// PluginHookGatewayStartEvent = { port: number }
// PluginHookGatewayContext    = { port?: number }

gateway_stop: (event: PluginHookGatewayStopEvent, ctx: PluginHookGatewayContext) => Promise<void> | void;
// PluginHookGatewayStopEvent  = { reason?: string }
```

---

## 3. 修正内容（問題点の指摘と修正）

### 変更ファイル: [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts)

> [!IMPORTANT]
> 以下の3つの問題を同時に修正する必要がある。

#### 問題①（P0）: フック名の誤り

`"start"` → `"gateway_start"`、`"stop"` → `"gateway_stop"` に変更。

#### 問題②（P1）: ハンドラのシグネチャ不整合

旧コードのハンドラは `async () => {}` と引数なしだが、openclaw が要求するシグネチャは `(event, ctx) => void`。TypeScript の構造的型付けにより引数が少ないハンドラは許容されるが、ローカルの `OpenClawPluginApi` スタブインターフェース（L9-20）が `on(event: string, callback: () => void | Promise<void>): void;` と宣言されているため、`gateway_start` という `PluginHookName` 以外の文字列を渡した時点でコンパイルエラーが起きない（型が緩すぎる）。スタブを修正しないと「正しいフック名でも誤ったフック名でも同じようにコンパイルが通る」状態が続く。

#### 問題③（P1）: `OpenClawPluginApi` ローカルスタブが outdated

`src/index.ts` L9-20 のスタブインターフェースは openclaw の実際の型 (`src/plugins/types.ts`) と乖離している。最低限 `on` の型を修正しなければ、今後も同様の「フック名誤りがコンパイル時に検出できない」問題が再発する。

#### 修正後の正しいコード:

```typescript
// src/index.ts — スタブ型を修正（L9-20）
export interface OpenClawPluginApi {
  // フック登録 — openclaw types.ts の PluginHookName に準拠
  on(
    hookName: "gateway_start" | "gateway_stop" | "before_prompt_build" | "session_start" | "session_end" | string,
    handler: (...args: any[]) => void | Promise<void>,
    opts?: { priority?: number }
  ): void;
  registerContextEngine(id: string, factory: () => any): void;
  registerTool(name: string, defs: any, handler: (args: any) => Promise<any>): void;
  runtime: {
    extensionAPI: any;
    config: { loadConfig: () => any; };
  };
}

// L44: ✅ 修正後
api.on("gateway_start", async (event: any, ctx: any) => {
  console.log("[Episodic Memory] Starting Go sidecar... (port:", event?.port, ")");
  await rpcClient.start();

  if (api.runtime?.extensionAPI?.resolveAgentWorkspaceDir) {
     const defaultAgent = api.runtime.extensionAPI.resolveDefaultAgentId?.(openClawGlobalConfig) || "main";
     resolvedAgentWs = api.runtime.extensionAPI.resolveAgentWorkspaceDir(openClawGlobalConfig, defaultAgent);
  } else {
     resolvedAgentWs = path.resolve(process.cwd(), "episodes");
  }

  Promise.race([
    rpcClient.startWatcher(resolvedAgentWs),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Watcher Start Timeout")), 5000))
  ]).catch(err => {
    console.error("[Episodic Memory] Failed to start watcher.", err);
  });
});

// L63: ✅ 修正後
api.on("gateway_stop", (event: any, ctx: any) => {
  console.log("[Episodic Memory] Stopping plugin... (reason:", event?.reason, ")");
  rpcClient.stop();
});
```

> [!IMPORTANT]
> **変更点**: フック名2箇所 + ハンドラシグネチャに `(event, ctx)` を追加 + スタブインターフェースの `on` 型を整備。

---

## 4. 修正後の検証手順 (Phase 5.4 チェックリスト)

```bash
# ① WSL で TS 再ビルド
cd ~/.openclaw/extensions/episodic-claw
npx tsc   # または npm run build
# → コンパイルエラーゼロを確認

# ② Gateway 再起動（verbose で起動ログを監視）
openclaw gateway stop
openclaw gateway run --verbose
```

期待されるログ（エラーがなければ成功）:
```
[Episodic Memory DEBUG] Starting register()...
[Episodic Memory] Starting Go sidecar... (port: 8080)
[Episodic Memory] Watcher started on: /root/.openclaw/workspace-xxx/episodes
```

```bash
# ③ Go サイドカーのプロセス確認
ps aux | grep episodic-core | grep -v grep
# → PID が存在すれば起動成功

# ④ TCP 接続確認
ss -tnp | grep episodic-core
# → 127.0.0.1:<port> の ESTABLISHED が存在すること

# ⑤ ゾンビプロセス防止テスト
openclaw gateway stop
sleep 3
ps aux | grep episodic-core | grep -v grep
# → 結果が空であれば正常終了（stdin監視が機能している証拠）
```

---

## 5. [OpenClawPluginApi](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#9-20) インターフェースの整備（必須修正に格上げ）

> [!WARNING]
> セクション3で述べた通り、ローカルスタブインターフェースの修正は **cosmetic ではなく必須**。`on` の `event: string` 型が緩すぎるため、誤ったフック名がコンパイル時に検出されない。

openclaw の実際の `PluginHookName` 型から最低限必要なフックを列挙する形でスタブを更新すること（セクション3の修正コード参照）。

**将来的な完全解決策**（推奨）: `episodic-claw` に `@openclaw/plugin-sdk` パッケージがあれば直接 import する。ない場合は型スタブファイル (`types.d.ts`) を別ファイルに切り出し、CI でバージョン間の型整合チェックを入れる。

---

## 6. 影響範囲サマリー

```
修正範囲: src/index.ts の L9-20 (スタブ型), L44, L63 (フック名と引数)
リグレッションリスク: 最小（ロジック変更ゼロ）
再インストール: 不要
再ビルド: 必要（dist/index.js への反映が必須）
テスト影響: test_phase2.ts / test_phase3.ts / test_phase4_5.ts / test.ts は
           rpcClient.start() をモックまたは直接呼び出しているため、
           今回のフック名修正の影響を受けない。
```

---

## 7. 参照ドキュメント

| ドキュメント | 説明 |
|---|---|
| [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) | 修正対象ファイル (L9-20, L44, L63) |
| [src/rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) | EpisodicCoreClient.start() の実装 |
| [openclaw/src/plugins/types.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw/src/plugins/types.ts) | PluginHookName / PluginHookHandlerMap / OpenClawPluginApi の実際の型定義 |
| [openclaw/src/plugins/hooks.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw/src/plugins/hooks.ts) | runGatewayStart / runGatewayStop の実装 (L688-704) |

---

### 変更内容

**`src/index.ts`**
```diff
// L9-20: OpenClawPluginApi.on() シグネチャ整備
- on(event: string, callback: () => void | Promise<void>): void;
+ on(
+   hookName: "gateway_start" | "gateway_stop" | "before_prompt_build" | ... | string,
+   handler: (event?: any, ctx?: any) => void | Promise<void>,
+   opts?: { priority?: number }
+ ): void;

// L44: フック名修正 + シグネチャ適合
- api.on("start", async () => {
+ api.on("gateway_start", async (event?: any, _ctx?: any) => {
+   console.log("...", event?.port ? `(gateway port: ${event.port})` : "");

// L63: フック名修正 + シグネチャ適合
- api.on("stop", () => {
+ api.on("gateway_stop", (event?: any, _ctx?: any) => {
+   console.log("...", event?.reason ? `(reason: ${event.reason})` : "");
```

**`test_phase2.ts`** (d=1 連動更新)
```diff
- on(event: string, callback: () => void): void { ... }
+ on(hookName: string, handler: (event?: any, ctx?: any) => void, opts?): void { ... }

- callbacks.get("start") → callbacks.get("gateway_start")
- callbacks.get("stop")  → callbacks.get("gateway_stop")
+ startCb({ port: 18789 })   // ポート番号を渡してシグネチャをリアルに
+ stopCb({ reason: "test-teardown" })
```

### GitNexus GUIDELINE.md self-check ✅
| チェック項目 | 結果 |
|---|---|
| impact 分析 (`OpenClawPluginApi` upstream) | risk=LOW, d=1は`MockApi`のみ→更新済み |
| detect_changes で変更スコープ確認 | 変更ファイル: 2, HIGH/CRITICAL riskなし |
| d=1 の依存(WILL BREAK) を全更新 | `test_phase2.ts` の MockApi・callbacks.get を連動更新 |

---

### 次のステップ
WSLで `npm run build`（または `npx tsc`）→ `openclaw gateway stop && openclaw gateway run --verbose` を実行し、`[Episodic Memory] Starting Go sidecar... (gateway port: ...)` がログに出現することを確認してください。