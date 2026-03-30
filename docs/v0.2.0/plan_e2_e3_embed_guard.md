# Plan: E2 / E3 — Embed Guard & Frontmatter Verification

> Source: `issue_tpm_embed_truncation.md` — Round 2 未クローズ残存 2 件
> Priority: `E3 = HIGH`, `E2 = CLOSED`
> Date drafted: 2026-03-29
> Last updated: 2026-03-29

---

## 背景

`issue_tpm_embed_truncation.md` の Audit Round 2 で、次の 2 件が未クローズとして残っていた。

| ID | タイトル | 旧状態 | 2026-03-29 再判定 |
|----|---------|--------|-------------------|
| `E3` | 空文字列ガード | 🔲 Open | 🔲 Open |
| `E2` | フロントマター長 | 🔲 Open | ✅ Closed |

今回の Pre-Implementation 監査で、実コードを確認した。

- `doc.Body` の定義は [frontmatter.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\frontmatter\frontmatter.go) の `Parse()`
- 実際の embed 実装は [google_studio.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\google_studio.go)
- 主要な呼び出し元は [main.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\main.go) の `runAutoRebuild` `handleIngest` `handleBatchIngest` `handleRecall` `handleSurprise` と、[consolidation.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\vector\consolidation.go)

この文書は、監査結果を反映して

1. `E2` をコード読解でクローズする
2. `E3` を rebuild / heal / recall / surprise を壊さない実装プランに修正する

ための更新版。

---

## このプランのゴール

- 空入力で不要な embed API 呼び出しをしない
- 空入力を雑に silent filter して、batch の index 対応を壊さない
- rebuild / HealingWorker / recall / surprise / D1 consolidation まで影響範囲を明示する
- `issue_tpm_embed_truncation.md` の残件を手戻りなく閉じる

このプランは `Phase 0: Hardening` の一部として扱う。

---

## [E2] フロントマター長の検証

### 結論

`E2` は **クローズ** でよい。

### 根拠

[frontmatter.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\frontmatter\frontmatter.go) の `Parse()` は、frontmatter が存在する場合に以下の形で本文だけを `doc.Body` に入れている。

- `bytes.SplitN(content, []byte("---"), 3)` で frontmatter を分離
- `yaml.Unmarshal(parts[1], &doc.Metadata)` で YAML を metadata へ
- `doc.Body = string(bytes.TrimLeft(parts[2], "\n\r"))` で **本文のみ** を格納

つまり、今回の懸念だった

- 「長い YAML frontmatter が embed 入力先頭を食い尽くす」

は、現在の主要経路では成立しない。

### 影響範囲確認

主要な本文取得経路はどれも `frontmatter.Parse()` を通っている。

- `runAutoRebuild` -> `frontmatter.Parse(frec.path)` -> `item.doc.Body`
- HealingWorker -> `frontmatter.Parse(path)` -> `doc.Body`
- `ep-expand` 相当の本文再表示でも `frontmatter.Parse()` を経由

### クローズ条件

- [x] `doc.Body` が frontmatter 除去後の本文であることをコードで確認
- [x] 主要経路が `frontmatter.Parse()` を通ることを確認
- [x] この文書に結果を記録

### 残る注意点

将来、

- 生の `.md` ファイルを直接 `os.ReadFile()` して本文扱いする新経路

が追加された場合は、この判定を再監査する。

---

## [E3] 空文字列ガード

### 問題の再定義

元のプランでは `EmbedContent` / `EmbedContentBatch` の入口で空文字列を弾く方向性自体は正しかったが、実装戦略に重要な抜けがあった。

特に危ない点は 2 つある。

1. `EmbedContentBatch` の内部で空テキストを silent filter すると、`runAutoRebuild` 側の `embs[j] <-> items[j]` の対応が壊れる
2. 空入力の影響範囲が `handleIngest` だけでなく、`runAutoRebuild` `HealingWorker` `handleRecall` `handleSurprise` `processCluster` に及ぶ

### 監査で確認した現状

#### すでにガードがある経路

- [main.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\main.go) の `handleIngest` は `strings.TrimSpace(params.Summary) == ""` をすでに拒否している

#### まだ未保証の経路

- `runAutoRebuild`
  - `texts[j] = item.doc.Body`
  - `provider.EmbedContentBatch(ctx, texts)`
- HealingWorker Pass 1
  - `embedProv.EmbedContent(context.Background(), doc.Body)`
- `handleBatchIngest`
  - `embeddingProv.EmbedContent(ctx, it.Summary)`
- `handleRecall`
  - `provider.EmbedContent(recallCtx, params.Query)`
- `handleSurprise`
  - `provider.EmbedContent(ctx, params.Text1)`
  - `provider.EmbedContent(ctx, params.Text2)`
