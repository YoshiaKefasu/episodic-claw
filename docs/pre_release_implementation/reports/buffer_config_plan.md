# episodic-claw — バッファサイズ設定化 実装プラン

> 作成日: 2026-03-26
> 対象バージョン: episodic-claw Phase 5.7+
> 目的: `MAX_BUFFER_CHARS` と `MAX_CHARS_PER_CHUNK` をデフォルト値変更し、openclaw.json 経由でユーザー設定可能にする

---

## 1. 背景・目的

### 現状の問題

`segmenter.ts` の以下の定数がハードコードされており、ユーザーが環境に合わせて調整できない:

| 定数 | 現在の値 | 場所 | 役割 |
|---|---|---|---|
| `MAX_BUFFER_CHARS` | 12,000 字 | `processTurn()` ローカル定数 | buffer のサイズ上限 flush トリガー |
| `MAX_CHARS_PER_CHUNK` | 10,000 字 | `chunkAndIngest()` ローカル定数 | batchIngest に送る1チャンクの最大サイズ |

### 変更後のデフォルト値

| 定数 | 旧デフォルト | 新デフォルト | 根拠 |
|---|---|---|---|
| `maxBufferChars` | 12,000 字 | **7,200 字** | ~24 ターン相当。セッション境界ギャップリスクを現在の 60% に縮小。`maxCharsPerChunk` 未満なのでチャンク分割なし = 1 flush = 1 エピソード |
| `maxCharsPerChunk` | 10,000 字 | **9,000 字** | `maxBufferChars` のデフォルト(7,200)より大きいため通常は chunking が発生しない。ユーザーが `maxBufferChars > 9,000` に設定した場合のみ chunking が走る |

### `maxBufferChars ≤ maxCharsPerChunk` の設計関係

```
maxBufferChars = 7,200 < maxCharsPerChunk = 9,000
→ buffer flush 時のデータは常に 1 チャンク内に収まる
→ chunkAndIngest は chunking ループを実行せず 1 エピソードを直接生成
→ OVERLAP_MESSAGES による重複保存が発生しない（チャンク分割がないため）
```

この関係が逆転した場合 (`maxBufferChars > maxCharsPerChunk`) は chunking が発生する。これは有効な設定だが、HNSW インデックスに重複ベクトルが増える点をユーザーに周知する。

---

## 2. 変更ファイル一覧

| ファイル | 変更内容 | 変更規模 |
|---|---|---|
| `src/types.ts` | `EpisodicPluginConfig` に `maxBufferChars?`, `maxCharsPerChunk?` 追加 | 4 行 |
| `src/config.ts` | `loadConfig()` にデフォルト値追加 | 2 行 |
| `src/segmenter.ts` | コンストラクタ引数追加、ローカル定数をインスタンスプロパティに昇格、`summarizeBuffer` 内の旧値コメント更新 | 10 行 |
| `src/index.ts` | `EventSegmenter(rpcClient, ...)` 呼び出しに引数追加 | 1 行 |
| `openclaw.plugin.json` | `configSchema` に `maxBufferChars`, `maxCharsPerChunk` プロパティ追加 | 8 行 |

---

## 3. 詳細変更仕様

### 3.1 `src/types.ts`

```typescript
export interface EpisodicPluginConfig {
  sharedEpisodesDir?: string;
  allowCrossAgentRecall: boolean;
  reserveTokens?: number;
  recentKeep?: number;
  dedupWindow?: number;
  /** buffer サイズ上限 flush トリガー（文字数）。デフォルト 7,200。
   *  Surprise が上がらない単調な会話でも、この値を超えると強制 flush される。
   *  maxCharsPerChunk 未満に設定することで chunking なし = 1 flush = 1 エピソードになる。 */
  maxBufferChars?: number;
  /** batchIngest に送る 1 チャンクの最大文字数。デフォルト 9,000。
   *  maxBufferChars 以下に設定すると chunking が発生し、1 flush が複数エピソードに分割される。 */
  maxCharsPerChunk?: number;
}
```

### 3.2 `src/config.ts`

```typescript
export function loadConfig(rawConfig: any): EpisodicPluginConfig {
  return {
    sharedEpisodesDir: rawConfig?.sharedEpisodesDir,
    allowCrossAgentRecall: rawConfig?.allowCrossAgentRecall ?? true,
    reserveTokens: rawConfig?.reserveTokens ?? 6144,
    recentKeep: rawConfig?.recentKeep ?? 30,
    dedupWindow: rawConfig?.dedupWindow ?? 5,
    maxBufferChars: rawConfig?.maxBufferChars ?? 7200,
    maxCharsPerChunk: rawConfig?.maxCharsPerChunk ?? 9000,
  };
}
```

