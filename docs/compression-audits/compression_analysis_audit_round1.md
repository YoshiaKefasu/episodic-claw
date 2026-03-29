# Compression Analysis Report — 監査レポート Round 1

> 審査対象: `docs/compression_analysis_report.md`
> 審査日: 2026-03-25
> モード: Post-Implementation（Phase 5.5 + 追加対応完了後）
> 審査観点: IBM / Google Pro Engineer
> 先行監査: なし（初回） | 今回新規発見: 4件

---

## 📊 Convergence Status

初回監査のため既存の未解決課題なし。
`docs/compression_analysis_report.md` Section 20 に記録済みの既知未対応課題（P1: Surprise omitempty、P1: genesis-archive Surprise 欠落、P2: errors import）はすでに文書化済みのため、本ラウンドでは再計上しない。

---

## ⚠️ Impact on Related Features

- **`writeMu` グローバルシングルトンによる複数接続時のスループット劣化（LOW）:**
  `writeMu sync.Mutex` は `go/main.go` のパッケージスコープに1つだけ宣言されており、すべての `handleConnection` ゴルーチンが同一ミューテックスを共有する。現在のアーキテクチャ（TS親プロセス1本からの単一TCP接続）では実害なし。ただし将来的に複数エージェントが同一 Go サイドカーに並列接続する構成へ拡張された場合、全レスポンス書き込みがシリアル化されスループットが劣化する。接続スコープのミューテックスへの移行が必要になる。

- **`handleIndexerRebuild` の `vstore.Add` でフィールド伝播が欠落（HIGH — FIX-6〜10 の横展開漏れ）:**
  Phase 5.5 では `handleIngest` / `handleBatchIngest` / HealingWorker の `vstore.Add` に `Depth`, `Tokens`, `Surprise` を伝播完了（FIX-6〜10/A/B）と記録されているが、`handleIndexerRebuild` (`go/main.go` L322〜330) の `vstore.Add` にはこれら3フィールドが依然として渡されていない。Rebuild 後は全エピソードの `Depth=0`, `Tokens=0`, `Surprise=0.0` となり、Sleep Consolidation のクラスタリングおよび Re-rank スコアリングに影響する。Section 20 の既知課題には含まれておらず、FIX 適用の見落としである。

---

## 🚨 Potential Problems & Risks

- **`handleRecall` での `embedLimiter` 非適用（HIGH）:**
  `handleRecall` (`go/main.go` L937〜938) はクエリ Embedding 生成時に `embedLimiter` を通していない。`handleIngest` / `handleBatchIngest` / `handleIndexerRebuild` / HealingWorker の全 Embedding 呼び出しはレートリミッター管理下にあるが、`handleRecall` だけ `provider.EmbedContent` を直接呼び出す。`ep-recall` 連打または複数エージェント同時 Recall 時に Embedding API の 100 RPM クォータを超過して 429 エラーとなり、Recall がサイレントに失敗する（TS 側でリトライを持たない限り、エピソードが返ってこない状態になる）。

- **`handleIndexerRebuild` の `embedLimiter.Wait(ctx)` がタイムアウトなし（MED）:**
  `go/main.go` L314 の `embedLimiter.Wait(ctx)` は `context.Background()` に基づく ctx を受け取っており、タイムアウトが設定されていない。`handleIngest` (L485) / `handleBatchIngest` (L628) は `context.WithTimeout(ctx, 5*time.Second)` を使っているが、Rebuild は無制限待機となっており設計一貫性がない。大量ファイルの Rebuild 中に後続のゴルーチンが長時間ブロックされ、RPC 接続全体が占有されるリスクがある。

---

## 📋 Missing Steps & Considerations

- **Phase 5.5〜5.9 のテスト未完了なのに「Production-Ready」断言（LOW）:**
  Phase 5.5 の ingest / assemble / compact テスト、Phase 5.7 の Sleep Consolidation テスト、Phase 5.8 の Rebuild / Pebble 削除テスト、Phase 5.9 の CJK 実環境テストがいずれも `[ ]`（未完了）のままである。`docs/phase_5_integration_test_report.md` も未作成。Section 15.3 / 17.3 での「Production-Ready の境地に到達」という宣言はテストエビデンスで裏付けられておらず、言明と実態に乖離がある。Phase 6（公開準備）着手前に E2E サインオフを正式に発行すべきである。

