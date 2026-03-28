# compression_analysis_report.md — 監査レポート Round 5

## Audit Report — Round 5
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-25
> Mode: Post-Implementation (Round 4 MED修正後の収束確認)
> Prior audits: 4 | New findings this round: 3

---

### Convergence Status (Prior Round Items)

| Prior Round Issue | Status |
|---|---|
| R4-1: Go/TS EstimateTokens 乖離の定量影響分析 | Resolved — Section 17.2 末尾に純CJK最大4.5倍・純ASCII約1.33倍の定量値と、`Tokens` フィールドがスコアリング未使用である設計方針が明記された |
| R4-2: tokenBudget \|\| 8192 の根拠未記述・-1 等異常値 | Resolved — Section 4.5 assemble() コードブロックに「8192はOpenClawが渡さない異常時のフォールバック値（設計上は常に実値が渡る）」旨の注記、および `ctx.tokenBudget が -1` の場合に truthy 判定で 8192 フォールバックしない警告が追記された |
| R4-3: getWatermark 初回返り値未定義 | Still open (低優先・未修正) |
| L-1: buildDateSeq 定義欠如 | Still open (低優先・未修正) |
| L-2: sessionFile アトミック書き込み未言及 | Still open (低優先・未修正) |

---

### New Findings — Round 5

#### N5-1 [MED] — Section 4.5: `this.recentKeep` がアロー関数内で参照されており undefined になる（コード例がバグパターンを示している）

**該当箇所:** Section 4.5 `compact()` コードブロック Step 5（行693）

```typescript
const keptMessages = allMsgs.slice(-this.recentKeep);
```

**問題の詳細:**

`api.registerContextEngine("episodic-claw", () => ({ ... }))` の構造はアロー関数ファクトリである。アロー関数は `this` をレキシカルスコープから継承するため、ネストしたオブジェクトリテラル内の `compact()` メソッドにおいて `this` はクラスインスタンスを指さない。JavaScript の仕様上、`this.recentKeep` は `undefined` となり、`allMsgs.slice(-undefined)` は `allMsgs.slice(0)` と等価（全件返却）になる。

文書はこのコードを「核心ロジックの簡略版」と注記しているが、`this.recentKeep` という参照がそのまま掲載されている点が問題である。読者が実装時にそのまま踏襲すると、Preserve Recent Turns ガードが機能せず全メッセージが残留するバグを再現する。

**IBM/Google Pro Engineer 視点での評価:**

「簡略版」の注記はあるが、動作しないコードを技術文書のコード例として掲載することは有害な先例（Harmful Example）である。正しい参照方法（例: クロージャ変数 `const recentKeep = Math.max(cfg.recentKeep ?? 30, 15);` をファクトリスコープで定義して参照する）を示すか、少なくとも「この参照は本実装では `compactor.ts` 内のクロージャ変数として保持する」旨の注記が必要。

**対応方針:** 当該行に「本実装では `this` ではなくクロージャスコープの変数で保持する（アロー関数内の `this` は機能しない）」旨の注記を追加する。または疑似コードであることを明示する。

---

#### N5-2 [MED] — Section 4.5: `setWatermark` が compact() 内で2回呼ばれる設計の意図が文書に説明されていない

**該当箇所:** Section 4.5 `compact()` コードブロック Step 3（行680-683）および Step 6（行701-704）

**Step 3 の呼び出し:**
```typescript
await rpcClient.setWatermark({
  dateSeq: buildDateSeq(unprocessed.length), // e.g. "20260316-347"
  absIndex: allMsgs.length - 1,
});
```

**Step 6 の呼び出し:**
```typescript
await rpcClient.setWatermark({
  dateSeq: `${today}-${session.messages.length - 1}`,
  absIndex: session.messages.length - 1,  // 新配列の末尾
});
```

**問題の詳細:**

Step 3 で `absIndex: allMsgs.length - 1`（例: 500件なら499）を書き込んだ直後、Step 5 でセッションが `[indexMessage, ...keptMessages]`（例: 31件）に書き換えられ、Step 6 で `absIndex: session.messages.length - 1`（例: 30）に上書きされる。

Step 3 の `setWatermark` 呼び出しは Step 6 で常に上書きされるため、以下の問題が生じる：

1. **冗長な書き込み:** Step 3 の `setWatermark` は Step 6 で必ず上書きされるため、Pebble への書き込みが1回余分に発生する。
2. **意図の不明確性:** Step 3 の `absIndex: allMsgs.length - 1` は「元のセッション全件を ingested 済み」として記録する意図と読めるが、その直後の Step 6 で `session.messages.length - 1`（書き換え後の配列末尾）に上書きするのは論理が逆転している。Step 6 が正しい最終状態であるなら、Step 3 の setWatermark は何のために存在するか文書に説明がない。
3. **クラッシュ安全性の欠如:** Step 3 の setWatermark 後、Step 6 の setWatermark 前にプロセスがクラッシュした場合、absIndex は元配列末尾（499）を指すが、セッションファイルは書き換え後（31件）になっている。次回 compact() 時の `allMsgs.slice(wm.absIndex + 1)` は `slice(500)` で空配列となり、gap が正しく検出されない可能性がある。

