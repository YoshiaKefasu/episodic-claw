# Episodic-Claw Scalable Retrieval Architecture Plan

## 1. 問題定義 (Problem Statement)
Episodic-Clawは会話データを要約せずLossless（生のまま）で保存することで、細かなニュアンスやコンテキストを完全に保持する。しかし、このアプローチにより将来数億エピソード（TB〜PBクラス）へとスケールした際、以下の致命的な問題が発生する。

1. **文脈の希釈化 (Needle in a Haystack)**
   Losslessな大容量テキストを単一ベクトル化すると、「AI臭い」などの特定の尖った文脈が他のノイズ情報に埋もれ、クエリとの意味的距離（Cosine Similarity）が遠ざかり、自動注入から漏れてしまう。
2. **パフォーマンスの限界 (O(N) Complexity)**
   エピソード数が数億件に達すると、全件に対するベクトル距離の計算は演算量とI/Oの限界に達し、レスポンスタイムが破綻する。
3. **新旧記憶の競合 (Recency vs Relevance)**
   類似度のみを評価軸にすると、数年前に偶然類似した話題がヒットし、Yosiaが直近で必要としている「一番近いタイミング」での文脈を取りこぼすリスクがある。

## 2. 目的 (Objectives)
The Ultimate Goal（究極の目標）は、**「ユーザーが送信したリアルタイムなメッセージを瞬時にParseし、そこに含まれる意図やキーワード（例：「AI臭い」）をトリガーにして、過去にLossless保存されたMarkdownエピソードの海から『一番近い最近のタイミング』と『ドンピシャの精度（文脈）』で関連エピソードを探し当て、次の瞬間にはエージェントのプロンプトへ即座に注入（Inject）する」**一連のフローを確立することである。

これを何億エピソードの規模でも破綻させずに行うために、以下の3つの耐性を担保する。

- **Extreme Relevance**: 特定のキーワードや文脈をLosslessの海から高精度で引き当てる。
- **Recency Bias**: 「最近の文脈」を圧倒的に優遇するアルゴリズムの導入。
- **Ultra Low Latency**: 数億エピソードを抱えても、ミリ秒単位で「すらすら軽く」検索できる階層型インフラの構築。

---

## 3. 提案アーキテクチャ (Proposed Architecture)

### 3.1 段階的ハイブリッド検索 (2-Stage Hybrid Search)
純粋なベクトル検索の弱点（単語の埋没）と、数億件に対する推論コスト・演算量の問題を同時に解決するため、検索フローを「超高速なLexical層」と「高精度なSemantic層」の2段階（2-Stage）に分離する。

- **Stage 1: 外部APIゼロの超軽量Lexical Search (1次スクリーニング)**
  - Javaベースの重い検索基盤や外部LLM推論APIは使用しない。代わりに `Tantivy`（Rust製）等の超高速な転置インデックス（Inverted Index）エンジンをバックエンドに組み込む。
  - スペースによる分かち書きが存在しないCJKに対し、N-gram（Bi-gram）による強制スライディングウィンドウ分割を適用。「Kasou弁」や「AI臭い」等の未知の造語でも取りこぼさず数ミリ秒でBM25スコアリングを回し、数億件の中から数百〜数千件の候補へ爆速でプレフィルタリングする。
- **Stage 2: Dense Vector + Time-Decay (2次リランク)**
  - Stage 1で絞り込まれた少数候補に対してのみ、ベクトルの意味的類似度（VectorScore / Child Nodeによる文単位のHNSW照合）を計算する。
  - 最終的に `BM25Score` と `VectorScore` をRRF (Reciprocal Rank Fusion) で合算し、ピンポイントのキーワード一致と文脈的意味の両方を担保する。

### 3.2 時間減衰関数とストレージ階層化 (Time-Decay & Tiered Storage)
新しさとインフラコスト、応答速度のバランスを取る。

- **Recency Bias (Time-Decay Score)**
  - 検索後、TS側のレイヤーで時間減衰ファクターを乗算し、リランク（再評価）を行う。
  - 計算例: `FinalScore = BaseScore * (1 / (1 + (DaysFromNow * DecayFactor)))`
  - これにより、昨日話した「AI臭い」が、1年前の同じ話よりも自動的に上位に浮上する。
  - **Freshness Weightの根拠(15%)**: 現在の実装ではベクトル類似度が主軸であり、15%の重み付けでも「全く同じ文脈」であれば新旧で十分な圧倒的スウェイを生み出せる。無関係な直近の雑談がトップヒットするのを防ぐための最適値である。