### 3.3 `src/segmenter.ts` — EventSegmenter クラス

**コンストラクタ変更:**
```typescript
export class EventSegmenter {
  private buffer: Message[] = [];
  private rpc: EpisodicCoreClient;
  private surpriseThreshold = 0.2;
  private lastProcessedLength = 0;
  private dedupWindow: number;
  private maxBufferChars: number;    // 追加
  private maxCharsPerChunk: number;  // 追加

  constructor(rpc: EpisodicCoreClient, dedupWindow = 5, maxBufferChars = 7200, maxCharsPerChunk = 9000) {
    this.rpc = rpc;
    this.dedupWindow = dedupWindow;
    this.maxBufferChars = maxBufferChars;
    this.maxCharsPerChunk = maxCharsPerChunk;
  }
```

**`processTurn()` 変更:**
```typescript
// 変更前
const MAX_BUFFER_CHARS = 12000;
if (surprise > this.surpriseThreshold || estimatedChars > MAX_BUFFER_CHARS) {

// 変更後
if (surprise > this.surpriseThreshold || estimatedChars > this.maxBufferChars) {
```

**`chunkAndIngest()` 変更:**
```typescript
// 変更前
const MAX_CHARS_PER_CHUNK = 10000;

// 変更後
const MAX_CHARS_PER_CHUNK = this.maxCharsPerChunk;
```

### 3.4 `src/index.ts`

```typescript
// 変更前
const segmenter = new EventSegmenter(rpcClient, cfg.dedupWindow ?? 5);

// 変更後
const segmenter = new EventSegmenter(
  rpcClient,
  cfg.dedupWindow ?? 5,
  cfg.maxBufferChars ?? 7200,
  cfg.maxCharsPerChunk ?? 9000
);
```

### 3.5 `openclaw.plugin.json`

> ⚠️ **実装方針: ファイル全体を以下の内容で置き換える。**
> `additionalProperties: false` のまま `properties` に追記のみを行うと、
> `reserveTokens`・`recentKeep`・`dedupWindow` などの既存設定フィールドが
> スキーマ違反となり OpenClaw のバリデーターに拒否されるリスクがある。
> 全フィールドをスキーマに明示することで解決する。

```json
{
  "id": "episodic-claw",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean" },
      "reserveTokens": {
        "type": "integer",
        "description": "システムプロンプトに注入するエピソード記憶の最大トークン数（デフォルト 6144）"
      },
      "recentKeep": {
        "type": "integer",
        "description": "コンパクション時に保持する最近のターン数（デフォルト 30）"
      },
      "dedupWindow": {
        "type": "integer",
        "description": "フォールバック連発時の重複除去ウィンドウサイズ（デフォルト 5）。高頻度フォールバック環境では 10 以上を推奨"
      },
      "maxBufferChars": {
        "type": "integer",
        "minimum": 500,
        "description": "buffer サイズ上限 flush トリガー（文字数、デフォルト 7200）。この値を超えると Surprise に関わらず強制 flush される。maxCharsPerChunk より大きい値に設定すると chunking が発生する（1 flush = 複数エピソード）。500 未満は非推奨"
      },
      "maxCharsPerChunk": {
        "type": "integer",
        "minimum": 500,
        "description": "batchIngest に送る 1 チャンクの最大文字数（デフォルト 9000）。maxBufferChars より大きい値に設定すると chunking が発生しない（1 flush = 1 エピソード）。maxBufferChars 以下に設定すると 1 flush が複数エピソードに分割される。500 未満は非推奨"
      }
    }
  }
}
```

### ユーザー設定例（openclaw.json）

```json
{
  "plugins": {
    "episodic-claw": {
      "maxBufferChars": 7200,
      "maxCharsPerChunk": 9000
    }
  }
}
```

---

## 4. 影響分析

### 4.1 既存動作への影響

| 動作 | 変更前 | 変更後 | 影響 |
|---|---|---|---|
| size-limit flush の頻度 | ~40 ターンに 1 回 | ~24 ターンに 1 回 | エピソード生成頻度 1.7 倍増 |
| chunking 発生 | buffer > 10,000字 で発生 | buffer > 9,000字 で発生（デフォルト設定では実質なし）| デフォルトでは OVERLAP_MESSAGES 重複ゼロ |
| session_boundary_gap リスク | 最大 12,000字 の消失リスク | 最大 7,200字 の消失リスク | リスク 40% 低減 |
| HNSW インデックス成長速度 | 基準 | 1.7 倍 | 長期運用でインデックス肥大化の可能性 |

