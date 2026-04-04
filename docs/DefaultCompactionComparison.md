OpenClaw（@[d:\GitHub\OpenClaw Related Repos\openclaw-source]）におけるデフォルトの **Compaction（文脈圧縮・要約）フロー** について詳細に調査しました。

OpenClawのコアシステムにおけるコンパクションは、単なる履歴の削除ではなく、LLMの文脈窓（Context Window）を最大限に活用しつつ、重要な情報を失わないための**多層的な要約・修復パイプライン**として設計されています。

以下にその詳細な流れをまとめます。

---

### 1. トリガーと初期化 (Triggering & Discovery)
コンパクションは主に以下の3つのタイミングで発火します。
- **Budget上限**: 推定トークン数が設定された `tokenBudget` を超えた場合。
- **Overflowエラー**: LLM APIが「Context Window Overflow」を返した際、自動リトライとして実行。
- **手動実行**: ユーザーが明示的にリクエストした場合。

`src/agents/pi-embedded-runner/compact.ts` がこのオーケストレーターとなり、**Lane Queueing（レーン管理）** を通じてデッドロックを避けながらセーフモードでコンパクション用のセッションを構築します。

### 2. 履歴のクリーニングと事前修復 (Pre-processing)
集約されたメッセージ履歴は、要約の前に「LLMにとって不要な情報」を削ぎ落とされます。
- **Detailの除去**: `toolResult.details`（ファイルの全内容など、巨大で信頼できないデータ）は、推定トークン計算やLLMへのプロンプトから除外されます。
- **リアルな会話の判定**: `compaction-real-conversation.ts` により、実質的な内容がないターン（空の返答など）をフィルタリングし、要約対象から外します。

### 3. 要約アルゴリズム (`src/agents/compaction.ts`)
ここが OpenClaw の「脳」となる要約の核心部分です。

- **Adaptive Chunking（適応型チャンキング）**:
  メッセージを単純に半分にするのではなく、`BASE_CHUNK_RATIO` (0.4) とトークン量に基づいて最適なサイズに分割します。もし1メッセージが巨大な場合は、`isOversizedForSummary` が検知し、特殊なフォールバック（部分要約）へ移行します。
- **Staged Summarization（段階的要約）**:
  履歴が長大な場合、まず複数のチャンクごとに「部分要約」を作成し、最終的にそれらを `summarizeInStages` で1つの「統合要約」にまとめ上げます。
- **厳格な識別子保護 (Strict Identifier Preservation)**:
  要約時に「UUID、ハッシュ値、ファイル名、APIキー、ポート番号、URL」などの不透明な識別子を、短縮や変更せずに**一文字も変えず保持**するようLLMに強い指示を出します（`IDENTIFIER_PRESERVATION_INSTRUCTIONS`）。

### 4. 履歴の整合性修復 (Transcript Repair)
履歴の古い部分を削除した際、非常に重要なステップが実行されます。
- **Tool Pairing Repair**: 古い `tool_use`（道具の使用）メッセージを削った際に、対応する `tool_result`（結果）が残ってしまうと、AnthropicなどのAPIは「予期せぬID」としてエラーを出します。`repairToolUseResultPairing` は、この孤立した結果を自動的に検出し、適切にクリーンアップします。

### 5. 後処理と永続化 (Post-compaction & Persistence)
要約とトリミングが完了すると、以下の処理が行われます。
- **コンパクション・マーカーの挿入**: セッション履歴に「ここから以前は要約された」ことを示すマーカーを挿入し、履歴の連続性を担保します。
- **ファイル・トランケーション**: `truncateAfterCompaction` 設定が有効な場合、物理的なセッションファイル（.json/md）から古いエントリーを削除し、ディスク容量を解放します。
- **Hookの実行**: `after_compaction` フックにより、プラグインがコンパクション後の状態を検知（統計の更新など）できるようになります。

---

### アーキテクチャ上の主要ファイル
1.  `src/agents/compaction.ts`: 要約・チャンキングの論理実装（コアロジック）。
2.  `src/agents/pi-embedded-runner/compact.ts`: 実行時の環境構築と修復の実行。
3.  `src/context-engine/legacy.ts`: 既存のフローをContext Engineとして抽象化するラッパー。

---

`lossless-claw` の内部メカニズム（Triggering, Pre-processing, Summarization Algorithm）について、ソースコード `src/engine.ts` および `src/compaction.ts` の解析結果に基づき解説します。