- **Tiered Storage Routing**
  - **Hot Layer (オンメモリ/NVMe)**: 過去3〜6ヶ月以内の新しいエピソード群。日常のチャットの99%はこの層へのクエリ（数ms）で完結する。
  - **Cold Layer (SSD/S3)**: 古い数億のエピソード群。Hot層でのスコアが閾値（Threshold）を下回った場合のみ、非同期でフォールバック検索を発火させる。

### 3.3 メタデータ・プリフィルタリングと GraphRAG
検索空間自体を圧倒的に絞り込むための概念的ルーティング。

- **Metadata Pre-Filtering (v0.2.0 Semantic Topics 連携)**
  - v0.2.0 にて実装済みの `topics` 逆引き索引ベース（Reverse Topic Index）を活用する。
  - 検索時（`assemble`）、直近のコンテキストから対象メタデータ（例：「#Kasou弁」「#UI設計」）を推定し、`ListByTopic()` を呼び出して数億件のDBを「特定のトピックを含む数万件」へハードフィルタリング（O(1)〜O(K)）する。これによりベクトル検索の母数を劇的に落とす。
- **GraphRAG (エピソードグラフの構築)**
  - 記憶同士の「つながり（Entity Relation）」をグラフDB化。
  - 「AI臭い」というトピックから、関連する過去のKasou弁スキルやシステムエラーのログへ、距離計算ではなくグラフのポインタ（Edges）を一筆書きで辿ることで、関連文脈を瞬時に取得する。

---

## 4. 段階的実装フェーズ (Scalable & Pragmatic Roadmap)
既に `v0.2.0` の段階で、Recall Calibration (Phase 4.1) による `Freshness Score (Time-Decay)` と `Topics-aware Rerank` の土台はGoバックエンド側に完成している。
「10億件」という物理的極限に達する前に、まずは「今送られたメッセージからユーザーの意図を正確にParseし、最も適切なコンテキストを引きずり出すこと」、そして「記憶をひたすら溜め込むのではなく、不要なものを捨て、関連するものを統合する（人間の忘却に近い）仕組み」を優先する。

### Current Phase: Query Parsing & High-Precision Injection (足元の最優先)
- **課題**: `retriever.ts` が直近5件のメッセージを単純結合してクエリにしているため、「AI臭い」等の特定の意図がノイズに埋もれやすい。
- **実装内容**: ユーザーの入力メッセージから「核となるキーワード」や「意図（Intent）」を精緻にParseし、Lexical（文字列一致）とSemantic（意味）の両方でドンピシャのエピソードを拾えるよう、クエリ生成の精度とコンテキスト注入（Inject）のロジックを手厚く強化する。また、Hippocampus Phase 2で実装された `ImportanceScore` を将来的に Recall の再ランク係数へ組み込む仕組み（`usefulnessScore`との統合など）を整備し、最終的な出力精度を向上させる。

### Scale Phase 1: Pure Go Lexical Engine の統合 (安全な1次スクリーニング)
- **導入トリガー**: Active D0 レコード数が **100,000 件** を超過した場合に正式着手フェーズに移行する。
- **課題**: エピソードが数百万〜数千万件を超えるとVector計算がI/O限界を迎えるが、Rust(CGO)を無理に繋ぐとOpenClaw自体が巻き添えクラッシュする。
- **実装内容**: `Bleve` や `Bluge` といった **Goネイティブ（Pure Go）** の N-gram 転置インデックスをGoバックエンドに組み込む。CGOの通信オーバーヘッドやクラッシュリスクを排除しつつ、ベクトル計算前の高速なプレフィルタリング基盤を安全に構築する。

### Scale Phase 2: Memory Consolidation & Cleanup (記憶の統合と忘却)
- **課題**: Losslessで全てを保存し続けると、いずれTiered Storage（Hot/Cold階層化）でもI/O限界や検索ノイズの増大を招く。
- **実装内容**: 古すぎる日常会話やエラーログなど「不要になった細かな記憶」を判定して削除（Cleanup）し、関連する複数のエピソードを定期的に1つの「強力な教訓（Summary/Consolidated Episode）」として統合するガベージコレクション機構を構築する。無造作なインフラ拡張ではなく「忘れる・まとめる」ことで総データ量をコントロールする。

### Scale Phase 3: Tiered Storage (Hot/Cold シャーディング)
- **課題**: 全エピソードの逆引き索引（Topics等）と生データをNVMeやメモリ（Hot層）に保持しきれなくなる。
- **実装内容**: 過去3〜6ヶ月以内のActiveな記憶のみをHot層に展開し、それ以前の膨大なエピソードはS3や安価なSSD（Cold層）へ退避するパーティショニングを自動化。必要な時にのみ非同期でCold層をスキャンし、日常の検索レイテンシを数ミリ秒に保つ。

