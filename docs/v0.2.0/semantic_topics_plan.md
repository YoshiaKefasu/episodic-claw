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
- 検索側も同じ NFKC + trim + ASCII casefold を使って照合する

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
- 既存クライアント互換のため、`tags` 入力は 1 リリースだけ deprecated alias として受ける
- `tags` を受けた場合は frontmatter の `tags` には入れず、`topics` 相当として扱う

### 2.4 自動補完（deterministic backfill）

Phase 1 では重い LLM 判定を足さず、既存の `topics` と legacy `tags` を保存経路で受け継ぐ。
`batchIngest` / HealingWorker は topics を「作る」より「壊さず運ぶ」側に寄せる。
LLM ベースの topics 抽出は将来フェーズに逃がす。

**補完タイミング**:

| シナリオ | topics の扱い | 備考 |
|---|---|---|
| `batchIngest` (自動) | 受信した `topics` をそのまま保存 | 未指定なら空のまま |
| `ep-save` (手動) | ユーザー指定の `topics` を保存 | `tags` は deprecated alias |
| `healing` / `rebuild` | 既存 `topics` を保持し、legacy `tags` を fallback で救済 | invent はしない |

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

1. HealingWorker Pass 2 では slug の確定を優先し、既存 `topics` があればそのまま引き継ぐ
2. 旧 frontmatter の `tags` は system tag を除いたうえで fallback topics として再利用する
3. topics が空でも失敗扱いにせず、保存と索引を壊さない

**テスト**: MD5 ファイルが HealingWorker で slug リネーム + topics 付与されること

### Step 4: BatchIngest での topics パススルー

1. `segmenter.ts`: `chunkAndIngest()` で `topics: []` を渡す
2. `go/main.go` (`handleBatchIngest`): `topics` を frontmatter にセット
3. HealingWorker は既存 `topics` を保持し、legacy `tags` がある場合だけ fallback で救済する

**テスト**: 自動生成エピソードが topics なしでも壊れず、legacy fallback で検索可能であること

### Step 5: Consolidation の topics 対応

1. `consolidation.go`: D1 topics を children topics から deterministic に集約する
2. D1 の topics = children の topics を包含する高頻度ラベル
   - 生成後に children topics の頻度とカバー率で並べ替え
   - `ValidateTopics()` を通したうえで最大 10 件に収める
   - ありふれた語を無理に言い換えず、まず安定して再現できるラベルを採る
3. フォールバック: child topics が空なら D1 topics も空でよい

**テスト**: D1 ノードに children 由来の抽象的 topics が付与されること

### Step 6: `ep-recall` ファセット検索

1. `store.go`: `ListByTopic(topic string)` メソッド追加
   - 書き込み時に同一の NFKC + trim + ASCII casefold をかけた normalized topic key -> episode IDs の逆引き索引を更新
   - 検索時は全件走査ではなく、逆引き索引を優先
   - 既存データの再構築時だけ scan ベースの fallback を使う
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

1. `indexer.rebuild` で既存エピソードを再取り込みし、`topics` の空欄を補完できる余地を残す
2. 旧データは `tags` からの互換 fallback で検索可能にしておく
3. 本格的な一括 backfill は Phase 1 の必須条件にしない

**テスト**: 既存データが `topics` なしでも壊れず、fallback 経路で検索可能であること

---

## 5. Topics Quality Guard

### 5.1 バリデーションルール

