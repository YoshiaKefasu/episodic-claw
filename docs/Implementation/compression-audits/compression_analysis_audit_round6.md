# compression_analysis_report.md — 監査レポート Round 6

## Audit Report — Round 6
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-25
> Mode: Post-Implementation (Round 5 MED/LOW 修正後の最終収束確認)
> Prior audits: 5 | New findings this round: 3

---

### Convergence Status (Prior Round Items)

| Prior Round Issue | Status |
|---|---|
| N5-1: this.recentKeep アロー関数 undefined バグパターン | Resolved — Section 4.5 Step 5 に注記追加済み（疑似コード表記と実装例を明示） |
| N5-2: setWatermark 2回呼び出し設計意図・クラッシュ安全性 | Resolved — Step 3 に中間チェックポイント注記、Step 6 に正式値上書き注記を追加済み |
| N5-3: Section 4.3 誤字（均術/回話量） | Resolved — 「1日あたり30ファイル程度（会話量による）」に修正済みを確認 |
| R4-3: getWatermark 初回返り値未定義 | Still open (低優先・意図的後回し) |
| L-1: buildDateSeq 定義欠如 | Still open (低優先・意図的後回し) |
| L-2: sessionFile アトミック書き込み未言及 | Still open (低優先・意図的後回し) |

---

### New Findings — Round 6

#### N6-1 [MED] Section 6.4 末尾への `### 15.3 最終結論` 誤挿入（セクション構造破損）

**場所:** `## 6. 低遅延アーキテクチャ: Go サイドカー構成` > `### 6.4 Go サイドカー API (JSON-RPC over TCP)` の直後（line 1155 付近）

**問題の詳細:**

`### 6.4 Go サイドカー API (JSON-RPC over TCP)` の `[!NOTE]` 注記ブロックの直後に、本来 `## 15. Ruthless Pitfall Audit` に属する `### 15.3 最終結論` が孤立したまま誤挿入されている。

```markdown
### 6.4 Go サイドカー API (JSON-RPC over TCP)

> [!NOTE]
> 実装済みの RPC メソッド一覧（...）。詳細は Section 19 を参照。
> ...

### 15.3 最終結論          ← ここが誤挿入
Phase 1から4.5にわたる設計・実装に加え、この5ラウンドの「無慈悲な監査」を...

---

> [!NOTE]
> Phase 5.4 / 5.5 / 追加対応の詳細は本レポート末尾の Section 16〜19 を参照。

### 6.5 実際のプロジェクト構成 (Phase 5.5 + Antigravity 修正完了時点)
```

**影響:**
- Section 6 の連続性が壊れる（6.4 → 15.3 → 6.5 という番号の跳躍）
- `### 15.3 最終結論` が Section 15 本体（line 1544 付近）にも正しく存在するため、ドキュメント内に同一見出しが2箇所存在する（重複）
- ドキュメントレンダラーや Anchor リンクが `#153-最終結論` を2個生成し、リンク解決が不定になる
- 読者が Section 6 の範囲と Section 15 の範囲を混同する

**修正方針:**
Section 6.4 末尾の誤挿入ブロック（`### 15.3 最終結論` の段落と水平線）を削除する。Section 15 本体の `### 15.3` は正しい位置にあるため保持。

---

#### N6-2 [MED] Section 4.5 compact() Step 3 と Step 6 で `dateSeq` の意味的定義が非一貫

**場所:** `### 4.5 Context Engine コントラクト実装` > `compact()` > Step 3 および Step 6

**問題の詳細:**

`dateSeq` フィールドについて、ドキュメントのコメントは「日次カウンタ（0時リセット）」と説明しているが、Step 3 と Step 6 で実際に設定される値の意味が全く異なっている。

Step 3（中間チェックポイント）:
```typescript
await rpcClient.setWatermark({
  dateSeq: buildDateSeq(unprocessed.length), // e.g. "20260316-347"
  absIndex: allMsgs.length - 1,
});
```
→ `buildDateSeq(unprocessed.length)` の引数は**処理したバッチ件数**（例: 347件処理したなら "20260316-347"）

Step 6（正式値リセット）:
```typescript
const today = new Date().toISOString().slice(0, 10).replace(/-/g, ""); // "20260316"
await rpcClient.setWatermark({
  dateSeq: `${today}-${session.messages.length - 1}`,
  absIndex: session.messages.length - 1,  // 新配列の末尾
});
```
→ `session.messages.length - 1` の意味は**新配列の末尾インデックス**（例: 31件なら "20260316-30"）

**矛盾の核心:**
- Section 4.4 シーケンス図のコメントには `dateSeq: YYYYMMDD-N` の `N` が何を意味するか説明なし
- Section 4.5 Step 3/Step 6 のコメントは「日次カウンタ（0時リセット）」と説明するが、実際のコードは件数やインデックスを使っており「カウンタ」ではない
- Step 3 と Step 6 で `N` の意味が統一されていない（件数 vs 末尾インデックス）
- 既存の LOW carryover L-1（`buildDateSeq` 定義欠如）と密接に関連するが、それとは独立した問題：`buildDateSeq` が定義されていても Step 6 と意味的に一致しない

**実運用への影響:**
`absIndex` が正規の O(1) ギャップ検出の主体であり、`dateSeq` は「人間可読ID」として補助的に使われるため、機能上の致命的バグにはならない。しかしドキュメント上の「日次カウンタ（0時リセット）」という説明が誤解を招く。将来 `dateSeq` を用いた診断・デバッグ時に混乱を生む。