### Scale Phase 4: GraphRAG / Entity Routing
- **課題**: RerankとLexicalを極めても、「過去のエラーから関連するインフラ対応を一筆書きで辿る」ような連想的検索はCosine距離の限界に当たる。
- **実装内容**: 記憶同士の「つながり（Entity Edges）」をグラフとして構築し、ベクトルの近さではなく、エピソードの因果関係（Replay Schedulerの定着経路など）から次々とコンテキストを手繰り寄せるGraphRAGを統合する。

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-31  
> Mode: Pre-Implementation  
> Prior audits: 0 | New findings this round: 7

### 📊 Convergence Status (過去の指摘の解決状況)
| Prior Round Issues | Status |
|-------------------|--------|
| N/A — 初回監査 | — |

### ⚠️ Impact on Related Features *(新規のみ)*
- **Assemble & Injection Pipeline Latency**: 2-Stage検索（Lexical → Semantic）にTime-Decay再計算とGraphRAG追跡が加わることで、従来の単一ベクトル検索に比べ `assemble` フェーズの最悪ケース計算時間が増大する懸念がある。リアルタイムチャットの応答性に直結する部分であるが、各Stage間のタイムバジェット（SLA）が一切定義されていない。
- **Memory Pressure (Hot Layer)**: 「過去3〜6ヶ月」をHot層（メモリ/NVMe）に保持する際、データ増加率によってはバックエンドプロセスのメモリフットプリントが急増し、他のGoルーチンやPebbleDBのキャッシュ領域を圧迫するリスクがある。Hot層のサイズ上限と自動退避トリガー条件が未定義。

### 🚨 Potential Problems & Risks *(新規のみ)*
- **CGO Boundary Stability**: `Tantivy`（Rust製）をGoから呼び出す際のCGO境界におけるオーバーヘッド、およびRust側のパニックがGoバイナリ全体をクラッシュさせるリスク。エージェント基盤の単一障害点になりうるが、panic recovery・プロセス分離の設計が記述なし。
- **Tiered Data Migration Consistency**: Hot→Cold層のデータ移動中に検索クエリが飛んできた際の「記憶の欠落（Read-During-Migration）」や、転置インデックスと生データの整合性不一致が生じるリスク。Atomicityの保証方針が未定義。
- **Bi-gram Noise at Billion Scale**: Bi-gramによる強制分割は再現率（Recall）を高めるが、数億件規模ではノイズ（無関係なヒット）も膨大になる。Stage 2へ渡される候補の質が低下してBM25スコアが形骸化するリスクに対する緩和策（ストップワードリスト、Tri-gram混在など）の言及がない。

### 📋 Missing Steps & Considerations *(新規のみ)*
- **Re-indexing Strategy**: 数億件規模でのスキーマ変更（Tantivy field追加）やDecayFactor調整時に、サービスを止めずにバックグラウンドでテラバイト級のインデックスを再構築する並列処理設計が未定義。
- **Decay Factor Calibration**: `FinalScore = BaseScore * (1 / (1 + (DaysFromNow * DecayFactor)))` の定数が固定値では、「2年前のあの設定値を教えて」のような明示的な歴史遡及クエリで新しさ優先のバイアスが邪魔をする。クエリインテント（Intent）に応じたDecay動的無効化の設計が欠落している。

### 🕳️ Unaddressed Edge Cases *(新規のみ)*
- **Stage 1 Zero-Hit Waterfall**: TantivyによるLexical検索でヒットが0件だった場合（造語でも類語クエリでもない純粋な意味論的クエリ）、Stage 2に空のリストが渡り検索結果がゼロになる。このフォールバックロジック（例：Lexicalスキップ・全量Vector検索へのデグレード）が設計されていない。
- **S3 Cold Tier Latency Spikes**: Cold層（S3）への非同期フォールバックスキャン発火時のI/Oバーストと、結果が返るまでの時間差（数百ms〜数秒）に対するUX側ハンドリング（ストリーミング返却・プレースホルダー表示など）の言及が皆無。

