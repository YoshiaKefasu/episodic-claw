# `ep-save` の `saved_by` が `auto` になる問題の修正プラン

## 原因の精査 (Root Cause Analysis)

現在の `ep-save` 実行時、生成される Markdown エピソードのフロントマターで `saved_by: auto` とハードコードされてしまう原因は以下の通りです。

1. **Goバックエンドのハードコード**  
   [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) の `ai.ingest` ハンドラにて、`frontmatter.EpisodeMetadata` を組み立てる際、一律で `SavedBy: "auto"` と静的に定義されています。
2. **RPCパラメータの欠如**  
   TypeScript側の [src/rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) ([generateEpisodeSlug](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#351-358)) および、Go側の `IngestParams` 構造体がそもそも `savedBy` / `agentId` を受け取る仕様になっていません。

## 修正プラン (Implementation Plan)

明日の実装フェーズに向けて、以下の3箇所の改修を行います。

### 1. Go側のRPC引数拡張と動的代入 ([go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go))
[handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#372-499) 内で受け取る引数ストラクチャに `SavedBy` を追加し、フロントエンドから受け取った値をセットします。（未指定時はフォールバックで `"auto"` を適用）

```go
// go/main.go : handleIngest
var params struct {
    Summary   string             `json:"summary"`
    Tags      []string           `json:"tags"`
    Edges     []frontmatter.Edge `json:"edges"`
    AgentWs   string             `json:"agentWs"`
    APIKey    string             `json:"apiKey"`
    SavedBy   string             `json:"savedBy"` // ← 追加
}

// ... 
savedBy := params.SavedBy
if savedBy == "" {
    savedBy = "auto"
}

fm := frontmatter.EpisodeMetadata{
    ID:        slug,
    Title:     slug,
    Tags:      params.Tags,
    SavedBy:   savedBy, // ← 動的代入に変更
    RelatedTo: params.Edges,
}
```

### 2. TypeScript側のRPCクライアント拡張 ([src/rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts))
[generateEpisodeSlug](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#351-358) メソッドの引数に `savedBy` を追加し、RPCリクエストのペイロードに含めます。

```typescript
// src/rpc-client.ts
async generateEpisodeSlug(
  summary: string, 
  tags: string[] = [], 
  edges: any[] = [],
  agentWs: string = "",
  savedBy: string = "" // ← 追加
): Promise<{ slug: string, path: string }> {
  const result = await this.request("ai.ingest", { 
    summary, 
    tags, 
    edges,
    agentWs,
    savedBy // ← 追加
  });
  // ...
}
```

### 3. プラグインメイン層でのエージェントID取得と引き回し ([src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts))
現在 `api.on("gateway_start")` の内部ローカル変数となっている `defaultAgentId` をファイルスコープ（モジュールレベル）に昇格させ、`ep-save` の [execute](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#218-239) 時点で参照できるようにします。
また、OpenClawプラグインAPIの `ctx` (ツールファクトリコンテキスト) に [agent](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/index.ts#1229-1233) 情報が含まれている場合はそれを最優先で利用するフェイルセーフな設計とします。

```typescript
// src/index.ts トップレベル付近
let defaultAgentId = "main";

// ...
  api.registerTool((ctx: any) => ({
    name: "ep-save",
    // ...
    execute: async (_toolCallId: string, params: any) => {
      // ctx.agent.id があれば優先、なければ defaultAgentId にフォールバック
      const agentId = ctx?.agent?.id || defaultAgentId;
      
      // ...
      const slugRes = await rpcClient.generateEpisodeSlug(content, tags, [], resolvedAgentWs, agentId);
    }
  }));
```

## 期待される結果 (Expected Outcome)
この修正により、コンテキストに応じた正確なエージェント名（例: [main](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#1068-1118) や `keruvim`）が Markdown ファイルの `saved_by` フィールドに永続化されるようになり、将来的なマルチエージェント環境下でも「誰がこの記憶を書き込んだか」のトレーサビリティが確立します。

---

## 🚨 Google Pro Engineer 監査レポート (Audit Review)

提案された実装プランは全体として堅牢（特に `ctx.agent.id || defaultAgentId` のフェイルセーフ設計）ですが、Google Pro Engineerの観点から「システム全体の対称性」および「将来的なマルチエージェント動作」において以下の**重大な考慮漏れ・リスク**があるため、実行前にプランへ組み込むよう勧告します。

### 1. 【非対称性】`handleBatchIngest` (自動アーカイバ) への修正漏れ
現在のプランは `ep-save` (手動保存 / `handleIngest`) だけにフォーカスしています。
しかし、Go側 (`go/main.go` 行624付近) の `handleBatchIngest` 内でも `SavedBy: "auto"` とハードコーディングされています。
* **影響:** 手動保存のエピソードには正しい `savedBy: "main"` 等が記録されますが、コンテキストエンジンから自動的にチャンク化・保存されるエピソードは相変わらず `"auto"` のままになります。
* **推奨の修正:** TS側の `batchIngest(items, agentWs)` の引数、および `go/main.go` の `BatchIngestItem`（もしくは親引数）にも同様に `SavedBy` を追加し、アーキテクチャの対称性を担保してください。

### 2. 【安全性】マルチエージェント環境下での状態汚染 (State Bleeding) リスク
`src/index.ts` の `defaultAgentId` を**ファイルスコープ（シングルトン）に昇格させる設計は危険**です。
* **リスク:** 複数のエージェント（Agent A, Agent B）が別々の設定を持って同時に起動する将来のOpenClaw環境において、変数 `defaultAgentId` が最後に起動したエージェントの情報（または最初にキャッシュされた情報）によって上書きされ、コンテキスト競合（State Bleeding/Race Condition）を引き起こす恐れがあります。
* **推奨の修正:** 状態をグローバルに持たず、以下のように `api.on("gateway_start")` と `execute` の両方で設定（config）からダイナミックに読み取るか、各エージェントコンテキストである `ctx` 内の情報（`ctx.agent.id` 等）を**無条件に最優先（Trust Context）**し、`defaultAgentId` はあくまで `fallback` レベルの定数か、リクエスト毎の計算値とするべきです。

### 3. 【エッジケース】`ctx` の束縛タイミング
* `api.registerTool((ctx) => { ... execute: () => { ... } })` において、`ctx` は「ツールの登録時」のコンテキストです。もしOpenClawのシステムが「単一のツールプロバイダファクトリ」を使い回す仕様の場合、実行時 (`execute`) に `ctx.agent.id` が最新の実行エージェントを指していない可能性があります。
* **解決策:** `execute` メソッドの引数である `_toolCallId` や `params` の背後に実行時のコンテキストメタデータが含まれる場合はそちらを優先すること。もし無ければ現状のフォールバックで安全を担保できます。