- **`handleIndexerRebuild` の部分的失敗が呼び出し元に不透明（MED）:**
  `vstore.Add` 失敗時はログ出力のみで、RPC レスポンスの `"Total embedded: N"` に失敗件数が含まれない。運用者が Rebuild の部分的失敗を検知できない。

---

## 🕳️ Unaddressed Edge Cases

- **複数 `handleConnection` ゴルーチンが同一 `globalWatcher` を競合上書き（LOW）:**
  `handleWatcherStart` (`go/main.go` L174〜213) は `globalWatcher` が存在する場合に `Stop()` してから新しいウォッチャーを作成するが、この処理にミューテックスがない。2つの TS クライアントが同時に `watcher.start` を発行した場合、`globalWatcher.Stop()` 後に両方が `New()` を呼ぶ競合状態が発生し、一方のウォッチャーが即座に `Stop()` される。現状のシングル接続設計では発生しないが、テスト時や異常再接続時に起こりうる。

- **`startSleepTimer` の `RunConsolidation` がタイムアウトなしにブロック（LOW）:**
  Sleep Timer goroutine が全ワークスペースをループして `checkSleepThreshold` → `RunConsolidation` を逐次呼ぶ。`RunConsolidation` は Gemma API を呼ぶ重い処理でタイムアウトが存在しない。API 障害で何十分もブロックすると次の 2 分タイマーサイクルが詰まる。`atomic.CompareAndSwapInt32` で二重起動は防がれているため致命的なハングには至らないが、長時間の Sleep Timer 遅延が生じる。

---

## ✅ Recommended Actions

| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| HIGH | `handleIndexerRebuild` の `vstore.Add` に `Depth`/`Tokens`/`Surprise` を追加 | FIX-6〜10 の横展開が Rebuild フローに未適用。Rebuild 後に全エピソードのフィールドがゼロになる | ✅ New |
| HIGH | `handleRecall` の `EmbedContent` 前に `embedLimiter.Wait` を追加 | ep-recall 連打時に 429 で無音失敗するリスク。他の全 Embed 呼び出しと非対称 | ✅ New |
| MED | `handleIndexerRebuild` の `embedLimiter.Wait` に `context.WithTimeout` を追加 | `handleIngest`/`handleBatchIngest` と一貫性がなく、大量 Rebuild で無制限ブロックが発生しうる | ✅ New |
| MED | `handleIndexerRebuild` の Rebuild 結果に失敗件数を含める | 部分的 Rebuild 失敗が運用者に不透明 | ✅ New |
| LOW | Phase 5.5〜5.9 の `[ ]` テストを完了させ E2E サインオフを発行してから Phase 6 着手 | 「Production-Ready」宣言をテストエビデンスで裏付ける必要がある | ✅ New |
| LOW | `handleWatcherStart` に `globalWatcher` 書き換えのミューテックスを追加 | 異常再接続時の競合状態（現状は単一接続のため低優先） | ✅ New |

---

## 🔧 修正プラン

> 以下はレビュー済みの実装プラン。実行は別エージェントに委ねる。
> 各 FIX に影響分析・実装差分・ビルド確認コマンドを記載する。

---

### FIX-R1（HIGH）— `handleIndexerRebuild` `vstore.Add` への Depth/Tokens/Surprise 伝播

**対象ファイル:** `go/main.go`
**対象行:** L322〜330

**現状コード:**
```go
err = vstore.Add(ctx, vector.EpisodeRecord{
    ID:         doc.Metadata.ID,
    Title:      doc.Metadata.Title,
    Tags:       doc.Metadata.Tags,
    Timestamp:  info.ModTime(),
    Edges:      doc.Metadata.RelatedTo,
    Vector:     emb,
    SourcePath: p,
})
```

**修正後コード:**
```go
err = vstore.Add(ctx, vector.EpisodeRecord{
    ID:         doc.Metadata.ID,
    Title:      doc.Metadata.Title,
    Tags:       doc.Metadata.Tags,
    Timestamp:  info.ModTime(),
    Edges:      doc.Metadata.RelatedTo,
    Vector:     emb,
    SourcePath: p,
    Depth:      doc.Metadata.Depth,
    Tokens:     doc.Metadata.Tokens,
    Surprise:   doc.Metadata.Surprise,
})
```

