# Episodic Memory APIリクエスト爆発（RPM枯渇）問題に対するエンジニアリング対策プラン

## 1. 課題の構造化 (The Problem Space)

現在、ユーザーが「1回」メッセージを送信しただけでも、バックグラウンドでは**「N倍（ファンアウト）」**のAPIコールが連鎖的に発生する構造（Message Amplification）になっています。

**【現在のAPI消費チェーン】**
1. **Agent Chain**: ユーザープロンプトに対するエージェントの推論 (コアLLM)
2. **Tool Chain**: `ep-recall` / `ep-expand` （検索・展開用LLM + Embedding）
3. **Ingest Chain**: メッセージの自動チャンキング・要約（LLM）
4. **Rename Chain**: Slug生成（LLM）+ ベクトルインデックス用（Embedding）

この同期的な直列処理では、1ターンのやり取りで 5～6回の APIリクエストが同時に走り、Gemini 等の RPM（Requests Per Minute）や TPM（Tokens Per Minute）のレートリミットに瞬時に到達（429 Error または無限待機）してしまいます。

---

## 2. アーキテクチャ対策方針 (Engineering Strategies)

この問題は Prompt Engineering ではなく、**System Architecture** のレベルで解決する必要があります。以下の4つのアプローチを組み合わせるのが、Google プロダクト品質での最適解です。

