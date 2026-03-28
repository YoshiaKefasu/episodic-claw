# compression_analysis_report.md — 監査レポート Round 4

## Audit Report — Round 4
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-25
> Mode: Post-Implementation (Round 3 MED修正後の収束確認)
> Prior audits: 3 | New findings this round: 3

---

### Convergence Status (Prior Round Items)

| Prior Round Issue | Status |
|---|---|
| M-1: Section 4.6 Watcher 自動反映の矛盾 | Resolved |
| M-2: compact() tokensAfter CJK 非対応 | Resolved |
| M-3: compact() isCompacting ガード欠如 | Resolved |
| L-1: buildDateSeq 定義・引数説明欠如 | Still open (低優先・未修正) |
| L-2: sessionFile アトミック書き込み未言及 | Still open (低優先・未修正) |

---

### New Findings — Round 4

3件の genuinely new な問題を発見した。いずれも過去4ラウンドで未指摘の観点である。

---

#### R4-1 [MED] Go側 `EstimateTokens`（rune/3）とTS側 `estimateTokens`（CJK=1.5, ASCII=0.25）の体系的乖離が未分析

**該当箇所:** Section 17.2 末尾注記、Section 7.2、`go/frontmatter/frontmatter.go`

**問題の所在:**

文書は Section 17.2 末尾で「TS側とは実装が異なる点に注意」と一行だけ言及しているが、乖離の**定量的影響範囲**と**下流への波及**を一切分析していない。

Go側:
```go
// rune数 / 3 — CJK・Latin 一律
func EstimateTokens(s string) int { return utf8.RuneCountInString(s) / 3 }
```

TS側:
```typescript
// CJK=1.5tokens/char, ASCII=0.25tokens/char
return Math.ceil(cjk * 1.5 + ascii * 0.25);
```

純CJKテキスト（日本語エピソード本文）での比較:
- 300文字のCJK文字列の場合:
  - Go側: `300 / 3 = 100 tokens`
  - TS側: `300 * 1.5 = 450 tokens`
  - **乖離率: 4.5倍**

純ASCII（英語エピソード本文）での比較:
- 1200文字のASCII文字列の場合:
  - Go側: `1200 / 3 = 400 tokens`
  - TS側: `1200 * 0.25 = 300 tokens`
  - **乖離率: 1.33倍（Go側が過大評価）**

**波及する下流の影響:**

`vstore.Add` に保存される `Tokens` フィールド（Go側推定値）は、将来的な検索スコアリングやバジェット判断に使いうる。現時点で `Tokens` フィールドを直接バジェット制御に使っているコードパスが文書中に明示されていないため、即時障害にはなっていないと思われる。しかし文書が「CJK対応完了」と宣言しながら、Go/TS 二系統の推定値が**最大4.5倍乖離する状態を既知未解決として放置している**点は、将来の機能追加（Tokens-based 検索ランキング等）で silent な精度劣化を引き起こすリスクがある。

**何が不足しているか:**

1. 「なぜ二系統を統一しないか」の設計根拠が記述されていない（Go側を呼ぶRPCコストを避けたいなら、その旨を明記すべき）
2. `Tokens` フィールドがどのコードパスで参照されるかの一覧がない
3. CJKが主体の利用者（日本語会話）と英語利用者で `Tokens` 値の性質が大きく変わることへの注意喚起がない

**推奨アクション:**

Section 17.2 の注記を拡張して以下を追記する:
- 乖離率の定量値（CJK: 最大4.5倍、ASCII: 1.33倍）
- `Tokens` フィールドの現在の利用箇所（参照しているコードパスのリスト）
- 将来的に統一するか否かの設計方針（例:「統計的近似に過ぎず精度保証は不要なため現行二系統を容認」と明言する）

---

#### R4-2 [MED] `assemble()` の `ctx.tokenBudget || 8192` デフォルト値が根拠不明かつモデル規模非対応

**該当箇所:** Section 4.5 `assemble()` 実装コード（line 640）

**問題のコード:**