### 4.2 後方互換性

- `loadConfig()` の `?? 7200` / `?? 9000` フォールバックにより、既存ユーザーの設定ファイルに追記がなくても動作する
- 旧デフォルト（12,000/10,000）を維持したいユーザーは openclaw.json に明示的に指定する

### 4.3 バリデーション

現時点では `maxBufferChars > maxCharsPerChunk` の場合の警告は実装しない（chunking が発生するだけで機能は継続する）。
Phase 3 で `loadConfig()` にバリデーションレイヤーを追加することを検討する。

---

## 5. テストケース

### TC-BUF-1: デフォルト動作の確認
1. openclaw.json に `maxBufferChars`/`maxCharsPerChunk` を指定しない
2. `EventSegmenter` が `maxBufferChars=7200`, `maxCharsPerChunk=9000` で初期化されることをログで確認
3. 7,200字を超える buffer で size-limit flush が発生することを確認

### TC-BUF-2: ユーザー設定の上書き確認
1. openclaw.json に `"maxBufferChars": 5000, "maxCharsPerChunk": 8000` を設定
2. `loadConfig()` が正しく 5000/8000 を返すことをユニットテストで確認
3. 5,000字での size-limit flush を確認

### TC-BUF-3: `maxBufferChars > maxCharsPerChunk` の動作（chunking 発生）
1. `maxBufferChars=15000`, `maxCharsPerChunk=5000` を設定
2. 15,000字の buffer で flush 時に 3 チャンク（+overlap）が生成されることを確認
3. batchIngest に 3 items が送られることをモックで確認

### TC-BUF-4: 旧デフォルト値への復元
1. openclaw.json に `"maxBufferChars": 12000, "maxCharsPerChunk": 10000` を設定
2. 旧動作と同一になることを確認（後方互換性テスト）

---

## 6. 実装順序

```
Step 1: src/types.ts         — EpisodicPluginConfig にフィールド追加
Step 2: src/config.ts        — loadConfig() にデフォルト値追加
Step 3: src/segmenter.ts     — コンストラクタ + ローカル定数をプロパティに昇格
                               + summarizeBuffer の旧値コメント (MAX_CHARS_PER_CHUNK = 10,000) を更新
Step 4: src/index.ts         — EventSegmenter 呼び出し更新（二重フォールバック ?? は省略）
Step 5: openclaw.plugin.json — ファイル全体を置き換え（全フィールドをスキーマに明示）
         ※ 追加発見: sharedEpisodesDir・allowCrossAgentRecall もスキーマ未登録のため同時に追加（Section 8 参照）
Step 6: ビルド確認 (npm run build:ts) — 型エラー 0 件を成功基準とする
Step 7: WSL デプロイ
```

---

## 8. 追加修正: スキーマ未登録フィールドの一括登録

> 実装中に発見。Round 1 監査の HIGH 対応（openclaw.plugin.json 全体置き換え方針）の調査過程で判明。

### 発見されたスキーマ違反フィールド

`additionalProperties: false` の下、以下の 2 フィールドが `loadConfig()` に存在するがスキーマに未登録だった:

| フィールド | 型 | loadConfig() | openclaw.plugin.json | 実際の動作 |
|---|---|---|---|---|
| `sharedEpisodesDir` | `string` | ✅ 解析済み | ❌ → ✅ 追加済み | ⚠️ 未実装（Phase 3 予定） |
| `allowCrossAgentRecall` | `boolean` (デフォルト `true`) | ✅ 解析済み | ❌ → ✅ 追加済み | ⚠️ 未実装（Phase 3 予定） |

### 追加後の `openclaw.plugin.json` フィールド一覧（完全版）

| フィールド | 型 | デフォルト | 実装状態 |
|---|---|---|---|
| `enabled` | boolean | — | ✅ 実装済み |
| `sharedEpisodesDir` | string | なし | ⚠️ Phase 3 予定 |
| `allowCrossAgentRecall` | boolean | `true` | ⚠️ Phase 3 予定 |
| `reserveTokens` | integer | 6144 | ✅ 実装済み |
| `recentKeep` | integer | 30 | ✅ 実装済み |
| `dedupWindow` | integer | 5 | ✅ 実装済み |
| `maxBufferChars` | integer (min: 500) | 7200 | ✅ 実装済み |
| `maxCharsPerChunk` | integer (min: 500) | 9000 | ✅ 実装済み |