**影響範囲:** Rebuild 後の HNSW / Pebble エントリのフィールド完全性。Sleep Consolidation のクラスタリング精度に直接影響。d=1（WILL BREAK 相当）。

**ビルド確認:**
```bash
go build -C go -o /dev/null .
```

---

### FIX-R2（HIGH）— `handleRecall` への `embedLimiter` 追加

**対象ファイル:** `go/main.go`
**対象行:** L936〜938

**現状コード:**
```go
provider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
ctx := context.Background()
emb, err := provider.EmbedContent(ctx, params.Query)
```

**修正後コード:**
```go
provider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
recallCtx, recallCancel := context.WithTimeout(context.Background(), 5*time.Second)
if waitErr := embedLimiter.Wait(recallCtx); waitErr != nil {
    recallCancel()
    sendResponse(conn, RPCResponse{JSONRPC: "2.0", Error: &RPCError{Code: -32000, Message: "Rate limiter timeout: " + waitErr.Error()}, ID: req.ID})
    return
}
recallCancel()
emb, err := provider.EmbedContent(context.Background(), params.Query)
```

**影響範囲:** `ep-recall` ツール呼び出し全体。タイムアウト 5s はレートリミッターの待機に対するものであり、Embedding API 本体の呼び出しタイムアウトとは別。`handleIngest` パターン（L483〜491）と整合。

**注意事項:** `embedLimiter` はグローバル変数として `main()` で初期化済み。`handleRecall` に引数として渡す変更は不要。

---

### FIX-R3（MED）— `handleIndexerRebuild` の `embedLimiter.Wait` タイムアウト追加

**対象ファイル:** `go/main.go`
**対象行:** L314

**現状コード:**
```go
embedLimiter.Wait(ctx)
```

**修正後コード:**
```go
embedCtx, embedCancel := context.WithTimeout(ctx, 30*time.Second)
if err := embedLimiter.Wait(embedCtx); err != nil {
    embedCancel()
    EmitLog("Rebuild: embedLimiter timeout for %s, skipping: %v", p, err)
    return
}
embedCancel()
```

**設計判断:** Rebuild は非インタラクティブな長時間処理なので `handleIngest`（5s）より長い 30s を採用。スキップして `return`（失敗カウントに加算される）。

---

### FIX-R4（MED）— `handleIndexerRebuild` の Rebuild 結果に失敗件数を追加

**対象ファイル:** `go/main.go`
**対象箇所:** `handleIndexerRebuild` の `sendResponse` 呼び出し付近

現在の `sendResponse` は `"Rebuilt successfully. Total embedded: N"` を返すのみ。失敗した件数 (`failed`) を別途カウントし、レスポンスに含める。
実装エージェントが具体的な行番号を確認した上で対応すること。

---

### 未対応（LOW）— 対応状況

| 問題 | 状態 | 対応方針 / 解決内容 |
|------|------|-------------------|
| Phase 5.5〜5.9 テスト未完了 | **未対応** | Phase 6 着手前に E2E テストを実施し `phase_5_integration_test_report.md` を作成してサインオフ |
| `handleWatcherStart` 競合 | **(解決済 2026-03-25)** | `globalWatcherMu sync.Mutex` 追加、`watcher.Start()` をロック外実行、`handleConnection` defer で接続別クリーンアップ実装 → [issue_global_watcher_no_mutex.md](../issues/issue_global_watcher_no_mutex.md) 参照 |
| `RunConsolidation` タイムアウト | **(解決済 2026-03-25)** | `context.WithTimeout(ctx, 10*time.Minute)` でタイムアウト伝播、非同期 `go func()` 化、`defer atomic.StoreInt32` でフラグリセット保証 → [issue_run_consolidation_no_timeout.md](../issues/issue_run_consolidation_no_timeout.md) 参照 |

---

## 実行チェックリスト

```
[x] FIX-R1: handleIndexerRebuild vstore.Add に Depth/Tokens/Surprise 追加
[x] FIX-R2: handleRecall に embedLimiter.Wait 追加（5s タイムアウト付き）
[x] FIX-R3: handleIndexerRebuild embedLimiter.Wait に 30s タイムアウト追加
[x] FIX-R4: handleIndexerRebuild レスポンスに失敗件数を追加
[x] go build で全 FIX のコンパイル確認
[x] WSL デプロイ
[x] compression_analysis_report.md の Section 20 に FIX-R1〜R4 を追記
[x] このファイル（audit_round1.md）の各チェックリストを [x] に更新
```