**修正方針:**
`dateSeq` のコメントを「日次カウンタ（0時リセット）」から「YYYYMMDD-{N} 形式の人間可読ラベル（N の意味は文脈依存: Step 3 = 処理件数、Step 6 = 新配列末尾インデックス）」に修正する。あるいは Step 6 の `N` を Step 3 と統一した定義に揃えることをドキュメントに注記する。

---

#### N6-3 [LOW] Section 4.5 compact() の `tokensAfter` 計算が JSON シリアライズ全体を対象にしており過大評価

**場所:** `### 4.5 Context Engine コントラクト実装` > `compact()` 返却値

**問題の詳細:**

```typescript
tokensAfter: estimateTokens(JSON.stringify(session.messages)), // CJK-aware (utils.ts) — length/4 は不可
```

`JSON.stringify(session.messages)` はメッセージ配列全体を JSON 文字列に変換したバイト列を `estimateTokens` に渡している。この文字列には JSON の構造文字（`[`, `]`, `{`, `}`, `"role"`, `"content"`, `,` 等）が大量に含まれるため、実際のプロンプトとしてのトークン消費量より**大きく過大評価**される。

具体例：
- 実メッセージ: `{ role: "user", content: "Hello" }` → プロンプトトークン: ~1
- `JSON.stringify` 後: `[{"role":"user","content":"Hello"}]` → `estimateTokens` の入力: ~35文字 → 推定: ~8〜9トークン

**影響範囲:**
- `CompactResult.result.tokensAfter` は「診断・フック用メタデータ」であり、ランタイムがプロンプト制御に直接使用しない（Section 4.4 および 4.5 に明記）
- `assemble()` の `Reserve Tokens` 計算には影響しない
- ログ・ダッシュボード・フック経由で `tokensAfter` を参照する実装がある場合、圧縮後トークン数を過大評価したデータが記録され、「圧縮効果が低い」という誤った診断を与える可能性がある

**修正方針（低優先）:**
診断の精度を上げるには、各メッセージの `content` フィールドのみを結合して `estimateTokens` に渡す。
```typescript
// 改善案（参考）
const contentOnly = session.messages.map((m: any) => m.content ?? "").join("\n");
tokensAfter: estimateTokens(contentOnly),
```
ただし `tokensAfter` が診断メタデータであることを考慮すれば、コメントに「JSON構造込みの過大評価（診断目的のみ）」と明記するだけでも十分。

---

### Summary Table — Round 6 New Findings

| ID | Severity | Section | Issue | Action Required |
|---|---|---|---|---|
| N6-1 | MED | Section 6.4 末尾 (line ~1155) | `### 15.3 最終結論` が Section 6.4 内に誤挿入されており、同一見出しが文書内に2箇所存在する（重複・構造破損） | 誤挿入ブロックを削除 |
| N6-2 | MED | Section 4.5 compact() Step 3/6 | `dateSeq` の意味的定義が Step 3（処理件数）と Step 6（末尾インデックス）で非一貫。「日次カウンタ」の説明とも矛盾 | コメントの説明を実態に合わせて修正 |
| N6-3 | LOW | Section 4.5 compact() 返却値 | `tokensAfter: estimateTokens(JSON.stringify(session.messages))` が JSON 構造文字込みで過大評価 | 診断メタデータとしての限界をコメントに追記（または content フィールドのみ集計に変更） |

---

### Convergence Assessment

3件の新規発見（MED×2、LOW×1）を確認した。

**N6-1** は構造的バグ（Section 6.4 内への `### 15.3 最終結論` 誤挿入による重複見出し）であり、ドキュメントのナビゲーション整合性に影響する。修正は単純な削除で完結する。

**N6-2** は `dateSeq` の定義説明と実コードの乖離であり、機能的な実害はないが人間可読ラベルとしての一貫性が損なわれている。低優先カテゴリ carryover の L-1（buildDateSeq 定義欠如）と連動する問題だが独立して修正可能。

**N6-3** は診断メタデータの精度問題であり、ランタイムの動作には影響しない。コメント追記で対処可能。

N6-1 および N6-2 の修正後、本ドキュメントは設計・アーキテクチャ上の重大な未解決問題を持たない状態に達する。残存する LOW carryover（R4-3, L-1, L-2）および N6-3 は既知・受容済み。

**Document has not fully converged yet.** N6-1（構造破損）および N6-2（コメント不整合）の修正完了後に収束宣言が可能。

---

## 実行チェックリスト

```
[x] N6-1: Section 6.4 末尾 — 誤挿入された「### 15.3 最終結論」ブロックと水平線を削除 (2026-03-25)
[x] N6-2: Section 4.5 compact() Step 3 — dateSeq コメントを「日次カウンタ（0時リセット）」→
          「YYYYMMDD-{N} 形式の人間可読ラベル（N = 処理したバッチ件数）」に修正 (2026-03-25)
[x] N6-2: Section 4.5 compact() Step 6 — dateSeq 行に「N = 新配列末尾インデックス（Step 3 の N = 処理件数とは定義が異なる）」の注記を追加 (2026-03-25)
[x] N6-3: Section 4.5 compact() tokensAfter — JSON 構造文字込み過大評価の旨をコメントに追記 (2026-03-25)
[ ] R4-3: Section 4.5 / 4.0 — getWatermark 初回返り値のセマンティクス・nullガード有無を追記（低優先）
[ ] L-1: Section 4.5 — buildDateSeq の定義・シグネチャを追記（低優先）
[ ] L-2: Section 4.5 または Section 15.2.4 — compact() sessionFile アトミック書き込み注記を追加（低優先）
```
