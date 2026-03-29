# Phase 6.1: Semantic Topics フィールド導入プラン

> 作成日: 2026-03-27
> 対象: episodic-claw
> 前提: Phase 5.5〜5.9 全テスト PASS 済み
> 目的: エピソードに意味的内容タグ（`topics`）を追加し、ファセット検索とヒューマンライク記憶検索を実現

---

## 1. 背景と問題提起

### 1.1 現状の `tags` フィールドの役割

現在の `tags` はシステムライフサイクル管理専用：

| タグ | 用途 | セットする側 |
|---|---|---|
| `auto-segmented` | 自動セグメンテーション由来 | `segmenter.ts` |
| `chunked` | BatchIngest 由来 | `segmenter.ts` |
| `surprise-boundary` | Surprise Score 超過で分割 | `segmenter.ts` |
| `size-limit` | サイズ上限で分割 | `segmenter.ts` |
| `force-flush` | forceFlush で強制保存 | `segmenter.ts` |
| `gap-compacted` | コンテキスト圧縮で生成 | `compactor.ts` |
| `archived` | D1 昇格後の D0 | `consolidation.go` |
| `d1-summary` | D1 サマリーノード | `consolidation.go` |
| (ユーザー指定) | ep-save 手動保存時 | `ep-save` ツール |

**問題**: `ep-save` のユーザー指定タグと `archived` 等のシステムタグが同じ `tags` 配列に混在。意味的内容（「このエピソードは何について？」）を表すフィールドが存在しない。

### 1.2 人間のエピソード記憶との対比

| 検索手がかり | 人間の脳 | episodic-claw 現状 | 本プランで追加 |
|---|---|---|---|
| 意味的内容 | 海馬 + 側頭葉の概念ネットワーク | slug + embedding のみ | **`topics` フィールド** |
| 感情的文脈 | 扁桃体 → 海馬 | `surprise` 数値 | (対象外) |
| 時間的文脈 | 内嗅皮質 | `created` タイムスタンプ | (既存) |
| 出処/ソース | 前頭前皮質 | `tags` (プロセスタグ) | (既存維持) |

### 1.3 ゴール

```yaml
# Before (現状)
tags:
  - auto-segmented
  - surprise-boundary

# After (本プラン実施後)
tags:
  - auto-segmented
  - surprise-boundary
topics:
  - goroutine
  - concurrency
  - go-language
  - thread-comparison
```

- `tags`: システムライフサイクル専用（変更なし）
- `topics`: 意味的内容タグ（LLM 生成 or ユーザー指定）

---

## 2. 設計方針

### 2.1 `topics` vs `tags` の分離原則

```
tags   → "How was this episode created?"  (システムが管理)
topics → "What is this episode about?"    (LLM or ユーザーが指定)
```

| 項目 | `tags` | `topics` |
|---|---|---|
| 書き込み元 | segmenter / consolidation / compactor | LLM (自動) / ep-save (手動) |
| 言語 | 英語 kebab-case 固定 | **多言語対応（CJK 含む）** |
| 用途 | ライフサイクル管理 (`ListByTag`) | ファセット検索・意味的分類 |
| 変更頻度 | consolidation 時に `archived` 追加 | 生成後は不変 |
| Quality Guard | 不要（ハードコード値） | 必要（LLM 汚染・長さチェック） |

### 2.2 CJK 言語対応

`topics` は CJK（日本語・中国語・韓国語）をネイティブサポートする。

```yaml
# 日本語会話から生成されたエピソード
topics:
  - ゴルーチン
  - 並行処理
  - go-language        # 英語タグも混在可
  - スレッド比較
```

**設計判断**: slug は英語 kebab-case を強制しているが、topics は**原語のまま保存**する。理由：
1. topics は URL に使わない（slug と違い安全性の制約がない）
2. `ep-recall` のファセットフィルタで「ゴルーチン」と指定できる方がユーザー体験が良い
3. embedding ベクトル検索は言語非依存なので、topics も言語非依存で良い

**正規化ルール**:
- 前後の空白トリム
- 1 トピック最大 50 文字
- 最大 10 トピック/エピソード
- 重複排除（case-insensitive for ASCII、Unicode NFKC 正規化）

### 2.3 ep-save ツールの変更

```typescript
// Before (現状)
registerTool("ep-save", {
  content: Type.String(),
  tags: Type.Optional(Type.Array(Type.String()))  // → tags に混入
})

// After
registerTool("ep-save", {
  content: Type.String(),
  topics: Type.Optional(Type.Array(Type.String()))  // → topics フィールドへ
  // tags パラメータは削除（ユーザーがシステムタグを操作する理由がない）
})
```