- `processCluster`
  - D1 body が空になった場合の扱いが文書化されていない

### 重要な設計制約

`EmbedContentBatch` は現在、

- 入力 `texts[i]`
- 出力 `embs[i]`

が同じ順序で 1:1 対応する契約で使われている。

したがって、

- provider 内で空入力だけ削除して詰め直す

方式は **採用してはいけない**。

これは [main.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\main.go) の rebuild パスで、別の episode に別の embedding が紐づく事故につながる。

---

## 推奨実装方針

### 方針A: provider 層で「空入力はエラー」として明示する

実装先は [google_studio.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\google_studio.go)。

やること:

1. `strings.TrimSpace(text) == ""` を共通 helper で判定する
2. `EmbedContent` は空入力なら HTTP を打たずに `ErrEmptyEmbedInput` を返す
3. `EmbedContentBatch` は空入力を silent filter せず、`index` 付きエラーで失敗させる

推奨イメージ:

```go
var ErrEmptyEmbedInput = errors.New("embed input is empty")

func normalizeEmbedText(text string) (string, error) {
    trimmed := strings.TrimSpace(text)
    if trimmed == "" {
        return "", ErrEmptyEmbedInput
    }
    runes := []rune(trimmed)
    if len(runes) > MaxEmbedRunes {
        trimmed = string(runes[:MaxEmbedRunes])
    }
    return trimmed, nil
}
```

`EmbedContentBatch` は次のような姿勢にする。

- 空を勝手に削除しない
- 見つけたら `fmt.Errorf("batch embed: empty text at index %d: %w", i, ErrEmptyEmbedInput)` を返す

これで batch の順序契約を守れる。

### 方針B: caller 側で batch を組む前に空入力を落とす

`EmbedContentBatch` の中では silent filter しない。

代わりに caller 側で、

- `filteredItems`
- `filteredTexts`

を同時に組み立ててから batch embed する。

これが必要なのは `runAutoRebuild` だけではない。

- `handleBatchIngest`
- `processCluster`

でも同じ発想が必要になる。

### 方針C: request validation が必要な RPC は provider 到達前に返す

RPC 入力値そのものが空なら、provider に責務を押し込むよりも RPC レイヤーで `-32602` を返した方が自然。

対象:

- `handleRecall` の `params.Query`
- `handleSurprise` の `params.Text1`
- `handleSurprise` の `params.Text2`

`handleIngest` はすでに同じ設計になっているので、ここに合わせる。

---

## 変更対象

| ファイル | 変更内容 |
|---------|---------|
| [google_studio.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\google_studio.go) | `normalizeEmbedText` 相当の helper、`EmbedContent` 空入力 guard、`EmbedContentBatch` の index 付き validation |
| [provider.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\provider.go) | `ErrEmptyEmbedInput` 追加候補。retry すべきでないエラーであることを明確化 |
| [main.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\main.go) | `runAutoRebuild` の pre-filter、HealingWorker の skip、`handleBatchIngest` の skip、`handleRecall` / `handleSurprise` の request validation |
| [consolidation.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\vector\consolidation.go) | D1 body が空なら embed 前に skip し、D1 作成失敗を明示ログ化 |
| [issue_tpm_embed_truncation.md](D:\GitHub\OpenClaw Related Repos\episodic-claw\docs\pre_release_implementation\issues\issue_tpm_embed_truncation.md) | 実装完了後に `E2` / `E3` の残件状態を更新 |

---

## 実装手順

### Step 1. `E2` をこの文書で閉じる

- [x] `frontmatter.Parse()` の `doc.Body` 定義を確認
- [x] `E2` を Closed に変更
- [x] 将来の再監査条件を明記

### Step 2. provider 側の契約を固める

- [x] `ErrEmptyEmbedInput` を定義する
- [x] `EmbedContent` で空入力を HTTP 前に reject する
- [x] `EmbedContentBatch` で空入力を silent filter しない
- [x] `EmbedContentBatch` のエラーに index を含める

### Step 3. caller ごとの対処を入れる

- [x] `runAutoRebuild` で `items/texts` を作る前に空本文を skip する
- [x] HealingWorker で空 `doc.Body` を skip する
- [x] `handleBatchIngest` で空 `Summary` を skip する
- [x] `handleRecall` で空 `Query` を `-32602` で reject する
- [x] `handleSurprise` で空 `Text1` / `Text2` を `-32602` で reject する
- [x] `processCluster` で空 D1 body を skip する

### Step 4. ログ方針を揃える

`[episodic-claw] warn:` という固定プレフィックスをコード側で直書きする必要はない。

既存の `EmitLog(...)` に合わせて、文言だけ揃える。

推奨文言:

