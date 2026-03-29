# Plan: E2 / E3 — Embed Guard & Frontmatter Verification

> Source: `issue_tpm_embed_truncation.md` — Round 2 未クローズ残存 2 件
> Priority: LOW（両件とも。ただし E3 は未実装コード残存のため先行して閉じる）
> Date drafted: 2026-03-29

---

## 背景

Phase 5.9 完了時点で、`issue_tpm_embed_truncation.md` の Audit Round 2 において
2 件の LOW 問題が未クローズのまま残存している。

| ID | タイトル | 状態 |
|----|---------|------|
| [E3] | 空文字列ガード | 🔲 Open — 実装チェックリスト `[ ]` のまま。`go build` は通るが未実装 |
| [E2] | フロントマター長 | 🔲 Open — `doc.Body` がフロントマター解析後の本文と確認できれば自動クローズ可能 |

HIGH/BLOCKER は全解消済み。これらは次のリリース前に処理する。

---

## [E3] 空文字列ガード

### 問題

`EmbedContent` / `EmbedContentBatch` に `text == ""` が渡された場合の挙動が未保証。

- Gemini API が空文字列を拒否して 400 を返すか、ゼロベクトルを返すかが不明
- ゼロベクトルが Pebble DB に保存されると、後続の recall でコサイン距離が
  全エピソードと同一（= 0 距離）になり誤検出を引き起こす
- `tokenEstimate` は `max(1, len(text)/4)` で `n=1` になるため WaitN は問題ないが、
  API 呼び出し自体が無意味になる

### 実装方針

`EmbedContent` と `EmbedContentBatch` の **入口** に early return を追加する。
呼び出し元でフィルタする方式は漏れが生じるリスクがあるため採用しない。

```go
// EmbedContent の入口
if strings.TrimSpace(text) == "" {
    return nil, fmt.Errorf("embedContent: empty text, skipping")
}

// EmbedContentBatch の入口（バッチ側）
// 空テキストをフィルタして非空のもののみ送信し、
// 元のインデックスと対応したベクトルを返す
```

呼び出し元（`handleIngest`, `handleBatchIngest`, `RunConsolidation`）では
エラーを受け取ったらそのエピソードをスキップ（`continue`）する。
スキップしたことをログに残す（`[episodic-claw] warn: skipped empty episode body`）。

### 対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `go/internal/vector/embed.go` または該当する embed 関数ファイル | `EmbedContent` / `EmbedContentBatch` 入口にガード追加 |
| `go/main.go` — `handleIngest` / `handleBatchIngest` | スキップログ追加 |
| `go/internal/vector/consolidation.go` — `processCluster` | スキップログ追加 |

### 完了条件

- [ ] `EmbedContent("")` を呼び出したとき `nil, error` を返す
- [ ] `EmbedContentBatch` に空文字列が混在していても残りのテキストは正常に embed される
- [ ] スキップ時のログが `[episodic-claw] warn:` プレフィックスで出力される
- [ ] `go build ./...` が通る
- [ ] 手動テスト：`ep-save` で空の body を送信してもクラッシュしない

---

## [E2] フロントマター長の検証

### 問題

`doc.Body` がフロントマター解析後の**本文のみ**を指すなら問題ない。
しかし YAML front matter が非常に長い場合（タグ多数、長いサマリーなど）、
`doc.Body` の先頭 8,000 バイト（= `MaxEmbedRunes` 相当）がフロントマターの
末尾部分で消費され、実質的なコンテンツが 1 文字も embed されない可能性がある。

### 調査手順

1. `go/internal/vector/store.go`（または frontmatter パース処理）を開き、
   `doc.Body` の定義を確認する
2. `doc.Body = 全テキスト（フロントマター込み）` なのか
   `doc.Body = フロントマター除去後の本文` なのかを特定する
3. フロントマターのバイト長上限を推定する（タグ数 × 平均タグ長 + slug + date 等）

### 結果に応じた対応

| 調査結果 | 対応 |
|---------|------|
| `doc.Body` がフロントマター解析後の本文のみ | ✅ 即クローズ。ドキュメントにその旨を 1 行追記 |
| `doc.Body` がフロントマター込みの全テキスト | 実装対応が必要（下記） |

### フロントマター込みだった場合の実装方針

embed 前にフロントマター部分をストリップしてから `EmbedContent` に渡す。

```go
body := stripFrontmatter(doc.Body)
if strings.TrimSpace(body) == "" {
    // E3 のガードと統合して処理
}
```

`stripFrontmatter` は既存の frontmatter パーサーを再利用する。
新規実装は不要なはず。

### 完了条件

- [ ] `doc.Body` の定義を確認し、結果をこのファイルの「調査結果」欄に記録
- [ ] 上記の分岐に従って対応またはクローズ

---

## 実施順序

```
1. [E2] 調査（コードリーディングのみ、30分以内）
        ↓
   「フロントマター除去済み」→ E2 クローズ
   「フロントマター込み」   → E2 実装タスクを追加
        ↓
2. [E3] 実装（EmbedContent / EmbedContentBatch 入口ガード）
        ↓
3. 両件クローズ → issue_tpm_embed_truncation.md の
   Round 2 チェックボックスを ✅ に更新
```

---

## 調査結果（実施後に記入）

**[E2] doc.Body の定義:**
> （調査後に記入）

**[E2] クローズ判定:**
> ✅ クローズ / 🔲 実装対応が必要

**[E3] 実装コミット:**
> （コミットハッシュを記入）
