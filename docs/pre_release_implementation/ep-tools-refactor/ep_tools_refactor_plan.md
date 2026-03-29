# Episodic Memory ツール修正プラン (<code>ep_tools_refactor_plan.md</code>)

## 目標
`episodic-claw` の全ツール (`ep-save`, `ep-recall`, `ep-expand`) をOpenClaw正式API仕様に準拠させるためのリファクタリングを実施し、LLMエージェントから確実に呼び出せるようにする。

---

## ステップ 1: プラグインのベース設定修正

### 1-1. [package.json](file://wsl.localhost/ArchLinux/root/.openclaw/package.json) の修正
OpenClaw環境 (Bun) が直接実行できるようにエントリを変更し、必須ライブラリを追加する。
- **変更前:** `"main": "dist/index.js"`
- **変更後:** `"main": "index.ts"`, `"type": "module"` を追加
- **依存関係:** `"dependencies"` に `"@sinclair/typebox": "^0.34.0"` を追加。

### 1-2. [openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/openclaw.plugin.json) の新規作成
OpenClawのプラグインメタデータを明示的に定義する。
- **場所:** リポジトリ直下 ([episodic-claw/openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json))
- **内容:** plugin ID と `enabled` などの基本ConfigSchemaを定義する。

---

## ステップ 2: ツール定義のTypeBox化

[src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) の先頭に以下のインポートを追加する。
```typescript
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
```

そして、各ツールのパラメータスキーマを定義する。
```typescript
const EpSaveSchema = Type.Object({
  content: Type.String({ description: "保存したい内容の自然言語テキスト。最大3600文字。" }),
  tags: Type.Optional(Type.Array(Type.String(), { description: "文脈を示すオプションタグ" }))
});

const EpRecallSchema = Type.Object({
  query: Type.String({ description: "検索クエリ文字列" }),
  limit: Type.Optional(Type.Number({ description: "最大取得件数 (デフォルト: 5)" }))
});

const EpExpandSchema = Type.Object({
  path: Type.String({ description: "ep-recall で取得した path や namespace" }),
  query: Type.String({ description: "深堀りするための自然言語クエリ" })
});
```

---

## ステップ 3: [registerTool](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#19-20) 実装の全面刷新

`api.registerTool` の呼び出しを、OpenClawが期待する **ファクトリ関数** 形式、または `optional` 制約に従う形に変更する。また [execute](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#218-250) 関数のシグネチャと戻り値の型を修正する。

### 共通の基本構造
```typescript
api.registerTool((ctx) => ({
  name: "tool-name",
  description: "...",
  parameters: SomeSchema,
  async execute(toolCallId: string, params: any) {
    const p = params as Record<string, unknown>;
    // ...各処理...
    return {
      content: [{ type: "text", text: "結果文字列" }], // LLMに渡すテキスト形式
      details: { ... } // (任意) 構造化データ
    };
  }
}));
```

### 3-1. `ep-save`
- **引数:** `const raw = (p.content as string) || "";` と `const tags = (p.tags as string[]) || [];`
- **バリデーション:** `raw.trim()` が無ければ空エラーを `content` 配列形式で返す。
- **文字数制限:** Surrogate Pair対策で `Array.from(raw).slice(0, 3600).join("")` を行う。
- **実行:** `rpcClient.generateEpisodeSlug` / `ai.ingest` を実行。

### 3-2. `ep-recall`
- **引数:** `const query = (p.query as string) || "";`
- **実行:** `rpcClient.request("ai.recall", ...)`。
- **パース:** 取得したJSON結果を可読なMarkdown文字列にフォーマット。
- **戻り値:** `{ content: [{ type: "text", text: resultsMarkdown }] }` を返す。

### 3-3. `ep-expand`
- **引数:** `const path = (p.path as string) || "";` と `const query = (p.query as string) || "";`
- **実行:** `rpcClient.request("ai.expand", ...)`。
- **パース:** 取得した結果を可読なMarkdownフォーマットに変換。
- **戻り値:** 同上。

---

## ステップ 4: Goサイドカー側の確認 (影響なし)
今回の問題は TypeScript（プラグイン層）と OpenClawランタイム 間のAPI不整合のため、Go側の子プロセス・RPCインターフェース(`ai.ingest`, `ai.recall` など)に変更は必要ない。Go側の Kebab-case 対応等は直前のフェーズで完了しているため、TS側が正しい形式で引数を渡せば問題なく発火する。

---

## テスト方法
1. 上記コードを修正して `git add .` を実行。
2. WSへデプロイまたはOpenClawの再起動を行う (Bunで動いているため `tsc` 不要)。
3. Keruvimなどのエージェントから再度 `[ep-save content="保存テスト"]` などとツール呼び出しを実行させる。
4. 成功すれば `"Saved episode to ..."` という文字列がエージェント側のツールコールレスポンスとして正確に表示される。