### 注記

`sharedEpisodesDir` と `allowCrossAgentRecall` は現在 `index.ts`・`retriever.ts`・`compactor.ts` いずれにも参照がなく、`loadConfig()` で解析されるが値が利用されない。スキーマに登録することでユーザーがバリデーションエラーなしに設定できるようになるが、機能的な効果は Phase 3 実装後まで持たない。

---

## 9. 関連ドキュメント

- [`docs/session_boundary_gap_report.md`](./session_boundary_gap_report.md) — MAX_BUFFER_CHARS の役割と session boundary gap
- [`docs/model_fallback_impact_report.md`](./model_fallback_impact_report.md) — dedupWindow 設定化（同一パターンの先行実装）
- [`docs/compression_analysis_report.md`](./compression_analysis_report.md) Section 19 — Phase 5.7 実装ステータス

---

*本ドキュメントは実装前のプランフェーズ。実装前に md-auditor による監査を実施する。*

---

## 🔍 Audit Report — Round 1 (Pre-Implementation)
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-26
> Mode: Pre-Implementation
> New findings: 5

### ⚠️ Impact on Related Features

**`forceFlush` 経路への影響（問題なし・確認済み）**
`forceFlush()` は `chunkAndIngest()` を直接 `await` で呼び出す。プランが `chunkAndIngest` 内の `const MAX_CHARS_PER_CHUNK = 10000` を `this.maxCharsPerChunk` に変更するため、`forceFlush` 経由のチャンク分割も自動的に新しい設定値を参照する。追加変更は不要。

**`summarizeBuffer` のインラインコメントとの不整合（MED）**
`segmenter.ts` L.234 のコメントに `MAX_CHARS_PER_CHUNK = 10,000` という旧値がハードコードで記載されている（`// ⚠️ トークン上限リスク: MAX_CHARS_PER_CHUNK = 10,000 文字`）。プランはこのコメントの更新を変更ファイル一覧（Section 2）に含めていない。機能への影響はないが、将来の保守者を誤誘導する。

**`Compactor` への影響（問題なし）**
`index.ts` L.92 の `new Compactor(rpcClient, segmenter, cfg.recentKeep ?? 30)` は `EventSegmenter` インスタンスを受け取る。コンストラクタ引数の追加はインスタンスの外部インタフェースを変えないため `Compactor` への影響はない。

### 🚨 Potential Problems & Risks

**[HIGH] `openclaw.plugin.json` の `additionalProperties: false` と既存フィールドの欠落**

現行の `openclaw.plugin.json` の `configSchema.properties` には `enabled` のみが存在し、`reserveTokens`・`recentKeep`・`dedupWindow` はスキーマ定義されていない。`additionalProperties: false` が有効なため、ホスト側（OpenClaw）がこのスキーマを使ってユーザーの `openclaw.json` をバリデーションする場合、これらのフィールドが拒否されるリスクがある。

プランの Section 3.5 は `reserveTokens`・`recentKeep`・`dedupWindow` を含む完全な `configSchema` スニペットを示しているが、これが **"既存ファイルを完全に置き換える"** のか **"プロパティを追記する"** のかが明記されていない。実装者が「2フィールドのみ追加」と解釈した場合、`maxBufferChars`/`maxCharsPerChunk` だけが追加され、他の 3 フィールドは依然としてスキーマ外のままになる。その状態でバリデーションが走ると `loadConfig()` が正しく設定値を受け取れなくなる。

**[MED] 極端な値に対するバリデーション不在**

`maxBufferChars: 0` や `maxBufferChars: 1` に設定した場合、`estimatedChars > this.maxBufferChars` が常に `true` となり、全ターンで強制 flush が発生する。会話の都度エピソードが生成され、HNSW インデックスが急速に肥大化する。`maxCharsPerChunk: 1` では batchIngest にメッセージ数と同数の items が一度に送られる。プランは Section 4.3 でバリデーションを Phase 3 に先送りしているが、最小値チェック（例: `>= 500`）程度の防護はコスト・ゼロで追加できる。

**[MED] `maxCharsPerChunk` の description 文が読者に逆の印象を与える**

Section 3.5 の `openclaw.plugin.json` スニペット内の description:
`"maxBufferChars を超える値に設定すると chunking が発生しなくなる"`