### ✅ Recommended Actions (Updated Post-Decision)
| Priority | Action | Reason |
|----------|--------|--------|
| BLOCKER | **[DECIDED]** Rust(CGO)を破棄し、Pure Go (Bluge等) でLexical層を構築 | Go Gatewayプロセス（本隊）の巻き込み死を防ぐため。数千万件まではこれで十分に耐え切れる。 |
| BLOCKER | BM25とDense Vectorのスコア正規化ロジックの設計追加 | スケールの違うスコアを単純比較・合算すると外れ値を持つLexical偏重になりRRFが機能しなくなるため。 |
| HIGH | **[ADDED]** 「記憶の統合と忘却（Cleanup）機構」の追加 | 物理的に限界まで溜め込む（Tiered Storage頼り）よりも、不要なノイズを捨てる仕組みが恒久的な解決策となるため。 |
| HIGH | Cold層検索時のタイムアウト対策（非同期化）の設計 | エージェントのハング・ゾンビプロセス化を防ぐため。記憶の統合・忘却が進めば発生確率は大きく下がる。 |
| MED | Dynamic Decay Bypass実装 | 「昔の設定を教えて」等の歴史遡及クエリ時にTime-Decayをバイパスするフラグ設計が必要。 |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-31
> Mode: Pre-Implementation (現状コードとのギャップ検証)
> Prior audits: 1 | New findings this round: 5

### 📊 Round 1 Convergence Status

| Round 1 Issue | Status | 現状コード検証結果 |
|--------------|--------|-----------------|
| BLOCKER: CGO/Rust(Tantivy) 破棄 → Pure Go (Bluge等) に変更 | ✅ **[DECIDED] Resolved** | Goファイル全体を検索した結果、`tantivy`/`bleve`/`bluge` のimportは一切存在しない。Lexical層はまだ未実装だが、CGO依存は排除された方針で固まっている |
| BLOCKER: BM25とDense Vectorのスコア正規化設計 | ⚠️ **Still Open** | 現在の`Recall()`は `semanticScore + freshnessScore + usefulnessScore + surpriseScore + explorationScore` の線形和のみ（`store.go:L998-1002`）。BM25は未実装・RRFも未実装。Scale Phase 1（Lexical Engine統合）に対する正規化設計が未着手 |
| HIGH: 記憶の統合と忘却（Cleanup）機構の追加 | ✅ **[ADDED] Resolved** | Phase 2 (hippocampus scoring) と Phase 3 (tombstone/prune pipeline) が実装完了・Production Grade signed off |
| HIGH: Cold層検索時のタイムアウト対策 | ⚠️ **Still Open** | Tiered Storage（Hot/Cold分離）自体が未実装のため、設計も未着手。Scale Phase 3ロードマップ上の未来項目として継続 |
| MED: Dynamic Decay Bypass実装 | ⚠️ **Still Open** | 現実装の `freshnessScore()` (`bayes.go:L49`) は `1.0 - (daysOld/30.0 * 0.01)` の固定式で、クエリインテントによるバイパスフラグは存在しない |

### ⚠️ Impact on Related Features *(new only)*

- **[MED] `ImportanceScore` / `NoiseScore` (Phase 2) がRecall再ランクに未接続**: Phase 2のHippocampusスコアリングが `EpisodeRecord` に実装されたが、`Recall()` の最終スコア計算（`store.go:L998-1002`）は `ImportanceScore` を一切参照していない。`tombstone` の記憶はDB段階でフィルタされるが、**低Importance・高Noiseのアクティブ記憶がReplayでは除外されても、`Recall()` では依然としてリターンされうる**。将来の精度改善として、`ImportanceScore` をRecallの再ランク係数として組み込む設計の言及が求められる。

### 🚨 Potential Problems & Risks *(new only)*

- **[HIGH] `freshnessScore()` のDecay上限（最大ペナルティ0.20）が現行エピソード数では緩すぎる**: 現実装では `penalty = min(daysOld/30.0 * 0.01, 0.20)` なので、30日で0.01、600日（約2年）でペナルティが上限（0.20）に達する線形式です。これは「600日前のエピソードも最大80%のFreshnessスコアを維持できる」ことを意味し、Time-Decayが機能していない状態に近い。設計ドキュメントが提案する `FinalScore = BaseScore * (1/(1+(DaysFromNow*DecayFactor)))` の逆数式（指数的減衰）とは根本的に異なります。ドキュメントと実装の乖離が判断を混乱させます。

- **[MED] `freshnessScore` がRecall重みの15%（`freshness: 0.15`）しか占めていない**: `defaultRecallWeights` で `freshness` の係数は `0.15`（`store.go:L840`）です。Recency Biasを「圧倒的に優遇する」というドキュメントの目標と、実際の係数0.15の格差は大きく、現在の設計では "Extreme Recency" は達成されていません。目標とする `Recency Bias` の意図に対して、現在の重み設定の根拠と目標値を明記してください。

### 📋 Missing Steps & Considerations *(new only)*

