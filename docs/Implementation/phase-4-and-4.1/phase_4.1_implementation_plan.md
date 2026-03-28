# Phase 4.1: Genesis Gap Mitigation (Fire-and-Forget)

This phase addresses the "Genesis Gap" issue discovered during real-world simulation testing when `absIndex` is zero and the agent has an enormous legacy history (e.g., 800k+ tokens, 100,000+ messages).

---

## 🎯 達成すべき目標（エージェント視点）

*   **Node.js メインスレッドのフリーズ防止:** 数万件の履歴を抱えていた場合でも、[compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/context-engine.test.ts#84-104) を 1秒以内 に終わらせチャットUIを停止させない。
*   **API Rate Limit 回避:** Gemma等のトークン生成モデルを巨大ギャップの処理プロセスから外し、Slug生成にかかるAPIコールの爆発を防ぐ。
*   **Googleプロフェッショナル設計:** 「テキストをディスクにダンプ（Phase 1）」と「非同期でベクトル化インデックス構築（Phase 2）」を完全に分離し、エラー時にもデータが吹き飛ばない堅牢性を実現する（Archive First, Index Later）。

---

## 🛠️ アーキテクチャと実装ステップ

### 1. TS側: 高速ダンプと0秒リターン（Fire-and-Forget）

ギャップがユーザー設定の閾値（例: `> 2000` メッセージなど巨大な時）を超えた場合の専用バイパスを [compactor.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts) に設ける。

#### [MODIFY] [src/compactor.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts)
*   `unprocessed.length` が十分に大きい（Genesis Gap）かを判定。
*   **Phase 1 (Disk Dump):** `unprocessed` なメッセージ配列をそのまま1つのMarkdown/JSONとしてディスク（例: `episodes/YYYY/MM/DD/legacy_backlog_YYYYMMDD.md`）へ生出力する（API通信ゼロ）。
*   **トリガー送信:** Go側に新設する非同期RPC `ai.triggerBackgroundIndex` を呼び出す。
*   **即リターン:** Go側の完了を一切 **`await` せずに**、セッションを書き換え、`absIndex` をリセットし、`{ compacted: true }` を返却する。

### 2. Go側: Background Indexer Daemon の実装

#### [NEW] `ai.triggerBackgroundIndex` RPC (main.go)
*   **入力:** パースすべき巨大な生テキストファイル（[.md](file:///Y:/kasou_yoshia/.openclaw/workspace-system_engineer/SOUL.md)）のパス群。
*   **処理:** リクエストを受け取ったら即座に [ok](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/plugins/hooks.ts#711-717) を返し、裏で `goroutine` を起動してワーカー層へ渡す。

#### [NEW] `internal/vector/background.go` (Background Worker Pool)
*   **生データのチャンク分割:** 巨大なMarkdownを読み込み、数千トークン単位などの意味のあるブロック（段落やターン数ベース）に切り出す。
*   **Deterministic Slug（API呼出ゼロ）:** LLMを使わず、切り出した初めの数単語と通し番号などを組み合わせ、`archive-YYYYMMDD-001-openclaw-setup` のようなハッシュ・決定的な名前をローカルで一瞬で付与する。
*   **Rate-Limited Embedding (Token Bucket):**
    *   `golang.org/x/time/rate` を利用して `Gemini Embedding 2` の 100 RPM（無料枠）を上回らないように `.Wait(ctx)` を組み込む。
    *   APIからベクトルが返ってきたら、`vstore.AddRecord()` でPebble/HNSWに順次登録。
*   **Observability (進捗監視):** Pebble内に `meta:bg_progress` キーを追加し、「残り何件か」を永続化。クラッシュ時の冪等な再開に対応する。

---

## 🧪 検証手順 (Verification)

1.  **Node.js ノンブロッキングの証明:**
    *   14MB（10万件）のダミーログに対して [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/context-engine.test.ts#84-104) をトリガー。
    *   コンソールのタイムスタンプで [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/context-engine.test.ts#84-104) が1秒以内に `true` を返し、直後にチャットが通常通り可能になることを確認する。
2.  **API コール数のログ監査:**
    *   Goのログ上で、10万件の処理にあたり、Gemma由来の `generateSlug` API呼び出しが **0件** であることを確認する。
    *   Embedding API が毎分100回前後のペースで綺麗に制限（Throttle）されて呼ばれていることを確認する。
3.  **HNSW ベクトル検索の事後確認:**
    *   バックグラウンドタスクが終了（数時間後）したと仮定したテストにおいて、過去のログの内容で `ep-recall` ツールを呼び出した時、正しくチャンク分けされた `archive-YYYYMMDD-xxx` のエピソードがヒットするか確認する。