ep-save で保存時:
- `tags` は `["manual-save"]` 固定（システムが自動付与）
- `topics` はユーザー指定値をそのまま使用

### 2.4 自動生成（LLM による topics 抽出）

slug 生成と同じ LLM パイプラインで topics を同時生成する。**追加 API コストなし**。

```
現在の slug 生成プロンプト:
  "Generate a very short, url-safe identifier..."

変更後のプロンプト:
  "Given this episode content, generate:
   1. A short url-safe slug (kebab-case, max 4 words)
   2. 3-7 topic keywords in the content's original language
   Return as JSON: {slug: '...', topics: ['...', ...]}"
```

**生成タイミング**:

| シナリオ | topics 生成 | 備考 |
|---|---|---|
| `batchIngest` (自動) | HealingWorker Pass 2 で生成 | slug リネームと同時 |
| `ep-save` (手動) | ユーザー指定 or LLM 生成 | ユーザー指定がある場合はそちらを優先 |
| `consolidation` (D1) | D1 body から LLM 生成 | D1 の topics = children の topics を包含する上位概念 |

---

## 3. 変更対象ファイル

### 3.1 Go 側

| ファイル | 変更内容 |
|---|---|
| `go/frontmatter/frontmatter.go` | `EpisodeMetadata` に `Topics []string \`yaml:"topics,omitempty"\`` 追加 |
| `go/internal/vector/store.go` | `EpisodeRecord` に `Topics []string` 追加。`ListByTopic()` メソッド追加 |
| `go/main.go` (`handleIngest`) | `params.Topics` を受け取り frontmatter + EpisodeRecord にセット |
| `go/main.go` (`handleBatchIngest`) | 同上 |
| `go/main.go` (`RunAsyncHealingWorker`) | Pass 2 で slug + topics を同時生成。topics を frontmatter に書き込み |
| `go/internal/vector/consolidation.go` | D1 生成時に topics を LLM から抽出 |
| `go/main.go` (`handleRecall`) | topics フィルタパラメータ追加（オプション） |

### 3.2 TypeScript 側

| ファイル | 変更内容 |
|---|---|
| `src/index.ts` (`ep-save` ツール) | `tags` パラメータ → `topics` パラメータに変更 |
| `src/rpc-client.ts` | `generateEpisodeSlug()` / `batchIngest()` の引数に `topics` 追加 |
| `src/segmenter.ts` | `chunkAndIngest()` で topics は空配列を渡す（HealingWorker に委譲） |
| `src/types.ts` | `EpisodeMetadata` / `BatchIngestItem` に `topics` 追加 |

### 3.3 フロントマター例

```yaml
---
id: goroutine-vs-threads
title: goroutine-vs-threads
created: 2026-03-27T03:42:06.555+07:00
tags:                          # システムタグ（変更なし）
  - auto-segmented
  - surprise-boundary
topics:                        # NEW: 意味的内容タグ
  - goroutine
  - concurrency
  - go-language
  - thread-comparison
saved_by: main
surprise: 0.3494
tokens: 1234
---
```

---

## 4. 実装ステップ

### Step 1: スキーマ拡張（破壊的変更なし）

1. `frontmatter.go`: `Topics []string` フィールド追加（`omitempty` で後方互換）
2. `store.go`: `EpisodeRecord.Topics` 追加、msgpack シリアライズ対応
3. `types.ts`: `Topics?: string[]` 追加

**テスト**: 既存エピソード（topics なし）が正常にパースできること

### Step 2: `ep-save` の topics 対応

1. `src/index.ts`: ツールスキーマ変更（`tags` → `topics`）
2. `src/rpc-client.ts`: RPC パラメータに `topics` 追加
3. `go/main.go` (`handleIngest`): `params.Topics` を受け取り保存
4. ep-save で `tags` は `["manual-save"]` を自動付与

**テスト**: `ep-save content="..." topics=["go-language", "並行処理"]` で topics がフロントマターに保存されること

### Step 3: 自動生成（HealingWorker 拡張）

1. HealingWorker Pass 2 のプロンプトを拡張:
   ```
   slug + topics を同時生成する JSON プロンプト
   ```
2. レスポンス JSON パース → slug と topics を分離
3. フォールバック: JSON パース失敗時は slug のみ使用、topics は空

**テスト**: MD5 ファイルが HealingWorker で slug リネーム + topics 付与されること

### Step 4: BatchIngest での topics パススルー

1. `segmenter.ts`: `chunkAndIngest()` で `topics: []` を渡す
2. `go/main.go` (`handleBatchIngest`): `topics` を frontmatter にセット
3. HealingWorker が後追いで topics を補完