```typescript
const totalBudget = ctx.tokenBudget || 8192;
const reserveTokens = cfg.reserveTokens ?? 6144;
const maxEpisodicTokens = Math.max(0, totalBudget - reserveTokens);
```

**問題1: デフォルト8192の根拠が記述されていない**

`ctx.tokenBudget` がゼロまたは未定義（OpenClawランタイムが明示的にバジェットを渡さないケース）にフォールバックする値として8192を採用しているが、この根拠が文書中に一切説明されていない。8192は多くのモデルの旧来のコンテキストウィンドウサイズに近いが、2026年時点の主要モデル（Gemini 2.5 Pro: 1M tokens、Claude 3.7: 200k tokens）では当該デフォルトが現実と大幅に乖離する。

**問題2: `maxEpisodicTokens = 0` のサイレントデグレード**

`reserveTokens` の設定デフォルトが6144であり、`totalBudget` がデフォルト8192の場合:
```
maxEpisodicTokens = Math.max(0, 8192 - 6144) = 2048
```
2048トークン分しかエピソードをプロンプトに注入できない。しかも `ctx.tokenBudget` が `0` として渡された場合（エラー状態や特定のOpenClawバージョンでの仕様変更時）:
```
maxEpisodicTokens = Math.max(0, 8192 - 6144) = 2048  // 8192フォールバック
```
もし `ctx.tokenBudget` が `null` や `-1` として渡される場合は:
```
null || 8192  → 8192 (フォールバック動作)
-1 || 8192   → -1  (フォールバックしない！ -1 はtruthy)
```
`-1` が渡った場合: `Math.max(0, -1 - 6144) = 0` → エピソードが**一件も注入されない**がエラーは発生しない。`assemble()` はサイレントに空のコンテキストを返す。

**問題3: 設定の組み合わせ爆発への言及がない**

`totalBudget` と `reserveTokens` の大小関係が逆転した場合（例: ユーザーが `reserveTokens: 200000` を設定ミスで入力）の動作が `Math.max(0, ...)` でゼロになることは実装上防がれているが、文書はこの設定ミスへの警告を一切含まない。

**推奨アクション:**

Section 4.5 の `assemble()` コード例に以下を追記する:
1. `ctx.tokenBudget || 8192` の8192は「最小限のフォールバック値」であり、OpenClawランタイムが正常動作する場合は常に実際のバジェットが渡される旨の注記
2. `reserveTokens >= totalBudget` 時に `maxEpisodicTokens = 0` となりエピソード注入がゼロになることのログ出力または警告の説明
3. `ctx.tokenBudget` の型が `number | undefined` であり、`-1` 等の異常値の扱いについての一言

---

#### R4-3 [LOW] `compact()` Step 3 の初回実行時（watermark未設定時）の動作が未定義

**該当箇所:** Section 4.5 `compact()` 実装コード（Step 3）

**問題のコード:**

```typescript
const wm = await rpcClient.getWatermark(resolvedAgentWs); // { dateSeq, absIndex }
const unprocessed = allMsgs.slice(wm.absIndex + 1);
```

**問題:**

プラグインの初回起動直後（Pebble DB にウォーターマークが一度も書き込まれていない状態）で `compact()` が発火した場合、`getWatermark` RPC の返り値が何になるかが文書中に記述されていない。

考えられるケース:
- `null` が返る場合: `null.absIndex + 1` → TypeScript ランタイムエラー（TypeError）
- `{ dateSeq: "", absIndex: -1 }` などのゼロ値が返る場合: `allMsgs.slice(0)` → 全メッセージをbatchIngestする（これは意図した動作かもしれないが、明示されていない）
- `{ dateSeq: "", absIndex: 0 }` が返る場合: `allMsgs.slice(1)` → 最初のメッセージが飛ばされてギャップが生まれる

Section 4.0 ロードマップには `getWatermark` / `setWatermark` の実装は記述されているが、**未設定時のデフォルト値（初期値のセマンティクス）**が文書のいかなる箇所にも明記されていない。