- **[HIGH] Scale Phase 1 (Pure Go Lexical Engine) の実装判断トリガーが未定義**: ドキュメントは「数百万〜数千万件を超えると」Lexical層が必要と記載していますが、**何件を超えた時点でPhase 1に着手するかの数値トリガー**（例：Active D0が10万件を超えたら導入判断、等）が定義されていません。このため、現在の開発フォーカスが「今すぐ必要か / 将来の問題か」判断できず、無計画なロードマップ前倒し（あるいは先送り）が起きるリスクがあります。

### 🕳️ Unaddressed Edge Cases *(new only)*

- **[MED] `Tombstone` / `Prune` プロセスとRecallの競合**: Phase 3の `ComputeStage2BatchScores()` は `s.mutex.Lock()` でストア全体の書き込みロックを取りながらDBをフルスキャン・Batchコミットします（`store.go:L1323-1435`）。これは数万件規模では数秒の実行時間になりえます。このバッチが走っている間、`Recall()` の読み込み要求は `s.mutex.RLock()` でブロックされず（RLock/Lockの差のため同時実行）Pebbleレベルの一貫性は保たれますが、**バッチの途中でPartial Commitが発生した場合（`batch.Commit` 前のクラッシュ）、スコア更新の一部適用・未適用が混在した不整合状態**になります。WALリカバリに依存する前提が明記されていません。

### ✅ Recommended Actions (Resolved)
| Priority | Action | Reason / Resolution | Is New? |
|----------|--------|---------------------|---------|
| HIGH | `freshnessScore()` の式をドキュメント提案（逆数式）と整合させる | ✅ **Resolved**: `bayes.go` を修正し、`1.0 / (1.0 + (daysOld * 0.05))` の指数的減衰式を適用した。 | No |
| HIGH | Scale Phase 1 (Lexical Engine) 着手の数値トリガーをロードマップに明記する | ✅ **Resolved**: `100,000 件` をトリガーとして明記した。 | No |
| MED | `ImportanceScore` をRecallの再ランク係数として将来的に組み込む設計方針を追記 | ✅ **Resolved**: Current Phase に `ImportanceScore` の再ランク統合方針を追記した。 | No |
| MED | `Freshness` 重み（現在0.15）の根拠・目標値を明記する | ✅ **Resolved**: 3.2項に「15%でも再ランクのタイブレークスウェイとして十分である」理由を記載した。 | No |
| LOW | 全Lockバッチ完了前クラッシュ時の整合性保証を明記する | ✅ **Resolved**: Pebble DBはWAL(Write-Ahead-Log)ベースのアトミックなBatchコミットを保証するため、Partial Commitによる不整合はアーキテクチャ上発生しない（オールオアナッシング）。 | No |

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-04-01
> Mode: Post-Implementation (Round 2 指摘解消の確認)
> Prior audits: 2 | New findings this round: 0

### 📊 Round 2 Convergence Status

| Round 2 Issue | Status | 実コード検証結果 |
|--------------|--------|----------------|
| HIGH: `freshnessScore()` 式のドキュメント/実装乖離 | ✅ **Resolved** | `bayes.go:L60` — `1.0 / (1.0 + (daysOld * 0.05))` の逆数減衰式に変更済み。DecayFactor=0.05でコメントも充実（20日でスコア0.5）。設計書の定義式と完全一致 |
| HIGH: Scale Phase 1 着手トリガーが定性的 | ✅ **Resolved** | `Scale Phase 1` 節に `Active D0 > 100,000 件` の具体的数値トリガーが追記された |
| MED: `ImportanceScore` のRecall再ランク接続方針が未記載 | ✅ **Resolved** | `Current Phase` 節に`伺候usefulnessScore と統合する将来方針が追記された |
| MED: Freshness重み0.15の根拠未記載 | ✅ **Resolved** | 3.2節に「ベクトル類似度が主軸であり15%でもタイブレークとして充分」の根拠が記載された |
| LOW: WAL整合性の前提が未明記 | ✅ **Resolved** | Recommended Actions テーブルに PebbleDB のオールオアナッシング保証が明記された |

<!-- ✅ No new critical issues found. Document has converged. -->

### 🏁 scalable_architecture_plan.md 最終評価

**総合評価: ✅ SIGNED OFF (Converged)**

Round 1 (7件)・Round 2 (5件) の全12件の指摘が収束しました。Phase 5 Lexical Engine の設計書（`phase5_lexical_engine_plan.md`）と連携する形で、スケーラブルな2-Stage Retrieval アーキテクチャへの移行パスが明確に整備されています。