論理的には正しい（`maxCharsPerChunk > maxBufferChars` → chunking なし）が、主語が `maxCharsPerChunk` で比較対象が `maxBufferChars` であるため、初見の読者は「`maxCharsPerChunk` を大きくすると chunking が起きなくなる」という方向感が掴みにくい。Section 1 の設計関係の説明（`maxBufferChars < maxCharsPerChunk` → 1 flush = 1 エピソード）と表現が乖離しており、ユーザー混乱を招く可能性がある。

### 📋 Missing Steps & Considerations

**Section 2 の変更ファイル一覧に `segmenter.ts` のコメント更新が欠落**
`summarizeBuffer` 内の `MAX_CHARS_PER_CHUNK = 10,000` 旧値コメントの更新は、変更ファイル一覧（Section 2）および実装順序（Section 6）に記載がない。担当者がこの箇所を見落とす可能性がある。

**Section 3.5 の変更方針の明記**
`openclaw.plugin.json` の変更が「ファイル全体の置き換え」か「properties への追記」かを明示すること。現状のスニペット形式では実装者が判断を誤るリスクがある。特に `additionalProperties: false` の存在と既存フィールドの欠落問題（上記 HIGH 参照）と合わせると、方針の曖昧さが直接的な障害になりうる。

**Step 6 `npm run build:ts` の成功基準が未定義**
実装順序（Section 6）の Step 6 にビルド確認が記載されているが、型チェックエラーが 0 件であること以外の成功基準（例: `EventSegmenter` コンストラクタ引数の型チェックが通ること、既存テストが通ること）が明記されていない。

### 🕳️ Unaddressed Edge Cases

**`maxBufferChars` と `maxCharsPerChunk` を両方 0 または両方同値に設定した場合**
`maxBufferChars === maxCharsPerChunk` のとき、`chunkAndIngest` の条件 `currentLen + text.length > MAX_CHARS_PER_CHUNK` がバッファ満杯と同時に成立し、単一メッセージが limit ちょうどのケースで chunking の分割点が境界値付近で不安定になる。プランはこのケースを考慮していない。

**ユーザーが `maxBufferChars` のみ設定し `maxCharsPerChunk` を省略した場合の相対関係の変化**
例: `maxBufferChars: 12000`（旧デフォルト復元）、`maxCharsPerChunk` は省略（デフォルト 9000）。この組み合わせでは `maxBufferChars > maxCharsPerChunk` となり chunking が発生する。プランは Section 1 でこの逆転ケースを言及しているが、`openclaw.plugin.json` の description にその警告が反映されていない。ユーザーが片方だけを設定した場合の挙動説明が不足している。

**`index.ts` L.73 の二重フォールバックの冗長性**
プラン Section 3.4 の変更後コード: `cfg.maxBufferChars ?? 7200` — `loadConfig()` が既に `?? 7200` を保証しているため、`cfg.maxBufferChars` が `undefined` になることはない。機能上の問題はないが、コードの意図が不明確になる。

### ✅ Recommended Actions

| Priority | Action | Reason | Is New? |
|---|---|---|---|
| HIGH | `openclaw.plugin.json` の変更方針を「ファイル全体置き換え」と明記し、`reserveTokens`・`recentKeep`・`dedupWindow` を Section 3.5 スニペットに含める（または含まない場合は `additionalProperties` を `true` に変更する理由を説明する） | `additionalProperties: false` のままで既存フィールドをスキーマ外に放置すると、ホスト側バリデーションで `loadConfig()` が設定値を受け取れなくなる | Yes |
| MED | `segmenter.ts` L.234 の `MAX_CHARS_PER_CHUNK = 10,000` 旧値コメントの更新を Section 2（変更ファイル一覧）と Section 6（実装順序）に追加する | 担当者がこの箇所を見落とした場合、将来の保守者が誤った値を参照し続ける | Yes |
| MED | `maxCharsPerChunk` の description を `"maxBufferChars より大きい値に設定すると chunking が発生しない（1 flush = 1 エピソード）。小さい値にすると 1 flush が複数エピソードに分割される"` に書き直す | 現状の表現では方向感が掴みにくく、ユーザーが逆の設定をするリスクがある | Yes |
| MED | `maxBufferChars` と `maxCharsPerChunk` の両方に最小値の注記を追加する（例: `minimum: 500`）。Phase 3 の本格バリデーションとは別に、`loadConfig()` で `Math.max(500, value)` 程度のガード追加を検討する | 極端値での全ターン強制 flush・batchIngest 過負荷のリスクを最小コストで抑える | Yes |
| LOW | `index.ts` の `cfg.maxBufferChars ?? 7200` を `cfg.maxBufferChars` に簡略化する（`loadConfig()` の保証を信頼する） | コードの冗長性除去・意図の明確化 | Yes |