**IBM/Google Pro Engineer 視点での評価:**

Step 3 の `setWatermark` は「batchIngest 成功後に中間チェックポイントを打つ」意図であれば設計として成立するが、その意図が文書に一切記述されていない。また Step 5 と Step 6 の間の非原子的な状態遷移（setWatermark → writeFile → setWatermark の3ステップ）はクラッシュ安全性の観点から説明が必要。

**対応方針:** Step 3 の `setWatermark` の目的（中間チェックポイントか、単なる冗長コードか）を明記する。また Step 3-6 間のクラッシュ発生時の動作（次回 compact() での自己修復経路）を注記する。

---

#### N5-3 [LOW] — Section 4.3: 誤字・誤記が2箇所（「均術」「回話量」）

**該当箇所:** Section 4.3 Episode のファイルパス標準 の説明文（行261）

```
- 最大ディレクトリ掴み: 1日あたり30ファイル程度均術（回話量による）
```

**問題の詳細:**

- 「均術」は「均衡」または「程度」の誤字と思われる。
- 「回話量」は「会話量」の誤字。

技術文書として品質に影響する。特に外部公開（Phase 6: README, npm publish）を控えた段階では修正が望ましい。

**対応方針:** 正しい表記（例: 「1日あたり30ファイル程度（会話量による）」）に修正する。

---

### Summary Table — Round 5 New Findings

| ID | Severity | Section | Issue | Action Required |
|---|---|---|---|---|
| N5-1 | MED | 4.5 compact() Step 5 | `this.recentKeep` がアロー関数内で `undefined` になるバグパターンをコード例が示している | コード例に「アロー関数内の `this` は機能しない／本実装はクロージャ変数を使用する」旨の注記を追加するか疑似コードと明示する |
| N5-2 | MED | 4.5 compact() Step 3/6 | `setWatermark` が2回呼ばれる設計の意図・クラッシュ安全性が文書に未説明 | Step 3 の setWatermark の目的（中間チェックポイントか冗長か）と、Step 3-6 間クラッシュ時の自己修復経路を注記する |
| N5-3 | LOW | 4.3 Episode ファイルパス標準 | 「均術」「回話量」の誤字 | 「（会話量による）」に修正する |

---

### Convergence Assessment

**Verdict: Not yet fully converged — 2 MED issues remain.**

R4-1 および R4-2 の修正は正確に実施されており、対象箇所の記述品質は向上している。

しかし今回 Section 4.5 の compact() コードブロックに2件の MED 問題が新たに特定された。いずれも既存の修正追記（R4-2 注記等）の周辺精査によって浮上したものであり、文書の密度が上がるにつれて隣接する記述の正確性が試されている典型例である。

N5-1（`this.recentKeep`）は読者が実装時にそのまま踏襲すると機能しないコードを生成するリスクがあり、技術文書としての信頼性に直接影響する。N5-2（setWatermark 2回呼び出し）はクラッシュ安全性の説明欠如であり、設計の意図が伝わらない問題である。

両 MED を対処した後、Round 6 での最終収束確認を推奨する。

**Carryover（低優先・引き続き未対応）:**
- R4-3: getWatermark 初回返り値未定義
- L-1: buildDateSeq 定義欠如
- L-2: sessionFile アトミック書き込み未言及

---

## 実行チェックリスト

```
[x] N5-1: Section 4.5 compact() Step 5 — this.recentKeep がアロー関数内で undefined になる旨の注記を追加。
          疑似コード表記と実装（クロージャ変数使用）の差異を明記 (2026-03-25)
[x] N5-2: Section 4.5 compact() Step 3 — 中間チェックポイントとしての目的・クラッシュ安全性の注記を追加 (2026-03-25)
[x] N5-2: Section 4.5 compact() Step 6 — Step 3 の中間チェックポイントを正式値で上書きする旨を明記。
          Step 5後・Step 6前クラッシュ時の自己修復経路を追記 (2026-03-25)
[x] N5-3: Section 4.3 — 「均術（回話量による）」→「（会話量による）」に誤字修正 (2026-03-25)
[ ] R4-3: Section 4.5 / 4.0 — getWatermark 初回返り値のセマンティクス・nullガード有無を追記（低優先）
[ ] L-1: Section 4.5 — buildDateSeq の定義・シグネチャを追記（低優先）
[ ] L-2: Section 4.5 または Section 15.2.4 — compact() sessionFile アトミック書き込み注記を追加（低優先）
```