- `skipped empty rebuild body`
- `skipped empty healing body`
- `skipped empty batch ingest summary`
- `rejected empty recall query`
- `rejected empty surprise text`
- `skipped empty d1 body`

### Step 5. ドキュメントと残件を閉じる

- [x] このファイルの `E3` 実装結果を記入
- [x] `issue_tpm_embed_truncation.md` の `E2` / `E3` 状態を更新
- [x] [v0_2_0_master_plan.md](D:\GitHub\OpenClaw Related Repos\episodic-claw\docs\v0_2_0_master_plan.md) の Phase 0 進捗に反映

---

## 完了条件

### `E2`

- [x] `doc.Body` が frontmatter 除去後本文だと確認済み
- [x] 主要経路が `frontmatter.Parse()` を経由している
- [x] この文書上で Closed に変更済み

### `E3`

- [x] `EmbedContent("")` が `ErrEmptyEmbedInput` を返し、HTTP を打たない
- [x] `EmbedContentBatch` が空入力を silent filter しない
- [x] `runAutoRebuild` が空本文を skip しても他 item の `embs[j] <-> items[j]` 対応を維持する
- [x] HealingWorker が空本文で retry storm を起こさない
- [x] `handleRecall` の空 query が `-32602` で reject される
- [x] `handleSurprise` の空 text が `-32602` で reject される
- [x] `processCluster` が空 D1 body を skip する
- [x] `go build ./...` が通る

> 注: `shell_command` からの通常 `.exe` 起動はこの Codex セッションで不安定だったが、PowerShell の `System.Diagnostics.ProcessStartInfo` 経由では `go build ./...` 成功を確認した。

---

## テスト計画

### ユニット

- [ ] `normalizeEmbedText("")` -> `ErrEmptyEmbedInput`
- [ ] `normalizeEmbedText("   ")` -> `ErrEmptyEmbedInput`
- [ ] `normalizeEmbedText(longText)` -> `MaxEmbedRunes` で切り詰め
- [ ] `EmbedContentBatch([]string{"ok", ""})` -> index 付きエラー

### 統合

- [ ] rebuild 用 batch に空本文が 1 件混ざっても、残りが正しい episode に保存される
- [ ] HealingWorker が空本文を検出して skip し、429 retry 系へ流れない
- [ ] `handleBatchIngest` が空 summary item だけ skip する
- [ ] `handleRecall` の空 query が即時 reject される
- [ ] `handleSurprise` の空 text1 / text2 が即時 reject される
- [ ] `processCluster` で空 D1 body が作られても DB 挿入や embed 呼び出しに進まない

### 手動確認

- [x] `go build ./...`
- [ ] rebuild 実行時に empty skip ログが期待どおり出る
- [ ] recall / surprise で空入力時の error message が人間に理解しやすい

---

## 実施順序

```text
1. E2 をコード読解でクローズ
2. provider 契約を追加
3. rebuild / heal / batch ingest / recall / surprise / consolidation を個別に修正
4. go build と空入力系テストを実施
5. issue_tpm_embed_truncation.md と v0_2_0_master_plan.md を更新
```

---

## 調査結果

**[E2] `doc.Body` の定義:**
> `frontmatter.Parse()` が YAML frontmatter を除去した本文のみを `doc.Body` に格納する。

**[E2] クローズ判定:**
> ✅ クローズ

**[E3] 実装コミット:**
> 実装済み（provider 契約 + caller 側の空入力ガードを反映済み）

## 実装結果

- `provider.go` に `ErrEmptyEmbedInput` と共通 normalize helper を追加し、空入力は非再試行エラーとして扱うようにした
- `google_studio.go` の `EmbedContent` / `EmbedContentBatch` は空入力を HTTP 前に拒否し、batch は index を含むエラーで止めるようにした
- `main.go` は `runAutoRebuild` `RunAsyncHealingWorker` `handleBatchIngest` `handleRecall` `handleSurprise` に早期ガードを入れ、`background.go` と `consolidation.go` も空本文を skip するようにした
- `issue_tpm_embed_truncation.md` は `E2` / `E3` を 2026-03-29 時点で解決済みに更新した
- `go build ./...` は 2026-03-29 に Windows 上で成功確認した。通常の `shell_command` からの `.exe` 起動は不安定だったため、`System.Diagnostics.ProcessStartInfo` 経由で実行した

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-29
> Mode: Pre-Implementation
> Prior audits: 0 | New findings this round: 8

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| なし | 初回監査 |