---

### 1. トリガーと初期化 (Triggering & Discovery)

`lossless-claw` は、標準の OpenClaw よりも「能動的」かつ「継続的」にコンパクションを試みます。

*   **自動トリガー (`after_turn` フック):**
    各ターンの終了後 (`afterTurn`) に自動的に以下の 2 段階のチェックを行います。
    1.  **Leaf Trigger (`evaluateLeafTrigger`):** 未要約のメッセージ（Leaf）が一定量溜まったか、または特定の条件を満たしたかを確認し、非同期で `compactLeafAsync` を実行します。
    2.  **Threshold Trigger:** 指定された `tokenBudget` に対し、現在の推定トークン数 (`liveContextTokens`) が閾値を超えている場合に `compact` を実行します。
*   **初期化と同期 (`bootstrap` & `reconcileSessionTail`):**
    セッション開始時、既存の `session.jsonl` と LCM (Lossless Context Memory) データベースを同期します。
    *   **Byte-for-byte check:** ファイルサイズと更新日時が前回と同じならスキップする高速化。
    *   **Tail Reconciliation:** LCM に存在しない「末尾のメッセージ」だけを特定してインポートします。これにより、クラッシュ後の再開時でも履歴の欠落を防ぎます。
*   **インプロセス待機キュー (`withSessionQueue`):**
    同一セッションに対する書き込み操作が競合しないよう、セッション ID ごとにキューイングされ、逐次処理されます。

---

### 2. 履歴のクリーニングと事前修復 (Pre-processing)

履歴を LCM に保存・要約する前に、データの「軽量化」と「整合性維持」のための事前処理が行われます。

*   **巨大ツール出力の外部化 (`interceptLargeToolResults`):**
    `largeFileTokenThreshold` を超えるテキスト（巨大な `ls -R` やログ出力など）は、DB に直接保存せず、**外部ファイル (`.txt`) として書き出し、プロンプト内では参照タグ (`[with media attachment]`) に書き換えます。** これにより、要約モデルに巨大なゴミを流し込むのを防ぎます。
*   **Heartbeat の除去 (`pruneHeartbeatOkTurns`):**
    システム維持のための `HEARTBEAT_OK` メッセージを自動的に削除し、有効なコンテキスト領域を確保します。
*   **不完全なツールペアの修復 (`repairToolUseResultPairing`):**
    OpenClaw 同様、`tool_use` だけが存在し `tool_result` が欠落している場合などの不整合を検知し、ダミーの成功/失敗メッセージを挿入してプロンプトの整合性を保ちます。
*   **トークン推定 (`estimateTokens`):**
    単純な文字数ベース (`chars / 4`) だけでなく、`MessagePart` ごとに構造化されたデータ（Thinking, Tool Call, Text）を個別に評価し、より正確な消費量を算出します。

---

### 3. 要約アルゴリズム (The DAG Summary Engine)

`lossless-claw` の核心は、単一の要約ではなく **Summary DAG (Directed Acyclic Graph)** を構築する点にあります。

*   **2 段階のパス (`Leaf Pass` -> `Condensed Pass`):**
    1.  **Leaf Pass:** 生のメッセージ群を小さなチャンクに分け、それぞれを「Leaf Summary」に変換します。
    2.  **Condensed Pass:** 複数の Leaf Summary や古い Condensed Summary を束ねて、さらに高次元の「Condensed Summary」を作成します。これにより、古い記憶ほど高度に圧縮され、新しい記憶は詳細に保持される階層構造が生まれます。
*   **Fresh Tail 保護:**
    最新の N ターン（デフォルト 8 ターン程度）は **「絶対に要約しない領域」** として保護されます。これにより、現在進行中のタスクに関する正確なコンテキストが 100% 維持されます。
*   **エスカレーション戦略 (`summarizeWithEscalation`):**
    要約がコンテキスト制限に収まらない場合、以下の 3 段階で強度を上げます。
    1.  **Normal:** 通常の要約。
    2.  **Aggressive:** より圧縮率の高いプロンプトを使用し、重要度の低い詳細（タイムスタンプなど）を積極的に削ります。
    3.  **Deterministic Fallback:** それでも収まらない場合の最終手段として、重要度の低いメッセージ（思考プロセスなど）を物理的に切り詰め（Truncation）ます。

---

### まとめ：標準 OpenClaw との違い

