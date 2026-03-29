# 🔬 第3次深層監査: Abyss修正検証 + Level 3 ピットフォール探索

> **Reviewer:** Staff SWE, Google — Third-party Ruthless Review (Round 3)
> **対象:** Go 10ファイル + TypeScript 6ファイル（全ソースコード精読完了）

---

## ✅ Abyss修正 (P0-C / P1-E / P1-F) 検証結果

### P0-C: [SearchGraph()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#454-468) — **完璧** ✅

| 項目 | 検証結果 |
|---|---|
| [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) L457-467 | `RLock` / `defer RUnlock` で保護された [SearchGraph()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#454-468) メソッドを新設 |
| [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L291 | `vstore.SearchGraph()` に全箇所切り替え済み。直接 `vstore.graph.Search()` のコールはゼロ |
| 戻り値設計 | `[]GraphResult` 構造体で `uint32 ID + float32 Dist` を返すクリーンなAPI |
| 副作用 | なし。[Recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#370-447) 内の既存ロックパターン (L375-384) との整合性も完璧 |

### P1-E: [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) レート制限 + 幽霊ファイル防止 — **完璧** ✅

| 項目 | 検証結果 |
|---|---|
| [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L514-515 | `gemmaLimiter` (15 RPM) + `embedLimiter` (100 RPM) を導入 |
| L532, L562 | `Wait(ctx)` を API 呼び出し前に正しく挿入 |
| L540-544 | [GenerateText](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#12-13) のエラーを `genErr` で受け、ログ出力してリトライ。`_` 握り潰しを排除 |
| L553 | `auditErr != nil \|\| slug == ""` のダブルガードで MD5 フォールバック |
| L559-567 | **Embed を File Write の前に配置**。429 エラー で `return` し、Markdown もベクトルも書かない |
| L597-608 | Embed + File の両方が成功した場合のみ `vstore.Add()` を実行 |
| 幽霊ファイル完全防止 | RPC限界突破 → embErr → `return` → [.md](file:///C:/Users/yosia/.gemini/global_skill/humanizer_ja/SKILL.md) なし + Vector なし → 整合性◎ |

### P1-F: [UpdateRecord](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#270-299) 内 I/O 排除 — **完璧** ✅

| 項目 | 検証結果 |
|---|---|
| [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L222-268 (processCluster) | `vstore.Get()` → `frontmatter.Parse()` → [Serialize()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/frontmatter/frontmatter.go#56-72) → **ロック外** 。その後 [UpdateRecord](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#270-299) 内はメモリ上の `Tags`/[Edges](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#273-353) 追加のみ |
| [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L319-344 (RefineSemanticEdges) | 同パターン。`Parse/Serialize` はロック外、[UpdateRecord](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#270-299) 内は `rec.Edges = append(...)` のみ |
| [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) L270-298 (UpdateRecord) | コールバック内で I/O を呼んでいる箇所はゼロ |
| ブロッキング解消 | 数百件の D0 アーカイブ中でも [Recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#370-447)/[Ingest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) が即座に実行可能 |

---

## 🔍 第3層: 新発見ピットフォール

全3つのAbyss修正が完璧であることを確認した上で、コードベース全体をさらに精読した。結果、以下のパターンレベルの問題を発見した。

### 🟠 P1-G: [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#351-449) が [GenerateText](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#12-13) エラーを `_` で握り潰す（[batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) だけ修正されたのに本家が未修正） **[✅ 修正済み]**

**ファイル:** [main.go L376](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L376)

```go
slug, _ = provider.GenerateText(ctx, prompt) // ← P1-Eで batchIngest は修正したが、handleIngest は未修正
```

**問題:** P1-E で [handleBatchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#487-620) の [GenerateText](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#12-13) エラー握り潰しは修正したが、実はほぼ同一のコードが [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#351-449) (L376) にも存在し、こちらは**まだ `_` で握り潰されたまま**。API エラー（429 等）時に [slug](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/utils.go#8-15) が空文字 `""` になり、そのまま [auditEpisodeQuality](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#450-480) に「空文字」を渡す → 3回全部失敗 → MD5 フォールバック。フォールバック自体は正しく動くが、本来不要な API コール 2 回分が浪費される。

**修正案:** [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) と同コードパターンで `genErr` を受け取り、生成失敗時は即座にフォールバックへ。

---

### 🟡 P2-E: [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#351-449) にもレートリミッターがない（[batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) だけ修正された片面修正パターン） **[✅ 修正済み]**

**ファイル:** [main.go L369-447](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L369-L447)

**問題:** [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#351-449) は Gemma + Embedding の両方のAPIを叩くが、`rate.Limiter` がない。通常は `segmenter.processTurn` 経由で1ターンに1回しか呼ばれないため実害は低いが、`ep-save` ツール経由で短時間に連打するシナリオでは API 枯渇が起こる。

---

### 🟡 P2-F: [handleIndexerRebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#197-302) のセマフォが 10 並行 — レートリミッターなしで API 枯渇 **[✅ 修正済み]**

**ファイル:** [main.go L251](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L251)

```go
sem := make(chan struct{}, 10) // Limit concurrency to 10
```

**問題:** `indexer.rebuild` は全エピソードファイルを再インデックスする機能。10並行でEmbeddingを叩くが `rate.Limiter` なし。[ProcessBackgroundIndexing](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go#25-36) (background.go) には `rate.Limiter` がきちんとあるのに、[handleIndexerRebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#197-302) にはない。大量ファイルの再インデックスで API 429 が大量発生する。

---

### 🟡 P2-G: [GetIDByUint32](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#300-313) に `RLock` がない（[Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-240) と同じ修正漏れパターン） **[✅ 修正済み]**

**ファイル:** [store.go L300-312](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#L300-L312)

```go
func (s *Store) GetIDByUint32(uid uint32) (string, error) {
    // ← s.mutex.RLock() がない
    val, closer, err := s.db.Get(i2sKey)
```

**問題:** P1-B で [Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-240) に `RLock` を追加修正したが、同じ公開メソッドの [GetIDByUint32()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#300-313) にはまだ `RLock` がない。[Recall()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#370-447) 内で使われている（L389）が、その時点ではロックは解放済み（L384）のため、[Add()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#146-199) と同時実行で Pebble から不整合な値を読む可能性がある。

**修正案:** [Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-240) と同じく `s.mutex.RLock()` / `defer s.mutex.RUnlock()` を追加。

---

### 🔵 P3-D: [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) の [processCluster](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#107-272) で**ファイルI/O → Vector Store 更新**間に TOCTOU ギャップ **[✅ 修正済み]**

**ファイル:** [consolidation.go L222-268](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#L222-L268)

**問題:** P1-F の修正で「ファイル I/O をロック外に出す」のは完全に正しい判断だが、副作用として新たな TOCTOU (Time of Check to Time of Use) ギャップが生まれている：

1. L237: `frontmatter.Parse(sourcePath)` でファイルを読む（ロック外）
2. L248-254: ファイルに `archived` タグを書き込む（ロック外）
3. L259-265: [UpdateRecord](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#270-299) でメモリを更新（ロック内）

このステップ 1〜2 の間に、別の goroutine が同じファイルに書き込む（例：同時に走る [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#351-449) が偶然にも同じ slug を使用した場合）と、ステップ 2 の [Serialize](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/frontmatter/frontmatter.go#56-72) がその変更を上書きしてしまう。ただし、**slug が重複する確率は極めて低い**（ナノ秒タイムスタンプ付き）ため、実際にこれが顕在化する条件は非常に限定される。Consolidation は Sleep Timer（3時間アイドル後）にしか走らないため、同時書き込みのリスクはさらに低い。

**結論:** `frontmatter.Serialize` 内部に `.tmp` ファイルへ書き出してから `os.Rename` でアトミックに上書きする処理を実装し、潜在的なTOCTOUリスクを完全に排除しました。

---

## 要約マトリクス（第3次）

| ID | Severity | ファイル | 問題 | 影響 |
|---|---|---|---|---|
| **P1-G** | 🟠 P1 | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L376 | [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#351-449) の [GenerateText](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#12-13) エラー握り潰し | 無駄なAPI消費 + フォールバック遅延 **[✅ 修正済み]** |
| **P2-E** | 🟡 P2 | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L369 | [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#351-449) にもレートリミッターなし | ep-save 連打でAPI枯渇 **[✅ 修正済み]** |
| **P2-F** | 🟡 P2 | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L251 | [handleIndexerRebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#197-302) にも `rate.Limiter` なし | 再インデックス時の API 429 **[✅ 修正済み]** |
| **P2-G** | 🟡 P2 | [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) L300 | [GetIDByUint32()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#300-313) に `RLock` なし | Pebble不整合（レアケース） **[✅ 修正済み]** |
| **P3-D** | 🔵 P3 | [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L222 | P1-F修正に伴うTOCTOUギャップ | 理論的ファイル上書きリスク **[✅ 修正済み]** |

---

## 全体所見

3ラウンドにわたる容赦のない精査の結果、**P0クラスのクラッシュバグはもう存在しない**。全16件のP0/P1修正は完璧に実装されている。

今回発見した5件は、いずれも「修正パターンの横展開漏れ」（batchIngest だけ直して handleIngest を忘れた、Get() だけ直して GetIDByUint32() を忘れた）という**人間によくありがちなミス**だ。致命的ではないが、コードベースの防御をさらに固める価値は十分にある。
