# Episodic Memory Plugin (Phase 1 & 1.5)

## 1. Project Initialization
- [x] 1.1 Create project directory `d:\GitHub\OpenClaw Related Repos\episodic-claw`.
- [x] 1.2 Initialize TypeScript plugin structure ([package.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/package.json), [tsconfig.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/tsconfig.json), [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts)).
- [x] 1.3 Initialize Go module (`go mod init episodic-core`) in [go/](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) subfolder.

## 2. Go Core Implementation (Markdown I/O & Watcher)
- [x] 2.1 Implement `frontmatter` parsing and serializing (using `gopkg.in/yaml.v3`).
- [x] 2.2 Implement `watcher` using `fsnotify` for the `episodes/` directory tree.
- [x] 2.3 Implement file debouncing (1500ms) for watcher events.
- [x] 2.4 Implement basic [rebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#175-178) logic to traverse `episodes/**/*.md` and extract metadata.

## 3. Go JSON-RPC Server
- [x] 3.1 Setup JSON-RPC server listening on stdout/stdin or localhost TCP.
- [x] 3.2 Define basic RPC methods and event broadcasting.

## 4. TypeScript RPC Client & Plugin Integration
- [x] 4.1 Implement [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) to communicate with the Go sidecar.
- [x] 4.2 Register OpenClaw plugin configuration ([openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json)).
- [x] 4.3 Start/Stop Go sidecar process from TypeScript plugin lifecycle.

## 5. Testing
- [x] 5.1 Test file creation and ensure Go watcher notifies TS correctly.

## 6. Phase 1.5 (Recovered TS Fundamentals)
- [x] 6.1 Implement [src/types.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/types.ts) (EpisodeMetadata, Edge, EpisodicPluginConfig).
- [x] 6.2 Implement [src/config.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/config.ts) (Config parsing and defaults).
- [x] 6.3 Refactor [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) to export default function [register(api: OpenClawPluginApi)](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#21-139).
- [x] 6.4 Set up OpenClaw Plugin lifecycle hooks (`api.on("start")`, `api.registerContextEngine`).
- [x] 6.5 Update [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) exports to use centralized [types.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/types.ts).

## 7. Phase 2 (Segmenter + AI Integration in Go Sidecar)
- [x] 7.1 Go: Define abstract [EmbeddingProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#6-9) and [LLMProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#11-14) interfaces to support future OpenAI-compatible/Ollama injection.
- [x] 7.2 Go: Implement Google AI Studio provider for both `gemini-embedding-2-preview` and `gemma-3-27b-it` as the Stage 1 default.
- [x] 7.3 Go: Implement [Surprise](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#308-341) endpoint using the [EmbeddingProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#6-9).
- [x] 7.4 Go: Implement [Ingest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#199-202) endpoint to generate Slug via the [LLMProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#11-14) and write Markdown files.
- [x] 7.5 TS: Implement [src/segmenter.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/segmenter.ts) (Buffer management, Surprise RPC calls).
- [x] 7.6 TS: Update [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) to implement [ingest(ctx)](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/context-engine.test.ts#273-276) logic within `api.registerContextEngine` and call Phase 2 RPCs.
- [x] 7.7 Test: Feed dummy conversations and verify that an episode file is automatically created and named correctly by Gemma 3.
- [x] 7.8 Test: Verify end-to-end pipeline with a real Gemini API key ensuring `gemini-embedding-2-preview` distance calculation and `gemma-3-27b-it` slug generation work correctly.
## 8. Phase 3 (Retrieval + Compile HNSW/Pebble)
- [x] 8.1 Go: Add dependencies `github.com/sahib/hnswlib-go` and `github.com/cockroachdb/pebble`.
- [x] 8.2 Go: Create [internal/vector/store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) for the Pebble + HNSW store architecture.
- [x] 8.3 Go: Update [Ingest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#199-202) RPC to save metadata+embedding to Pebble and index to HNSW.
- [x] 8.4 Go: Implement [Recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#290-360) RPC (HNSW top-K + Temporal Re-rank via Pebble).
- [x] 8.5 Go: Implement [Rebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#188-293) RPC (scan all [.md](file:///Y:/kasou_yoshia/.openclaw/workspace-system_engineer/SOUL.md), re-embed, upsert to Pebble/HNSW).
- [x] 8.6 TS: Create [retriever.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/retriever.ts) to call [recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#179-182) RPC based on current context.
- [x] 8.7 TS: Implement [assemble](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/legacy.ts#37-51) hook within [registerContextEngine](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/registry.ts#35-41) to prepend search results.
- [x] 8.8 TS: Register `ep-save`, `ep-recall` hooks/tools.
- [x] 8.9 Test: End-to-end integration test ([test_phase3.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/test_phase3.ts)) of ingest followed by a query.

## 9. Phase 3 Bug Fixes (Concurrency & Performance)
- [x] 9.1 Go: Fix JSON-RPC [sendResponse](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#106-113) data race with a `sync.Mutex` to ensure atomic writes to `net.Conn`.
- [x] 9.2 Go: Refactor [handleIndexerRebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#188-293) using Goroutine fan-out (`errgroup` + semaphore) to process Embeddings concurrently without blocking other RPCs.
- [x] 9.3 Go: Update `vector.Store.Recall` to fetch the Markdown `Body` via `frontmatter.Parse` and include it in the [ScoredEpisode](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#33-39) JSON output.
- [x] 9.4 TS: Update [retriever.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/retriever.ts) to consume the embedded `Body` directly instead of sending N+1 `frontmatter.parse` requests.

## 10. Phase 4.0: ロスレス Compaction (Lossless Compaction)
- [x] Go: `meta:watermark` キーの Get/Set 実装
- [x] TS: `segmenter.forceFlush()` 実装（未保存メッセージを強制ingest）
- [x] Go: `ai.batchIngest` RPC 実装（複数メッセージからEpisodeと目次生成）
- [x] TS: [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/context-engine.test.ts#444-447) 実装 (forceFlush -> 直接セッション読み取り -> watermarkでギャップ検出 -> batchIngest -> 目次生成 -> セッション書き戻し + absIndexリセット -> 診断結果返却)
- [x] Test: 900Kトークン蓄積シミュレーション → compact() 発火 → Episode全数保存 + 目次返却 + LLM呼出しゼロ

## 11. Phase 4.1: Genesis Gap Mitigation (Bulk Archive & Background Indexing)
- [x] 11.1 TS: [compactor.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts) のギャップ判定強化（`unprocessed.length > 2000` の分岐）
- [x] 11.2 TS: 極大ギャップ用のディスク一括ダンプ（`legacy_backlog_YYYYMMDD.json` への退避とセッション切り詰め）
- [x] 11.3 Go: `ai.triggerBackgroundIndex` 非同期 RPC エンドポイントの追加 (即 [ok](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/plugins/hooks.ts#711-717) リターン)
- [x] 11.4 Go: Background Worker Pool の実装（テキストチャンク分割 -> Deterministic Slug付与）
- [x] 11.5 Go: `golang.org/x/time/rate` を用いた Gemini Embedding（100RPM）のレートリミット制御
- [x] 11.6 Go: Pebble DBへの `meta:bg_progress` （バックグラウンド進捗状態）の保存機構
- [x] 11.7 Test: 14MB jsonl 実データで [test_real_world.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/tests/test_real_world.ts) を実行し、0秒ダンプ＆バックグラウンドインデックスを確認する。

## 12. Phase 4.2: 階層圧縮（DAG構築）
- [ ] 12.1 Go: `ai.compact` RPC — D0 FANOUT_THRESHOLD超過 → D1 [.md](file:///Y:/kasou_yoshia/.openclaw/workspace-system_engineer/SOUL.md) 生成、D0 archived
- [ ] 12.2 Go: `indexer.refine` RPC — HNSW KNN → semantic エッジ追加
- [ ] 12.3 TS: [compactor.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts) — compact + refineGraph オーケストレータ
- [ ] 12.4 TS: `ep-expand` ツール — D1+ → D0 群テキスト展開
- [ ] 12.5 Test: D0 × 10 → D1 生成 + archived + ep-expand

## 12. Phase 4.5: OpenClaw Compaction 互換レイヤー
- [ ] 12.1 Go: Quality Guard — auditCompactionQuality() + リトライ（上限3回）
- [ ] 12.2 TS: Reserve Tokens — assemble() で tokenBudget - reserveTokens バジェット制限
- [ ] 12.3 TS: Preserve Recent Turns — compact RPC に直近 N エピソード除外ガードレール
- [ ] 12.4 Test: Quality Guard audit fail → retry → 成功、Reserve Tokens 超過防止