**テスト**: 自動生成エピソードに HealingWorker 後 topics が付与されること

### Step 5: Consolidation の topics 対応

1. `consolidation.go`: D1 生成プロンプトに topics 抽出を追加
2. D1 の topics = children の topics を包含する上位概念
3. フォールバック: LLM 失敗時は空

**テスト**: D1 ノードに children 由来の抽象的 topics が付与されること

### Step 6: `ep-recall` ファセット検索

1. `store.go`: `ListByTopic(topic string)` メソッド追加
2. `go/main.go` (`handleRecall`): `topics` フィルタパラメータ追加
3. ハイブリッド検索: ベクトル類似度 + topics 一致でスコアブースト

```go
// handleRecall パラメータ拡張
type RecallParams struct {
    Query  string   `json:"query"`
    TopK   int      `json:"topK"`
    Topics []string `json:"topics,omitempty"`  // NEW: ファセットフィルタ
}
```

**テスト**: `ep-recall query="..." topics=["go-language"]` で Go 関連エピソードのみ返ること

### Step 7: 既存エピソードのマイグレーション

1. `indexer.rebuild` に topics 生成パスを追加
2. rebuild 実行時: topics が空のエピソードに対して LLM で topics を生成
3. `healEmbedLimiter` と同じ低流量 limiter を使用

---

## 5. Topics Quality Guard

### 5.1 バリデーションルール

```go
func ValidateTopics(topics []string) ([]string, error) {
    var valid []string
    seen := make(map[string]bool)
    for _, t := range topics {
        t = strings.TrimSpace(t)
        if len(t) == 0 || len(t) > 50 {
            continue
        }
        // Unicode NFKC 正規化
        normalized := norm.NFKC.String(t)
        lower := strings.ToLower(normalized)
        if seen[lower] {
            continue  // 重複排除
        }
        seen[lower] = true
        valid = append(valid, normalized)
        if len(valid) >= 10 {
            break
        }
    }
    return valid, nil
}
```

### 5.2 LLM 汚染防御

slug と同様の Quality Guard を適用：
- topics 内に「以下は」「要約すると」等の LLM 汚染ワードを検出 → 除外
- 1 トピックが文章形式（スペース 5 個以上）→ 除外
- 全て除外された場合 → topics 空（エラーにはしない）

---

## 6. データフロー図

```
┌─────────────────────────────────────────────────────────┐
│ ユーザー会話                                              │
│  "goroutine と OS スレッドの違いを教えて"                    │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ segmenter.ts: processTurn()                             │
│  surprise > 0.2 → chunkAndIngest()                     │
│  tags: ["auto-segmented", "surprise-boundary"]          │
│  topics: []  (空 — HealingWorker に委譲)                  │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ Go: handleBatchIngest()                                 │
│  ① .md 書き込み（topics 空）                               │
│  ② EmbedContent → Pebble DB 登録                        │
│  ③ triggerHealing()                                     │
└──────────────────┬──────────────────────────────────────┘
                   │  2秒後
                   ▼
┌─────────────────────────────────────────────────────────┐
│ HealingWorker Pass 2 (slug + topics 同時生成)             │
│  Prompt: "Generate slug and topics as JSON..."          │
│  Response: {"slug":"goroutine-vs-threads",              │
│             "topics":["goroutine","concurrency",        │
│                       "go-language","スレッド比較"]}       │
│  ① .md リネーム + topics 書き込み                          │
│  ② Pebble DB 更新（topics フィールド追加）                  │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ 最終状態                                                 │
│  tags:   [auto-segmented, surprise-boundary]            │
│  topics: [goroutine, concurrency, go-language, スレッド比較]│
└─────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────┐
│ ep-save (手動保存)                                       │
│  content: "ゴルーチンのプール設計はバグを生みやすい"           │
│  topics: ["goroutine-pool", "バグ", "設計パターン"]        │
└──────────────────┬──────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────┐
│ Go: handleIngest()                                      │
│  tags: ["manual-save"]  ← システムが自動付与               │
│  topics: ["goroutine-pool", "バグ", "設計パターン"]        │
│  ↑ ユーザー指定のまま保存                                   │
└─────────────────────────────────────────────────────────┘
```

---

## 7. ep-recall ハイブリッド検索（将来）

### 7.1 検索モード

```
ep-recall query="goroutine" topics=["go-language"]
```