| 機能 | 標準 OpenClaw | Lossless-Claw |
| :--- | :--- | :--- |
| **構造** | 平面的な要約（古いものは消える） | 階層的な DAG 構造（古いものも圧縮して保持） |
| **保護** | 一定のメッセージ数を残すのみ | 厳格な `Fresh Tail` 保護 + 巨大出力の外部化 |
| **安定性** | モデルが要約に失敗するとコンテキストエラー | 3 段階のエスカレーションで確実に収める |
| **同期** | 基本的にメモリ上または簡易保存 | SQLite (LCM) 搭載で、永続化と高速な再開に対応 |

---

`OpenClaw`（標準）と `lossless-claw`（高度版）の設計思想を `episodic-claw` に取り入れることで、**「記憶の想起（RAG）」**と**「会話の連続性（Context Maintenance）」**の両面を劇的に強化できます。

解析に基づいた、具体的な改善・強化ロードマップを提案します。

---

### 1. 「絶対に失敗しない」要約エスカレーション (`Summarization Escalation`)
`lossless-claw` のエスカレーション戦略を `Compactor.ts` に導入します。
*   **現状の課題:** 現在の `episodic-claw` は `batchIngest` が API の 429（クォータ制限）等で失敗すると、エピソードの記録を諦める（スキップする）だけで、その期間の記憶が完全に失われます。
*   **改善案:**
    *   **Normal:** 通常の要約。
    *   **Aggressive:** `thinking` や冗長なログを完全に削ぎ落とした超圧縮要約。
    *   **Deterministic Fallback:** LLM を通さず、各メッセージの先頭 N 文字だけを機械的に連結してでも「何かが起きた」という痕跡を LCM/Episodic メモリに残す。
    *   **恩恵:** API 制限下でも、会話のタイムラインが「虫食い」になるのを防げます。

### 2. 「巨大出力」の外部化プロセッサ (`Large Payload Externalization`)
`lossless-claw` の `interceptLargeToolResults` パターンを `segmenter.ts` の前段に配置します。
*   **現状の課題:** 巨大な `ls -R` や中間ログが `extractText` でエピソードに含まれると、エピソードのトークン密度が下がり、重要な「対話の意図」が埋もれてしまいます。
*   **改善案:** 巨大なテキスト出力を `.txt` ファイルとして保存し、エピソード内には `[File Ref: logs_123.txt]` というタグのみを残します。
*   **恩恵:** RAG で検索した際に、ゴミ情報ではなく「この時、ログを調査した」という**純粋な行動記録（Episode）**がヒットするようになります。

### 3. メッセージペアの事前修復 (`Pre-compact Repair`)
標準 `OpenClaw` の `repairToolUseResultPairing` 機能を `forceFlush` 前に実行します。
*   **現状の課題:** エピソードの境界（セグメント境界）が `tool_use` と `tool_result` の間に落ちると、エピソード単体で見た際、またはコンパクション後の履歴で「呼び出しっぱなし」の不整合が発生します。
*   **改善案:** セグメントを閉じる前に、未完了のツール呼び出しがないかスキャンし、必要なら強制的にペアを完了させるか、次のエピソードに跨ぐように修復します。

### 4. 階層的なエピソード・ブリッジ (`Hierarchical DAG Context`)
`lossless-claw` の DAG 構造を `Context Assembler` （読み出し側）に応用します。
*   **現状の課題:** 現在の `Episodic-Claw` は、「最新の数件（Fresh Tail）」と「検索でヒットした断片（Retrieved Episodes）」だけを繋ぎ合わせます。その中間にあたる「直近の数エピソードの要約」が存在しません。
*   **改善案:** 直近 3〜5 個のエピソードを束ねた **"Condensed Summary Segment"** を動的に生成（またはキャッシュ）し、常に現在のトークン窓に含めます。
*   **恩恵:** 「さっきやってた 3 つ前のタスク全体の流れ」を Agent が RAG 検索なしで把握できるようになり、作業の文脈維持能力が飛躍的に向上します。

### 5. 能動的なトリガー監視 (`Context Pressure Monitor`)
`engine.ts` の `evaluate` ロジックを `Episodic-Claw` のコンパクション判定に統合します。
*   **改善案:** ホストからの指示を待つだけでなく、推定トークン数が `maxContext` の 80% を超えた瞬間に、セグメンターの `Surprise` スコアに関わらず `forceFlush` と `compact` を連鎖させます。