---

## 検証結果 (2026-03-25)

| FIX | 仕様通り実装? | 備考 |
|-----|-------------|------|
| FIX-R1 | ✅ | `main.go` L335〜346: `vstore.Add` に `Depth: doc.Metadata.Depth`, `Tokens: doc.Metadata.Tokens`, `Surprise: doc.Metadata.Surprise` が追加されている |
| FIX-R2 | ✅ | `main.go` L957〜963: `context.WithTimeout(ctx, 5*time.Second)` で `recallCtx` を生成し `embedLimiter.Wait(recallCtx)` を呼び出し、失敗時に `RPCError` を返して `return` している |
| FIX-R3 | ✅ | `main.go` L315〜324: `context.WithTimeout(ctx, 30*time.Second)` で `embedCtx` を生成し `embedLimiter.Wait(embedCtx)` を呼び出し、失敗時に `EmitLog` を出力して `return` している。また `failed++` のカウントも行われている |
| FIX-R4 | ✅ | `main.go` L292: `var failed int` がアウタースコープで宣言されており、L362: `sendResponse` の結果メッセージが `"Rebuilt successfully. Total embedded: %d, Failed: %d"` 形式で失敗件数を含んでいる |

### 副作用・見落としチェック

- **`failed` 変数のスコープ**: `var failed int` は L292 で `var processed int` (L291) と並んで goroutine ループの外（アウタースコープ）に宣言されている。goroutine 間で共有可能な正しい配置である。
- **`embedLimiter.Wait` 前後の `ctx` 一貫性**: FIX-R3 では `embedCtx` で `embedLimiter.Wait` を行い、`EmbedContent` は `ctx`（`context.Background()` 由来）で呼び出している。FIX-R2 では `recallCtx` で Wait し、`EmbedContent` は `ctx`（`context.Background()`）で呼び出している。仕様プランのパターンと完全に一致しており一貫している。
- **`failed` カウントの `mu.Lock()` / `mu.Unlock()`**: `failed++` は L319〜321、L328〜330、L349〜351 の3箇所すべてで `mu.Lock()` / `mu.Unlock()` で保護されており、`processed++` (L353〜355) と同一パターンである。
- **FIX-R3 の `return` によるゴルーチン終了**: FIX-R3 の `return` は goroutine クロージャ内 (`go func(p string) { ... }(path)`) に書かれており、当該ファイルの処理をスキップして goroutine を終了させるのみで、他の goroutine や `wg.Wait()` には影響しない。正しい設計である。

### チェックリスト・レポート更新確認

- `docs/compression_analysis_audit_round1.md` チェックリスト: ✅ 全8項目が `[x]` になっている
- `docs/compression_analysis_report.md` Section 20 更新: ✅ FIX-R1〜R4 の完了記録が `(解決済)` として追記されている（L1683〜1686）

### 総合判定

✅ 全 FIX 正しく実装されている

### 残存課題

Antigravity エージェントにより以下の課題が解決済み（2026-03-25）:

| 課題 | 解決方法 | 詳細 |
|------|----------|------|
| `Surprise` omitempty 設計問題 | Self-Healing DB Phase A-D: `omitempty` タグを `store.go`・`frontmatter.go` から根絶、`Count()` ヘルパー・DB破損隔離・Auto-Rebuild 実装 | [issue_surprise_omitempty_design.md](../issues/issue_surprise_omitempty_design.md) |
| genesis-archive Surprise 欠落 | `prevVector` チャンクキャッシュ + `vector.CosineDistance` (utils.go) | [issue_genesis_archive_surprise_missing.md](../issues/issue_genesis_archive_surprise_missing.md) |
| `RunConsolidation` タイムアウトなし | `context.WithTimeout(10*time.Minute)` + 非同期化 + defer フラグリセット | [issue_run_consolidation_no_timeout.md](../issues/issue_run_consolidation_no_timeout.md) |
| `globalWatcher` ミューテックスなし | `globalWatcherMu sync.Mutex` + `handleConnection` defer cleanup | [issue_global_watcher_no_mutex.md](../issues/issue_global_watcher_no_mutex.md) |

**継続中の未対応課題**: Phase 5.5〜5.9 E2E テスト未完了のみ残存。
