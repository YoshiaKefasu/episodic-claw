# 容赦ないコードレビュー：Episodic Memory Phase 1.5 (TypeScript Fundamentals)
（Reviewer: Staff Software Engineer, Google）

## TL;DR: 基礎はできたが、致命的な「スコープの混同」が本番環境を破壊する
型定義（[types.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/types.ts)）や設定のスキーマ定義（[config.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/config.ts)）、そしてOpenClaw Plugin APIへの登録コントラクトの基礎を整備した点（Phase 1.5）は評価する。Goサイドカーとの連携準備として、最低限のTypeScriptシェルは構築された。

しかし、[index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) において、**設定オブジェクトのスコープ（Global vs Plugin）を完全に混同**しており、このままプラグインを走らせると**エージェントのワークスペース解決が100%破綻（パニックまたは誤ったディレクトリの作成）**するという致命的なバグ（P0）が埋め込まれている。

以下に指摘事項をまとめる。

---

## 🚫 致命的欠陥 (P0 レベル)

### 1. グローバル設定とプラグイン設定の致命的混同によるWorkspace解決の破綻
**問題ファイル:** [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) (L20 - L31)
**問題箇所:** 
```typescript
const globalRawCfg = api.runtime?.config?.loadConfig?.() || {};
const cfg = loadConfig(globalRawCfg); // cfg は EpisodicPluginConfig 型になる

// ...省略...
const defaultAgent = api.runtime.extensionAPI.resolveDefaultAgentId?.(cfg) || "main";
agentWs = api.runtime.extensionAPI.resolveAgentWorkspaceDir(cfg, defaultAgent);
```
**理由:** 
`api.runtime.config.loadConfig()` は **OpenClawのルート設定（openclaw.json 全体）** を返す。
お前はそれを [loadConfig()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/config.ts#3-13) に通し、`sharedEpisodesDir` しか持たない狭い **[EpisodicPluginConfig](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/types.ts#28-32)** へとダウンキャスト（抽出）した変数 `cfg` を作った。
そこまではいい。だが直後、`resolveAgentWorkspaceDir(cfg, ...)` にその `cfg` を渡している。

`resolveAgentWorkspaceDir` は内部で `agents.list` やエージェントのカスタム `workspace` パスを検索するために **OpenClawのグローバル設定全体（OpenClawConfig）** を必要とする関数だ。`sharedEpisodesDir` しか持たないスリムな `cfg` を投げつければ、当然 undefined 参照でクラッシュするか、フォールバックが働き全く見当違いの `workspace-main` ディレクトリをホームディレクトリ等に勝手に掘り始めるだろう。

**解決策:** 
変数スコープを分離せよ。グローバルなOpenClaw設定オブジェクトと、プラグイン固有の設定オブジェクトを明確に分け、APIには正しいものを渡すこと。

```typescript
const openClawGlobalConfig = api.runtime?.config?.loadConfig?.() || {};
const pluginConfig = loadConfig(openClawGlobalConfig);

// extensionAPI には openClawGlobalConfig を渡すこと！
const defaultAgent = api.runtime.extensionAPI.resolveDefaultAgentId?.(openClawGlobalConfig) || "main";
agentWs = api.runtime.extensionAPI.resolveAgentWorkspaceDir(openClawGlobalConfig, defaultAgent);
```

**[FIXED]** `src/index.ts` にて、`api.runtime.config.loadConfig()` が返すグローバル設定 (`openClawGlobalConfig`) と プラグイン設定 (`cfg`) を明確に分離し、`extensionAPI` へはグローバル設定を正しく渡すように修正しました。

---

## ⚠️ 潜在的リスク (P1 レベル)

### 2. プラグイン起動シーケンスにおけるブロック（Hanging）リスク
**問題ファイル:** [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) (L38)
**問題箇所:** `await rpcClient.startWatcher(agentWs);`
**理由:** OpenClaw の `api.on("start")` フック内で `await` しているが、万が一 Goサイドカーのソケット通信が詰まったり、存在しない・権限がないディレクトリをWatchしようとしてエラーが返らなかったりした場合、**OpenClaw本体の起動シーケンス全体がここで永遠にハングする**。
**解決策:** `Promise.race()` を用いて数秒（例: 5000ms）のタイムアウトを設けるか、あるいは起動のクリティカルパスから外し、非同期に開始させて失敗時はエラーログ（`console.error`）を吐くに留める設計（Fail-safe）を検討すべきだ。プラグインの初期化失敗でホスト（OpenClaw本体）を殺すべきではない。

**[FIXED]** `await rpcClient.startWatcher` を廃止し、`Promise.race` で5000msのタイムアウトを設け、Fail-safeな `.catch` ブロックで囲む非同期火放し型へと変更しました。これにより本体の起動はブロックされません。

---

## ✅ 評価できる点 (Good)
- **Domain Modeling ([types.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/types.ts)):** 
  Go側の `frontmatter.go` 等で定義されている構造体と、TS側の [EpisodeMetadata](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/types.ts#10-17), [Edge](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/types.ts#4-9) のプロパティが過不足なく完全に一致（Sync）している。これによりJSONシリアライズ/デシリアライズ時の事故は防げる。
- **Lifecycle Management ([index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts)):**
  ダミーのクラスではなく、正しく `api.on("stop")` フックを捉えて `rpcClient.stop()` を呼び出し、Go子プロセスを道連れに終了（Graceful Shutdown）させる意図がコードから読み取れる。

## 総評
「インターフェースが変わる境界」、つまりプラットフォームAPIへのフック部分でスコープの履き違え（Type Mismatch / Scope Confusion）が起きるのは非常に典型的なバグだ。
TypeScriptは実行時の型チェックをしてくれないため、コンパイラをすり抜けたこの手のバグは本番環境でのデバッグを極めて困難にする。

変数 `cfg` の混同による Workspace 解決のバグ（P0）を最優先で修正せよ。それが直れば、Phase 1.5の土台としては要件を満たしている。直ちに修正に取り掛かることを勧める。