### A. バックグラウンド・キューイング (Background Worker & Event-Driven)
**「今すぐ同期的に終わらせる必要のない仕事」を即時応答ループから切り離します。**
* **現状**: ファイル保存、Slug（リネーム）生成、Embedding生成が全て「同期」して完了するまでRPCレスポンスがブロックされています。
* **対策**: Goバックエンドに **Worker Queue (Go Channel)** を導入し、フロントエンドからの [ingest](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw/src/context-engine/types.ts#81-91) 要求は「受付完了」として即座に `200 OK` を返します。裏側のGoルーチンがレートリミット（`rate.Limiter`）のペースに合わせて非同期でリネームやEmbeddingをジワジワと処理・保存します。

### B. バッチ処理による統合 (Batch Consolidation)
**1回の保存につき1回APIを叩くのをやめます。**
* **現状**: エピソードが1つ保存されるたびに、名前生成とEmbedding APIが走っています。
* **対策**: キューに飛んできた複数の保存リクエストをメモリ上にプールし、「5件溜まる」か「1分経過」した時点で、**1回の LLM API コールで5件分のSlugをまとめて生成**（配列で返却させる）するように変更します。これによりAPIコール数が「1/5」に激減します。

### C. アイドル時間の活用 (Sleep / Dreaming Phase)
**会話の最中（ホットパス）で重い処理を行わないようにします。**
* **対策**: トークン予算に余裕がある間は、「生データ（MD5ハッシュ名の仮ファイル）」のままとりあえずディスクに書き込んでおきます。ユーザーがPCから離れている、あるいはチャットが5分以上無言のアイドル状態になった時（Sleep/Dreamingフェーズ）を検知して、溜まった仮ファイルに対する「AIリネーム」「要約の生成」「コンパクション」をバックグラウンドで一斉に行います。

### D. モデルの階層化 (Tiered Model Routing)
**「名前つけ専用」に高性能モデル（Gemma 27B等）を消費するのはオーバーキルです。**
* **対策**: メインの推論エージェントと、記憶処理用のエンジンでモデルを使い分けます。例えば、Slug生成などの単純な自然言語処理タスクは、API制限のないローカルで起動させた軽量なLLM（Llama3-8B や Gemma-2B、あるいはルールベースの実装）にオフロード（外注）することで、クラウドAPIのRPMをゼロに抑えられます。

---

## 3. 具体的な実装ロードマップ (Implementation Phases)

現状の `episodic-claw` プラグインにおける現実的な導入ステップです。

## 3. 具体的な実装ロードマップ (Implementation Phases)

現状の `episodic-claw` プラグインにおける現実的な導入ステップです。

### Phase 1: Goバックエンドの非同期キュー化（Asynchronous Queueing）
* [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) における [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#379-509) および [handleBatchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#548-675) の処理を Go Channel と Worker Pool に流し込みます。
* API失敗時のフォールバック（例：MD5でとりあえず保存）はそのまま活かします。
* エージェントの待機時間が劇的に改善し、フロントエンドは「LLMの推論」だけに集中できるようになります。

### Phase 2: バッチ処理化 (Batch Consolidation)
* Goバックエンドの Worker Pool 内で、リクエストをバッファリングする層（デバウンサー）を設けます。
* バッファリングされた複数件の `Summary` を連結し、「以下の5つの文章それぞれに対して2語の要約配列をJSONで返せ」という1回のプロンプトへと圧縮し、API回数を削減します。

### Phase 3: アイドル・ディファード処理 (Deferred "Dreaming" Processing)
* 保存直後は重いAPI処理をスキップし、一旦ローカルに生データとして保存。
* TypeScript側、あるいはGo側の定期タイマーで `last_activity` を監視し、5分間API呼び出しがない状態になったら「Dreaming モード」に入り、たまった未処理データの一括要約と再配置を行います。

---

## 🚨 Google Pro Engineer 監査レポート (Architecture Audit)

本最適化プランは RPM 枯渇問題の本質を捉えており、方向性（バックグラウンド化・バッチング）は極めて正しいです。しかし、Google規模のエンタープライズ品質の観点からは、提案された「Phase 1」に**致命的なデータの消失リスクと一貫性の欠如**が潜んでいます。実装前に以下のエッジケースをプランに組み込んでください。

### 1. 【データ消失リスク】揮発性メモリキューの脆弱性 (Data Loss in Go Channels)
* **問題:** Goの `Channel` やメモリ配列をキューとして用いた場合、SidecarプロセスがOpenClaw再起動等でキルされた瞬間、**キュー内に滞留していた未処理のエピソードが完全に消失（Silent Data Loss）**します。
* **解決策 (WALの導入):** キューはメモリではなく、永続化されたストレージ（例: SQLite、PebbleDBの未処理ステータス、または仮保存ディレクトリへの生JSONファイル書き出し）を実体とする「ディファード・キューパターン」を採用する必要があります。

### 2. 【検索不能リスク】Read-After-Write の一貫性崩壊 (Context Miss)
* **問題:** `Ingest`（保存）全体を非同期化してしまうと、「ユーザーが記憶させた直後のターン」でエージェントが `ep-recall` や自動 `assemble` を実行した際、裏のキューでAPI空き待ちをしているエピソードが**Vector DB（HNSW）にまだ入っていない**ため、エージェントが「聞いていません」と回答する最悪のUXが発生します。
* **解決策 (処理の分離):** GeminiのEmbedding APIは上限が比較的緩い（100 RPM）ため、**【MD5ファイル名での生テキスト保存 + Embedding生成とDB追加】は極力同期的（または極低遅延）**に行い、検索可能な状態を最優先で担保します。上限が厳しい生成モデル（15 RPM）を消費する「美しいSlug名へのリネーム処理」のみを完全非同期キューへ回す「**責務のスプリット（Split Responsibility）**」が必須です。

### 3. 【RPC タイムアウト】 `rate.Limiter.Wait` の罠
* **問題:** 現状のGoコード内で `gemmaLimiter.Wait(ctx)` をそのまま使うと、レートリミットに達した際に当該スレッドが数秒〜最悪1分間ブロックされます。このブロックが同期RPCループの中で発生すると、TypeScriptクライアント側の `this.request` がタイムアウトし、プラグイン全体がクラッシュまたは無応答になります。
* **解決策:** Ingestを受信した瞬間に `200 OK`（MD5による仮のpath）をTS側へ即時返却（Fire-and-Forget）し、TS側のPromiseを解放してあげる必要があります。

### 📌 再構築された Phase 1 実装アプローチ (Pro Recommendation)
以上の監査を統合し、以下のように Phase 1 を再設計することを強く推奨します。
1. **同期層**: `handleIngest` / `handleBatchIngest` を呼ばれたら、**Gemmaの呼び出し（Slug生成）を即座にスキップ**し、強制的にMD5のFallbackでローカルファイルとフロントマターを作成する。その後、Embedding APIのみをコールしてPebbleDBに登録。フロントエンドには即座に成功を返す。
2. **非同期層**: すでに実装されている `RunAsyncSlugRefiner` (昨日のRename機能) を強化し、これが「MD5名の仮ファイル」を監視して、バックグラウンドの余裕がある時（レートリミットを気にせず）にジワジワと賢いファイル名に置換していくアーキテクチャに一本化する。

これにより、キューのメモリ揮発リスクも避けられ（MD5ファイルが永続化キューの代わりになる）、かつRPMオーバーも完全に制御可能です。

---

## 🎯 最終決定事項およびアクションプラン (Final Decision & Action Plan)
上記の「**📌 再構築された Phase 1 実装アプローチ (Pro Recommendation)**」を正式な実装設計として採択します。  
以下のタスクへとブレイクダウンし、逐次実装（Step-by-step Execution）を進行します。

1. **`handleIngest` および `handleBatchIngest` の同期処理（Gemma）排除**:
   - `provider.GenerateText` および `gemmaLimiter.Wait` を削除します。
   - `slug` の生成を**常に** MD5 ハッシュ `fmt.Sprintf("episode-%x", md5.Sum([]byte(params.Summary)))[:16]` へとフォールバックさせます。
2. **高速な Embedding / DB 記録の維持**:
   - MD5のファイル名を用いて `provider.EmbedContent` （高速かつRPM上限に余裕あり）を同期的に呼び出し、ファイル保管・VectorDB へのインデックス化を直ちに完了させます。これにより保存直後のコンテキスト喪失（Read-After-Writeのミス）を完全に防ぎます。
3. **`AsyncRefiner` との連携検証**:
   - 既存の `AsyncRefiner` ワーカーが、新たに恒常的に生成されるようになった `episode-md5` 形式の仮装ファイルを正しく検知し、安全なバックグラウンド処理としてGemmaによるリネームを実行できているか動作確認・最適化を行います。

---

## 5. 実装完了レポートおよび AsyncRefiner 検証結果
Safe Phase 1 の実装はすでに完了しました。
「AsyncRefinerが適切なタイミングで起動するか」「成功時に古いファイルは安全にクリーンアップされるか」という疑問への技術的検証結果・ご回答については、以下の完了レポートにまとめています。
👉 **[Phase 1 実装完了および動作仕様レポート](file:///C:/Users/yosia/.gemini/antigravity/brain/06ceb6f0-20bd-4792-ae5a-1abd48c06362/phase_1_safe_execution_report.md)**
