# Phase 3: Retrieval + Assemble + Memory Hook (Pebble + HNSW Architecture)

## 概要 (Overview)
Phase 3では、Phase 2にて「生成・保存」できるようになったエピソード（[.md](file:///d:/GitHub/OpenClaw%20Related%20Repos/memsearch/AGENT.md) ファイル群）を検索し、OpenClaw のプロンプトに動的に注入するための検索エンジン層（ベクトルDB）を構築します。
ご提案いただいた **Pebble (LSM Tree) + HNSW (In-Memory)** のハイブリッドアーキテクチャを採用し、将来的に 10k〜100k エピソードまでスケールしても数ミリ秒のレイテンシと最高のWrite throughputを維持できる「Max-Speed」な本番仕様で実装します。

## アーキテクチャ構成
*   **Storage Backend:** `github.com/cockroachdb/pebble` (LSM Tree KV Store)
    *   K/Vストアとして、エピソードのメタデータ、タイムスタンプ、及び Embedding の Raw Vector (float32 array) を保持します。
    *   インサートが極めて高速なため、オートセーブやリビルド時の負荷を吸収します。
*   **Vector Index:** `github.com/sahib/hnswlib-go` (（あるいは既存同等ライブラリ）インメモリ)
    *   起動時に Pebble から全ベクトルをロードしてインデックスを構築します。
    *   検索リクエスト（Recall）に対して、超低遅延で Top-N 件の類似エピソードID を返します。
*   **Source of Truth:** 引き続き `episodes/**/*.md`
    *   Pebble データベース（`vector.db` フォルダ等）が飛んでも、`/rebuild` を叩くだけで Markdown から完全に復元（Re-embed + Pebble Upsert）できる構成を維持します。

## Proposed Changes (Go Sidecar)

### [NEW] `go/internal/vector/store.go`
Pebble と HNSW を統合するストアインターフェースの実装。
*   `InitStore(dbPath string)`: Pebble DBを開き、HNSWインデックスを初期化・ロードする。
*   `AddEpisode(id string, vector []float32, meta EpisodeMeta)`: Pebble にメタデータを MsgPack 等でシリアライズし保存 ＋ HNSW にベクトルを追加。
*   `Search(queryVector []float32, k int, since time.Time)`: HNSWで上位の候補を取得し、Pebbleからメタデータを引いて、時間的近接度（Temporal Contiguity）によるRe-Rankを行う。

### [MODIFY] [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go)
*   RPCエンドポイントの追加:
    *   `ai.recall`: 検索クエリ文字列を受け取り、Gemini通してEmbedding生成 → `store.Search()` を叩いて近似エピソードを返す。
    *   `indexer.rebuild`: Markdownを全走査し、PebbleとHNSWを完全に作り直す（Goroutine fan-out）。

## Proposed Changes (TypeScript)

### [MODIFY] [src/rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts)
*   `recall(query: string, k: number)` の RPC ラッパーを追加。

### [NEW] `src/retriever.ts`
*   TypeScript側での Recall インターフェース抽象化。
*   現在の会話コンテキスト（`ctx.messages` の直近数ターン）の内容を抽出して検索クエリとし、Goサイドカーの `recall` RPCを呼ぶ。

### [MODIFY] [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts)
*   `api.registerContextEngine` の [assemble](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#76-84) フックの実装:
    *   `retriever` を用いて、現在のメッセージ履歴から関連する過去エピソードを検索。
    *   検索結果を `prependSystemContext` としてフォーマットし、OpenClaw プラグインAPI経由で注入。
*   Memory hook (`before_prompt_build`) 周辺のツール登録（必要に応じて）。

## Verification Plan
1.  **自動ビルドテスト:** Pebbleと依存パッケージを取り込んだGoサイドカーが無事コンパイルできるか。
2.  **Mock インジェクションテスト:**
    *   TypeScript 側から `test_phase3.ts` のようなスクリプトを流し、複数の関連・非関連トピックを事前学習（Ingest）させる。
    *   その後、関連トピックへの質問を投げた際、[assemble](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#76-84) フックが正常に呼び出され、事前にIngestした情報を `prependSystemContext` に含めて返却できるか。
3.  **再起動耐性テスト:**
    *   一度プロセスを落とし、再度立ち上げた際に Pebble から HNSW が爆速で復元され、検索が引き続き機能するか検証。