| モード | 動作 | 用途 |
|---|---|---|
| ベクトルのみ (現状) | embedding 類似度で TopK 取得 | 「これに似た記憶」 |
| ファセットのみ | `ListByTopic("go-language")` | 「Go 関連の全記憶」 |
| ハイブリッド | ベクトル TopK → topics 一致でリランク | 「Go 関連のこれに似た記憶」 |

### 7.2 リランキングアルゴリズム

```
final_score = vector_similarity * (1 + topic_boost * matched_topics_count)

topic_boost = 0.15  (1 topic 一致で 15% スコアブースト)
```

---

## 8. 後方互換性

| 既存機能 | 影響 | 対応 |
|---|---|---|
| 既存 .md ファイル | `topics` フィールドなし | `omitempty` で問題なし。パース時は空スライス |
| Pebble DB レコード | `Topics` フィールドなし | msgpack デコード時は零値（空スライス） |
| `ListByTag()` | 変更なし | `tags` のみスキャン。`topics` は別メソッド |
| `ep-save` ツール | `tags` → `topics` パラメータ名変更 | OpenClaw 側のツールスキーマ更新で対応 |
| Consolidation | `tags: ["d1-summary"]` は維持 | D1 に `topics` を追加するだけ |
| HealingWorker | Pass 2 slug 生成 | プロンプト拡張 + JSON パース追加 |

---

## 9. テストケース

| # | シナリオ | 検証内容 |
|---|---|---|
| TC-6.1-1 | 既存エピソード（topics なし）のパース | `topics` が空スライスとして読み込まれること |
| TC-6.1-2 | `ep-save` で topics 指定保存 | フロントマターに `topics:` セクションが出力されること |
| TC-6.1-3 | `ep-save` で CJK topics 保存 | 日本語トピック（例: `ゴルーチン`）が正常保存・検索可能 |
| TC-6.1-4 | HealingWorker Pass 2 で topics 自動生成 | MD5 ファイル → slug + topics が同時付与されること |
| TC-6.1-5 | topics Quality Guard | 50文字超・重複・LLM汚染ワードが除外されること |
| TC-6.1-6 | `ep-recall` ファセットフィルタ | `topics=["go-language"]` で Go 関連のみ返ること |
| TC-6.1-7 | D1 consolidation の topics 生成 | D1 に children の topics を包含する上位概念が付与されること |
| TC-6.1-8 | `indexer.rebuild` マイグレーション | topics 空のエピソードに LLM で topics が補完されること |

---

## 10. 実装優先度

| 優先度 | ステップ | 理由 |
|---|---|---|
| **P0** | Step 1: スキーマ拡張 | 後続全ステップの前提。破壊的変更なし |
| **P0** | Step 2: ep-save 対応 | ユーザーが手動保存時に topics を指定できる即効性ある改善 |
| **P1** | Step 3: HealingWorker 自動生成 | 全エピソードに topics が付与される仕組み |
| **P1** | Step 4: BatchIngest パススルー | 自動生成フローの完成 |
| **P2** | Step 5: Consolidation 対応 | D1 の topics は D0 の topics がないと生成不可 |
| **P2** | Step 6: ep-recall ファセット検索 | topics が蓄積されてから効果が出る |
| **P3** | Step 7: 既存マイグレーション | rebuild で一括補完。急がない |

---

## 11. 見積もり

| ステップ | 変更ファイル数 | 新規コード行数（概算） |
|---|---|---|
| Step 1 | 3 (frontmatter.go, store.go, types.ts) | ~20 |
| Step 2 | 3 (index.ts, rpc-client.ts, main.go) | ~30 |
| Step 3 | 1 (main.go HealingWorker) | ~60 |
| Step 4 | 2 (segmenter.ts, main.go) | ~15 |
| Step 5 | 1 (consolidation.go) | ~30 |
| Step 6 | 2 (store.go, main.go) | ~50 |
| Step 7 | 1 (main.go rebuild) | ~30 |
| Quality Guard | 1 (新規 topics_guard.go) | ~40 |
| **合計** | ~10 | ~275 |

---

## 12. 参照ドキュメント

| ドキュメント | 関連箇所 |
|---|---|
| `docs/compression_analysis_report.md` Section 12 | CJK 対応設計（slug の英語強制 vs topics の多言語許容） |
| `docs/compression_analysis_report.md` Section 13 | Quality Guard アーキテクチャ |
| `docs/phase_5.7_test_plan.md` | Sleep Consolidation テスト結果（D1 topics 生成の前提） |
| `docs/phase_5_integration_test_report.md` | Phase 5 全テスト PASS（Phase 6 開始の前提） |
| 論文: "Human-inspired Episodic Memory" (2024) | 意味的タグによる検索手がかりの多重化 |