<!-- BLOCKER/HIGH の数: 1件（HIGH のみ） — Convergence Rule により実装可能と判定 -->
✅ プランは実装可能です。HIGH 項目（openclaw.plugin.json の変更方針明記）を確認してから実装を進めてください。

---

## 🔍 Audit Report — Round 2 (Post-Implementation)
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-26
> Mode: Post-Implementation
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status（Round 1 → Round 2）

| Round 1 Issue | Status | 根拠 |
|---|---|---|
| HIGH: openclaw.plugin.json 変更方針の明記 | ✅ Resolved | Section 3.5 冒頭に「ファイル全体を以下の内容で置き換える」と明記済み。実際の openclaw.plugin.json も全 8 フィールドを含む完全版に置き換えられており、additionalProperties: false 下でのスキーマ欠落リスクは解消 |
| MED: summarizeBuffer コメント更新 | ✅ Resolved | Section 6 の実装順序 Step 3 に「summarizeBuffer の旧値コメント (MAX_CHARS_PER_CHUNK = 10,000) を更新」と明記され、実装担当者への周知が確保された |
| MED: maxCharsPerChunk description 修正 | ✅ Resolved | openclaw.plugin.json L.36 の description が「maxBufferChars より大きい値に設定すると chunking が発生しない（1 flush = 1 エピソード）。maxBufferChars 以下に設定すると 1 flush が複数エピソードに分割される」に改訂され、Round 1 推奨表現と実質一致 |
| MED: 最小値バリデーション | ✅ Resolved | openclaw.plugin.json の両フィールドに minimum: 500 を追加。加えて config.ts で Math.max(500, ...) による実行時ガードが実装されており、スキーマバリデーションと実行時防護の二重防御が実現（プランの Section 3.2 スニペットを超えた強化実装） |
| LOW: index.ts 二重フォールバック冗長性 | ✅ Resolved | Section 6 Step 4 に「二重フォールバック ?? は省略」と明記され、loadConfig() の保証を信頼する設計意図が文書化された |

### 📋 Section 8 追加修正（sharedEpisodesDir / allowCrossAgentRecall）検証

Round 2 時点での全フィールド整合性チェック結果:

| フィールド | types.ts | loadConfig() | openclaw.plugin.json | 判定 |
|---|---|---|---|---|
| sharedEpisodesDir | string? | 解析済み（デフォルトなし） | string 型・description 付き | ✅ |
| allowCrossAgentRecall | boolean（non-optional） | ?? true | boolean 型・description 付き | ✅ |
| reserveTokens | number? | ?? 6144 | integer 型 | ✅ |
| recentKeep | number? | ?? 30 | integer 型 | ✅ |
| dedupWindow | number? | ?? 5 | integer 型 | ✅ |
| maxBufferChars | number? | Math.max(500, ?? 7200) | integer・minimum: 500 | ✅ |
| maxCharsPerChunk | number? | Math.max(500, ?? 9000) | integer・minimum: 500 | ✅ |
| enabled | 非存在 | 非存在 | boolean 型 | ✅（OpenClaw 予約フィールド） |

全フィールドで types.ts / config.ts / openclaw.plugin.json の三者が整合していることを確認。

### 観察事項（機能的問題なし・記録のみ）

**config.ts の Math.max() 実装はプランの Section 3.2 スニペットを超えた強化**
Section 3.2 のコードスニペットには `rawConfig?.maxBufferChars ?? 7200` のみ記載されているが、実際の実装は `Math.max(500, rawConfig?.maxBufferChars ?? 7200)` となっている。Round 1 MED（最小値バリデーション）の解決策として採用されたと判断できる。仕様書とコードの微細な差分だが、機能的には改善であり問題なし。

**allowCrossAgentRecall のスキーマ default 宣言の省略**
types.ts の allowCrossAgentRecall は boolean（non-optional）で、loadConfig() が `?? true` でデフォルトを補完する。openclaw.plugin.json の当該プロパティには JSON Schema の `default: true` キーワードが記載されていないが、JSON Schema の `default` は情報提供的なものであり、OpenClaw のバリデーターが強制しない限り動作に影響しない。記録のみ。

<!-- 新規発見なし → -->
✅ No new critical issues found. Document has converged.