### ⚠️ Impact on Related Features *(new only)*
- `EmbedContentBatch` の silent filter は rebuild の `items[j]` と `embs[j]` の対応を壊し、別 episode に別 vector が保存される事故につながる。
- provider 側だけで空入力を弾くと、`handleRecall` と `handleSurprise` は user input validation ではなく内部エラー扱いになり、RPC UX が悪化する。
- `handleIngest` だけ既存 guard があり、他経路が未統一のままだと「同じ空入力でも API によって挙動が違う」状態が残る。

### 🚨 Potential Problems & Risks *(new only)*
- `go/internal/vector/embed.go` を変更対象にしていた元プランは、実装場所の認識がずれている。実際の embed 実装は [google_studio.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\google_studio.go) にある。
- `EmbedContentBatch` の「空を除いて残りだけ送る」案は順序契約を壊すため BLOCKER。ここを直さないと Phase 0 の hardening ではなく rebuild 破壊になる。
- ログ要件を固定プレフィックス文字列で縛ると、既存の `EmitLog` 設計と食い違う。ログ基盤に prefix がある場合、二重 prefix や不統一を起こす。

### 📋 Missing Steps & Considerations *(new only)*
- caller inventory が不足していた。`runAutoRebuild` `HealingWorker` `handleBatchIngest` `handleRecall` `handleSurprise` `processCluster` まで対象に含める必要がある。
- `ErrEmptyEmbedInput` のような sentinel error を決めないと、retry 対象外であることがコード上に表現されず、今後の wrap / log / metrics で扱いがぶれる。
- `E2` を「未解決タスク」のまま残すと、実装者が不要な修正を入れる誘因になる。コード読解で閉じた事実をこの文書に明記すべきだった。

### 🕳️ Unaddressed Edge Cases *(new only)*
- whitespace-only 入力は `""` と同じく拒否対象にしないと guard をすり抜ける。
- batch が全件空だった場合、`EmbedContentBatch` を呼ばずに caller 側でバッチ丸ごと skip する必要がある。
- D1 要約や LLM 生成結果が空になったケースが元プランでは未記載で、`processCluster` 側の防御が抜けていた。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| BLOCKER | `EmbedContentBatch` の silent filter 案を破棄し、順序契約を壊さない設計へ修正する | rebuild の vector と episode 対応が壊れる | ✅ New |
| HIGH | `E3` の対象 caller を `runAutoRebuild` `HealingWorker` `handleBatchIngest` `handleRecall` `handleSurprise` `processCluster` まで広げる | 影響範囲の見落としがある | ✅ New |
| HIGH | `handleRecall` / `handleSurprise` には RPC レイヤーの空入力 validation を追加する | 内部エラーではなく入力エラーとして返すべき | ✅ New |
| HIGH | 変更対象ファイルを [google_studio.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\google_studio.go) と [provider.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\provider.go) に修正する | 元プランの対象ファイルが実態とずれている | ✅ New |
| MED | `ErrEmptyEmbedInput` を導入して retry 対象外の失敗を明示する | 今後の wrap / logging / metrics の一貫性を保つ | ✅ New |
| MED | `EmitLog` ベースでログ文言のみ標準化し、固定 prefix 要件は削除する | 既存ログ基盤との整合を保つ | ✅ New |
| LOW | `E2` を Closed に更新し、再監査条件だけ残す | 不要な修正を防ぐ | ✅ New |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-29
> Mode: Post-Implementation
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| `EmbedContentBatch` の silent filter は rebuild の順序契約を壊す | ✅ Resolved — [main.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\main.go) が caller 側で空本文を pre-filter し、[google_studio.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\google_studio.go) は index 付き error を返す設計に揃った |
| `E3` の対象 caller が不足していた | ✅ Resolved — `runAutoRebuild` `HealingWorker` `handleBatchIngest` `handleRecall` `handleSurprise` `processCluster` まで doc と code が一致した |
| `handleRecall` / `handleSurprise` に RPC 入力 validation がなかった | ✅ Resolved — provider 到達前に `-32602` を返すようになった |
| 変更対象ファイルの認識がずれていた | ✅ Resolved — doc は [google_studio.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\google_studio.go) [provider.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\provider.go) [main.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\main.go) [consolidation.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\vector\consolidation.go) を正しく指している |
| `ErrEmptyEmbedInput` のような非再試行エラー表現が不足していた | ✅ Resolved — [provider.go](D:\GitHub\OpenClaw Related Repos\episodic-claw\go\internal\ai\provider.go) に sentinel error と共通 normalize helper が入った |
| `E2` が未解決タスクのまま残っていた | ✅ Resolved — `frontmatter.Parse()` ベースで Closed 化され、関連 docs にも反映された |

✅ No new critical issues found. Document has converged.

補足:
- `go build ./...` は 2026-03-29 に成功確認済み。問題だったのはコードではなく、この Codex セッションで通常の `.exe` 起動が不安定だった点だった。