```go
func ValidateTopics(topics []string) ([]string, error) {
    var valid []string
    seen := make(map[string]bool)
    for _, t := range topics {
        t = strings.TrimSpace(t)
        if t == "" {
            continue
        }
        // Unicode NFKC 正規化
        normalized := norm.NFKC.String(t)
        if utf8.RuneCountInString(normalized) > 50 {
            continue
        }
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

> 注: `src/retriever.ts` の `assemble()` への反映は Phase 4 側の仕事として扱う。Phase 1 では保存基盤と explicit recall の topics 取り回しを先に固める。

---

## 8. 後方互換性

| 既存機能 | 影響 | 対応 |
|---|---|---|
| 既存 .md ファイル | `topics` フィールドなし | `omitempty` で問題なし。パース時は空スライス |
| Pebble DB レコード | `Topics` フィールドなし | msgpack デコード時は零値（空スライス） |
| `ListByTag()` | 変更なし | `tags` のみスキャン。`topics` は別メソッド |
| `ep-save` ツール | `tags` → `topics` パラメータ名変更 | OpenClaw 側のツールスキーマ更新で対応 |
| `ep-save` ツール（旧呼び出し） | `tags` を deprecated alias として受理 | 1 リリースの移行期間を設けて既存ワークフローを保護 |
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

---

## 13. 実装結果

### TS Side

- `src/types.ts` に `topics` を追加した
- `src/index.ts` の `ep-save` が `topics` 主体で動き、`tags` は deprecated alias として受ける
- `src/rpc-client.ts` が `topics` を `ai.ingest` と `ai.recall` に載せるようになった
- `src/segmenter.ts` の batch item には明示的に `topics: []` を入れた
- `npm run build:ts` は 2026-03-29 に成功確認済み

### Go Side

- `go/frontmatter/frontmatter.go` の `EpisodeMetadata` に `Topics` を追加した
- `go/internal/vector/store.go` の `EpisodeRecord` に `Topics` と reverse topic index を追加した
- `go/main.go` で `ai.ingest` / `ai.batchIngest` / `ai.recall` / healing / rebuild に topics を通した
- `go/internal/vector/consolidation.go` で D1 topics を child topics から deterministic に集約するようにした
- `go build ./...` は 2026-03-29 に成功確認済み

### 残リスク

- 旧データの一括 backfill はまだ任意タスク。`tags` fallback で検索は成立するが、全ファイルの `topics` 物理補完まではしていない
- `src/retriever.ts` / `assemble()` の topic-aware 統合は Phase 4 に残している

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-29
> Mode: Pre-Implementation
> Prior audits: 0 | New findings this round: 3

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| なし | 初回監査 |

### ⚠️ Impact on Related Features *(new only)*
- `ep-save` の `tags -> topics` 置換は、現在の手動保存ツール契約をそのまま壊す。既存のワークフローが `tags` を渡している場合、互換性ブリッジなしでは即時に壊れる。
- `topics` を保存しても、日常的な memory injection の主経路である `src/retriever.ts` / `assemble()` はこのドキュメントの変更対象に入っていない。つまり、通常の自動回収は `topics` の恩恵を受けないままになる。
- `ListByTopic()` を Pebble 全件走査のまま実装すると、データが増えたときに topic facet が検索コストのボトルネックになる。CJK を許す設計なのに、照合規則が未定義だと取りこぼしも出る。

### 🚨 Potential Problems & Risks *(new only)*
- `ep-save` はユーザー向けの入口なので、パラメータ名の破壊的変更は影響が大きい。少なくとも一時的な deprecated alias か移行期間の明記がないと、Phase 1 が「基盤追加」ではなく「保存 UX 破壊」になり得る。
- `topics` の正規化は書き込み側だけでなく、検索側の入力にも必要だが、ドキュメントでは query 側の NFKC / casefold 方針が曖昧なまま。保存と検索で正規化がズレると facet hit が不安定になる。
- ファセット検索の効果は、`topics` の蓄積量に強く依存する。自動生成やマイグレーションが遅延すると、機能はあるのに結果が薄い状態が長く続く。

### 📋 Missing Steps & Considerations *(new only)*
- `ep-save` の backward compatibility 方針がない。`tags` を完全削除するなら移行手順、残すなら deprecated alias 期間を明示すべき。
- `src/retriever.ts` / `EpisodicRetriever` をどう扱うかが未記載。`topics` を入れても、assemble 系の自動 recall に反映される時期が不明だと期待値がずれる。
- `ListByTopic()` のインデックス戦略がない。小規模なら scan でも回るが、将来の検索品質を考えると reverse index か topic key の正規化ルールが必要。

### 🕳️ Unaddressed Edge Cases *(new only)*
- 既存の `ep-save` 呼び出しが `tags` 前提のままだと、手動保存だけが silent に壊れる可能性がある。
- `topics` の Unicode 表記揺れがあると、保存時に正規化しても検索時に取りこぼす。
- topic facet が大きくなった場合、`ListByTopic()` の全件走査はレイテンシを吸い始める。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| HIGH | `ep-save` の `tags` 変更は破壊的に切らず、deprecated alias か移行期間を入れる | 手動保存の既存ワークフローを壊さないため | ✅ New |
| HIGH | `topics` を `src/retriever.ts` / 自動回収の将来経路にどう渡すかを明文化する | 主要な memory injection で恩恵が見えないまま終わるのを防ぐため | ✅ New |
| MED | `ListByTopic()` に query-side 正規化と、将来の reverse index 方針を追加する | CJK / 言語揺れと O(N) scan の両方に備えるため | ✅ New |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-29
> Mode: Pre-Implementation
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| `ep-save` の `tags -> topics` 置換は破壊的 | ✅ Resolved |
| `src/retriever.ts` / `assemble()` が Phase 1 で対象外 | ✅ Resolved |
| `ListByTopic()` の scan / normalization ambiguity | ✅ Resolved |

<!-- ✅ No new critical issues found. Document has converged. -->

---

## Phase 4 反映メモ（v0.2.0）

topics の recall facet を運用で壊さないために、`ai.recall` には次の使い分けを入れている。

- `topics + strictTopics=true`: facet filter（ep-recall 向け）
  - reverse index が未整備な場合は legacy scan fallback
- `topics + strictTopics=false`: boost-only hint（自動 recall 向けの将来拡張）

この分離で、「topics を指定したのに空になる」「topics がまだ薄い期間に recall が死ぬ」を避けられる。

### ⚠️ Impact on Related Features *(new only)*
- 該当なし

### 🚨 Potential Problems & Risks *(new only)*
- 該当なし

### 📋 Missing Steps & Considerations *(new only)*
- 該当なし

### 🕳️ Unaddressed Edge Cases *(new only)*
- 該当なし

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| LOW | Phase 1 はこのまま実装可能 | 既存の互換性・検索正規化・索引方針の穴を埋めたため | 🔁 Carry-over |

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-29  
> Mode: Post-Implementation  
> Prior audits: 2 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| `ep-save` の `tags -> topics` 置換は破壊的 | ✅ Resolved |
| `src/retriever.ts` / `assemble()` が Phase 1 で対象外 | ✅ Resolved |
| `ListByTopic()` の scan / normalization ambiguity | ✅ Resolved |

<!-- ✅ No new critical issues found. Document has converged. -->

### ⚠️ Impact on Related Features *(new only)*
- 該当なし

### 🚨 Potential Problems & Risks *(new only)*
- 該当なし

### 📋 Missing Steps & Considerations *(new only)*
- 該当なし

### 🕳️ Unaddressed Edge Cases *(new only)*
- 該当なし

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| LOW | Phase 1 の保存基盤と topic reverse index はこのまま進めてよい | 破壊的変更は避けられており、後方互換も保たれている | 🔁 Carry-over |