これは Section 4.1「Genesis Gap」のユースケース（初回導入時）と直接交差する重大な境界条件であるにもかかわらず、Genesis Gap の説明（Phase 4.1）はギャップが「50件超」の場合のFire-and-Forgetのみを論じており、初回 `compact()` 発火時の `wm.absIndex` の初期値が何になるかに触れていない。

**推奨アクション:**

Section 4.5 の Step 3 注記、または Section 4.0 の `meta:watermark` 説明に以下を追記する:
- Go側 `handleGetWatermark` が watermark 未設定時に返す値（例: `{ dateSeq: "init", absIndex: -1 }`）
- TS側での `wm` のnullガード（`wm ?? { dateSeq: "", absIndex: -1 }`）の有無
- 初回起動時に `absIndex: -1` → `slice(0)` → 全メッセージをbatchIngest が**意図したフォールスルー動作**であることの確認と明示

このissueは LOW 分類だが、初回起動 → コンテキストウィンドウ超過 → `compact()` 即発火という順序は**Phase 5.5 テストシナリオ**（現在 `[ ]` 未完了）で踏む可能性が高く、早期に文書化すべき。

---

### Summary Table — Round 4 New Findings

| ID | Severity | Section | Issue | Action Required |
|---|---|---|---|---|
| R4-1 | MED | Section 17.2 | Go/TS `EstimateTokens` 乖離の定量影響分析が欠如 | Section 17.2 注記を拡張して乖離率・波及範囲・設計方針を明記 |
| R4-2 | MED | Section 4.5 | `ctx.tokenBudget \|\| 8192` の根拠未記述・`-1` 等異常値でサイレントゼロ注入 | assemble() コード例にデフォルト値の根拠と異常値挙動を注記 |
| R4-3 | LOW | Section 4.5 / 4.0 | `getWatermark` 初回返り値（未設定時）が未定義 | watermark初期値のセマンティクスとnullガードの有無を明記 |

---

### Recommended Actions

| Priority | Action | Reason | Is New? |
|---|---|---|---|
| MED | Section 17.2 に Go/TS `EstimateTokens` 乖離率（CJK: 最大4.5倍）・参照コードパス・設計方針を追記 | `Tokens` フィールドの一貫性への信頼性担保。将来の機能拡張（Tokens-based ranking等）での silent degradation 予防 | Yes (R4-1) |
| MED | Section 4.5 `assemble()` コード例に `tokenBudget` デフォルト8192の根拠・異常値挙動（-1でゼロ注入）の警告を追記 | サイレントなエピソードゼロ注入が診断不能なまま発生するリスクの明示 | Yes (R4-2) |
| LOW | Section 4.0 または 4.5 Step 3 に watermark 初回未設定時の返り値・nullガード有無を追記 | Phase 5.5 テスト未完了シナリオで踏む可能性が高い境界条件の文書化 | Yes (R4-3) |
| LOW | L-1: `buildDateSeq` 定義・引数説明の追記 | 前ラウンドからの未修正課題（低優先） | No (carryover) |
| LOW | L-2: `compact()` sessionFile アトミック書き込みの明示 | 前ラウンドからの未修正課題（低優先） | No (carryover) |

---

### Convergence Assessment

Round 4 では MED 2件・LOW 1件を新規発見。BLOCKERおよびHIGHは存在しない。

過去4ラウンドでの修正済み累計（Bias Mitigation に従いカウント）:
- Round 1: 6件（HIGH×2, MED×2, LOW×2）
- Round 2: 11件（HIGH×3, MED×4, LOW×4）
- Round 3: 5件（MED×3, LOW×2 — うち3件修正済み、2件LOW未修正carryover）
- Round 4: 3件（MED×2, LOW×1）— 新規発見

R4-1 と R4-2 は文書の加筆（数行の注記）で解決可能。R4-3 は実装確認が必要な境界条件。いずれも系統的な設計上の欠陥ではなく、文書の説明粒度の問題である。

**次回 Round 5 の判断基準:** R4-1〜R4-3 の追記対応後、新規発見が3件未満であれば `Document has converged.` と宣言してよい。
