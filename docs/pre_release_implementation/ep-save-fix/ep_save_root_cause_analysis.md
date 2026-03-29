# ep-save 根本原因分析：プラグインAPI不整合（完全版）

## 結論（一言）

**episodic-clawの [registerTool](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#19-20) の呼び出し方がOpenClawの正式API仕様と完全に異なる。ツールは「名前だけ登録されるが、execute関数は一度も呼ばれない幽霊ツール」になっていた。**

---

## 調査ソース

| ソース | 内容 |
|---|---|
| **docs.openclaw.ai** | 公式ドキュメント「Building Plugins」→「Registering agent tools」セクション |
| **GitHub openclaw/openclaw** | `src/plugin-sdk/core.ts`、`extensions/brave/index.ts` |
| **lossless-claw** | 公式プラグイン（Martian Engineering製）の実装パターン |
| **WSL上 OpenClaw本体** | `/usr/lib/node_modules/openclaw/dist/plugin-sdk/core.d.ts` |

---

## 発見した4つの致命的な差異

### 1. [registerTool](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#19-20) のシグネチャが根本的に違う

| | episodic-claw（❌ 間違い） | OpenClaw正式API（✅ 正解） |
|---|---|---|
| 呼び方 | `api.registerTool({ name, execute, ... }, { names: [...] })` | `api.registerTool(toolDef, { optional?: boolean })` |
| 第1引数 | ツール定義オブジェクト + 第2引数に `{ names }` | [AnyAgentTool](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/src/tools/common.ts#3-4) オブジェクト or ファクトリ関数 [(ctx) => AnyAgentTool](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#12-18) |
| 第2引数 | `{ names: ["ep-save"] }` ← **存在しないオプション** | `{ optional: boolean }` のみ |

```diff
- api.registerTool({
-   name: "ep-save",
-   execute: async (args) => { ... }
- }, { names: ["ep-save"] });

+ api.registerTool({
+   name: "ep-save",
+   label: "Save Episode",
+   description: "...",
+   parameters: EpSaveSchema,
+   async execute(_toolCallId, params) { ... }
+ });
```

> [!CAUTION]
> `{ names: ["ep-save"] }` というオプションはOpenClaw APIに存在しない。
> OpenClawの内部実装は第2引数を `{ optional: boolean }` として期待しており、
> 不明なキーは無視されるか、ツール登録自体が無効化される。

### 2. [execute](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/dist/index.js#260-272) の引数数が違う

| | episodic-claw（❌） | OpenClaw正式API（✅） |
|---|---|---|
| シグネチャ | [execute(args)](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/dist/index.js#260-272) — 1引数 | [execute(toolCallId: string, params: any)](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/dist/index.js#260-272) — **2引数** |

**公式ドキュメント（docs.openclaw.ai）からの引用:**
```typescript
async execute(_id: string, params: any) {
  // _id = ツール呼び出しのユニークID
  // params = LLMが生成したパラメータオブジェクト
}
```

**lossless-claw（公式プラグイン）の実装例:**
```typescript
// lcm-grep-tool.ts:85
async execute(_toolCallId, params) {
  const p = params as Record<string, unknown>;
  const pattern = (p.pattern as string).trim();
  // ...
}
```

> [!WARNING]
> 1引数の [execute(args)](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/dist/index.js#260-272) を使っている場合、OpenClawランタイムは
> 第1引数に `toolCallId`（文字列）を、第2引数に実際のparamsを渡す。
> そのため `args` にはツールコールIDの文字列が入り、`args.content` は `undefined` になる。

### 3. ツールの返却値フォーマットが違う

| | episodic-claw（❌） | OpenClaw正式API（✅） |
|---|---|---|
| 返却 | 生の文字列 `"Saved episode..."` | `{ content: [{ type: "text", text: "..." }] }` |

**公式ドキュメントの例:**
```typescript
return {
  content: [
    {
      type: "text",
      text: "結果のテキスト"
    }
  ]
};
```

**lossless-claw（公式プラグイン）の共通ヘルパー:**
```typescript
// src/tools/common.ts
export function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}
```

### 4. [package.json](file://wsl.localhost/ArchLinux/root/.openclaw/package.json) の [main](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#1068-1118) エントリ

| | episodic-claw（❌） | lossless-claw（✅） |
|---|---|---|
| main | `"dist/index.js"` — コンパイル済みJS | `"index.ts"` — **生のTypeScript** |
| 結果 | OpenClawのBunランタイムが正しく解決できない可能性 | Bun が直接TSを実行 |

**裏付け:** OpenClawのGatewayは内部的にBunランタイムを使用してプラグインを読み込む。
lossless-clawの [package.json](file://wsl.localhost/ArchLinux/root/.openclaw/package.json) では `"main": "index.ts"` と `"type": "module"` が指定されている。

### 5. パラメータスキーマの定義方法

| | episodic-claw（❌） | OpenClaw正式API（✅） |
|---|---|---|
| スキーマ | 生のJSON Schema オブジェクト | **TypeBox** (`@sinclair/typebox`) |

```diff
- parameters: {
-   type: "object",
-   properties: {
-     content: { type: "string", maxLength: 3600 }
-   },
-   required: ["content"]
- }

+ import { Type } from "@sinclair/typebox";
+ parameters: Type.Object({
+   content: Type.String({
+     description: "The content to save.",
+     maxLength: 3600
+   }),
+   tags: Type.Optional(Type.Array(Type.String()))
+ })
```

---

## なぜTS側のログが一切出力されなかったのか

### シナリオ A: executeが呼ばれているが引数がずれている
OpenClawが [execute(toolCallId, params)](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/dist/index.js#260-272) を呼ぶとき、episodic-clawは [execute(args)](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/dist/index.js#260-272) で受け取る。
→ `args` = `toolCallId`（文字列）
→ `args.content` = `undefined`
→ `args.summary` = `undefined`
→ `raw = ""` → 早期リターン

### シナリオ B: ツール登録自体が無効化されている
`{ names: ["ep-save"] }` という無効なオプションにより、OpenClawのツールレジストリが
登録を完全にスキップしているか、LLMにだけ名前を公開して実行パスをバイパスしている。

### シナリオ C: ログ出力が一切出なかった理由
`fs.appendFileSync` すら実行されなかったことから、**executeが文字通り一度も呼ばれていない**。
Go側のログ（`ai.ingest TRACE 1`）は出ているが、これはOpenClawのランタイムが
TS側をバイパスして直接Goサイドカーにフォールバック（空パラメータで）送信していた可能性がある。

---

## 推奨修正方針

### Step 1: [package.json](file://wsl.localhost/ArchLinux/root/.openclaw/package.json) の修正

```diff
- "main": "dist/index.js",
+ "main": "index.ts",
+ "type": "module",
```

### Step 2: [openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/openclaw.plugin.json) を追加

```json
{
  "id": "episodic-claw",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean" }
    }
  }
}
```

### Step 3: `import type` を正式SDKから取得

```diff
- export interface OpenClawPluginApi { ... }  // 手書きのスタブ
+ import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
```

### Step 4: [registerTool](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#19-20) をOpenClaw正式パターンに修正

```typescript
import { Type } from "@sinclair/typebox";

const EpSaveSchema = Type.Object({
  content: Type.String({
    description: "The content to save. Write freely in natural language.",
    maxLength: 3600
  }),
  tags: Type.Optional(Type.Array(Type.String(), {
    description: "Optional tags to categorize this memory"
  })),
});

api.registerTool({
  name: "ep-save",
  label: "Save Episode",
  description: "Manually save critical memory into Episodic Memory.",
  parameters: EpSaveSchema,
  async execute(_toolCallId, params) {
    const p = params as Record<string, unknown>;
    const raw = ((p.content as string) || "").trim();
    if (!raw) {
      return {
        content: [{ type: "text", text: "Error: content is empty." }],
      };
    }
    const runes = Array.from(raw);
    const content = runes.length > 3600
      ? runes.slice(0, 3600).join("") + "\n...(truncated)"
      : raw;
    const slugRes = await rpcClient.generateEpisodeSlug(
      content,
      (p.tags as string[]) || [],
      [],
      resolvedAgentWs
    );
    return {
      content: [{ type: "text", text: `Saved episode to ${slugRes.path}` }],
      details: { path: slugRes.path, slug: slugRes.slug },
    };
  },
});  // optionsなし = required tool
```

### Step 5: 他のツール (ep-recall, ep-expand) も同様に修正

---

## 影響範囲

| ツール | 影響 | 状態 |
|---|---|---|
| `ep-save` | ❌ execute が呼ばれない | 今回のバグの主犯 |
| `ep-recall` | ❌ 同じパターンで登録 | 同じ問題 |
| `ep-expand` | ❌ 同じパターンで登録 | 同じ問題 |
| [registerContextEngine](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#18-19) | ⚠️ 別のAPI | 要確認（動作している模様） |

---

## エビデンス一覧

1. **OpenClaw公式ドキュメント** (docs.openclaw.ai) — 「Building Plugins」→「Registering agent tools」
2. **GitHubソース** — `openclaw/openclaw` リポ内 `src/plugin-sdk/core.ts`
3. **WSL本体** — `/usr/lib/node_modules/openclaw/dist/plugin-sdk/core.d.ts` で [AnyAgentTool](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/src/tools/common.ts#3-4), [OpenClawPluginApi](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#11-27) 確認
4. **lossless-claw** — 公式プラグインの `index.ts:1289-1317` および `src/tools/*.ts`
5. **ブラウザ録画** — OpenClaw公式サイト＋GitHubリポの調査過程
