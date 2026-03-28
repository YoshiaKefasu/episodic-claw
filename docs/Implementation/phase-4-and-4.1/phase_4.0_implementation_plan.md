# Phase 4.0: ロスレス Compaction（ロスレス圧縮）実装プラン

このプランは、Phase 4.1（階層圧縮）および Phase 4.5（互換レイヤー）を切り離し、**「compact() 発火時の情報喪失を完全に防ぐ（ロスレス化）コアメカニズム」** のみに集中した実装詳細です。

---

## 🎯 達成すべき目標（エージェント視点）

*   **Ingest漏れの完全排除:** [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#91-95) が発火した際、まだ Episode 化されていないバッファ内の会話や、Surprise が低くてスルーされていた「隙間の会話」を全て拾い上げ、強制的に Episode 化する。
*   **高速なギャップ検出:** 「どのメッセージが Episode 化済みか」を O(1) で高速 판定し、二重保存を防ぐ。
*   **骨格サマリーの生成:** ランタイムが要求する `previous_summary` として、「決定事項・TODO・制約」だけを抽出した超軽量サマリー（骨格）を生成して返す。
*   **長大コンテキスト対応:** 最悪 900K トークンのテキストをサマリー化するため、1Mコンテキスト対応の `gemini-2.5-flash` を利用する。

---

## 🛠️ アーキテクチャと実装ステップ

### 1. 高速ギャップ検出（O(1) 判定）の基盤構築

[compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#91-95) 時に何百ものメッセージ群から「未処理のメッセージ」だけを抽出するため、Vector DB (Pebble) にソースIDのインデックスを追加します。

#### [MODIFY] [go/internal/vector/store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go)
*   **Pebble Keysの拡張:** Episode データを保存する際に、同時にその Episode が含んでいるメッセージの ID (`sources`) をキーとして記録します。
    *   Key: `source:{message_id}` / Value: `{episode_path}`
*   [Add()](file:///C:/Users/yosia/go/pkg/mod/github.com/%21bithack/go-hnsw@v0.0.0-20170629124716-52a932462077/hnsw.go#423-501) メソッドに `sources []string` を渡し、バッチ処理内でキーを [Set](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/auto-reply/reply/post-compaction-context.ts#12-40) するよう修正。
*   [Clear()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#191-213) 時に `source:` プレフィックスのキーも削除するよう対応。

#### [MODIFY] [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) — [handleIndexerRebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#188-293)
*   Rebuild 時にも Frontmatter からパースした `sources` を読み取り、Pebble に `source:{message_id}` を展開して復元するように修正。

### 2. Go サイドカー RPC エンドポイントの追加

#### [NEW] `indexer.getUnprocessed`
*   **入力:** `[]string` (検査したいメッセージIDのリスト)
*   **処理:** Pebble DB で `source:{id}` を [Get](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#214-228) し、`ErrNotFound` だったものだけを抽出して返す。これによる O(1) 判定。
*   **出力:** `[]string` (未処理のメッセージIDリスト)

#### [NEW] `ai.batchIngest`
*   **入力:** `[{body: string, sources: []string}, ...]`
*   **処理:** 複数のメッセージの塊（チャンク）を受け取り、並列で Gemma-3 による Slug 生成 → Markdown 書き出し → Embedding 算出 → Pebble/HNSW 登録を行う。
*   **出力:** `[]string` (生成された Episode パス)

#### [NEW] `ai.compactSummary`
*   **入力:** `text: string` (コンテキスト全体のテキスト)
*   **処理:** `gemini-2.5-flash` を明示的に使用し、長大なコンテキストから決定事項・TODO・制約のみを抽出する。
    *   *System Prompt:* `Extract ONLY the key decisions, pending TODOs, and durable system constraints from the provided context. Keep it extremely concise as a bulleted skeleton summary. Do not include raw conversational history.`
*   **出力:** `string` (骨格サマリーテキスト)
*   *(※ AI Studio の Gemma-3 はAPI上限でコンテキストが厳しい可能性があるため、ここは安全サイドで 1M+ コンテキストを持つ Gemini 2.5 Flash を固定指定します)*

### 3. TypeScript プラグインロジックの実装

#### [MODIFY] [src/segmenter.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/segmenter.ts)
*   **追加:** `forceFlush(agentWs: string)` メソッド
*   **処理:** [Surprise](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#308-341) スコアの計算をバイパスし、現在のバッファにたまっている全メッセージを1つのエピソードとして結合し、強制的に `rpcClient.ingest()` へ投げてバッファをクリアする。

#### [NEW] `src/compactor.ts`
*   [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#91-95) オーケストレータをピュアな関数またはクラスとして実装。
*   **処理フロー:**
    1.  `await segmenter.forceFlush(agentWs)`
    2.  `ctx.messages` から全メッセージの [id](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/plugins/hooks.ts#199-225) を抽出。
    3.  `rpcClient.getUnprocessed(ids)` で未処理IDのリストを取得。
    4.  未処理IDに対応するメッセージを取り出し、例えば5ターン（または2000トークン）ずつチャンクに分割。
    5.  `rpcClient.batchIngest(chunks)` で隙間の会話を全て Episode 化。
    6.  `formatMessages()` で `ctx.messages` 全体を1つの巨大な文字列化。
    7.  `rpcClient.compactSummary(text)` で骨格サマリーを生成。
    8.  `{ ok: true, compacted: true, result: { summary: ..., tokensBefore: ... } }` を返す。

#### [MODIFY] [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts)
*   `api.registerContextEngine()` の [compact](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#91-95) メソッド内で、上記で実装した `compactor.compact(ctx)` を呼び出してランタイムへ結果を返すように結合。

---

## 🧪 検証手順 (Verification)

1.  **通常会話の中断と compact() 発火の模倣:**
    *   ダミーのチャット履歴（`sources` として `msg_A` 〜 `msg_D` が付与されたもの）を作成。
    *   プラグインを直接テストハーネスから呼び出して [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#91-95) をトリガー。
2.  **forceFlush の動作確認:**
    *   バッファに残っていた会話が強制的に Episode 化（ファイル作成）されるか確認。
3.  **ギャップ検出と batchIngest の動作確認:**
    *   一部のメッセージだけ強制的に「未処理」扱い（Pebble に `source:` キーがない状態）にして [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#91-95) を走らせる。
    *   その未処理分だけが `batchIngest` 経由で新たな Episode ファイルとして切り出されることを確認。
4.  **骨格サマリーの出力確認:**
    *   Gemma / Gemini API ログを確認し、数十キロ〜数百キロバイトの入力に対して、数十行レベルの極めて短い箇条書きサマリーが正確に返却されることを確認。

---
*このプランが承認され次第、ファイルの編集とコーディングへ進みます。*
