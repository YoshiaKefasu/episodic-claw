# Episodic-Claw v0.2.0 Master Plan

更新日: 2026-03-30

## 目的

`v0.2.0` は、Episodic-Claw を

- ただ保存できる memory plugin

から

- 意味を持って整理され
- 境界を自分で学習し
- D1 統合が文脈と境界を理解し
- recall も少し賢くなる

memory system に進めるリリースにする。

今回の親プランは、次の 7 本を 1 本のロードマップとして束ねる。

- [semantic_topics_plan.md](D:\GitHub\OpenClaw%20Related%20Repos\episodic-claw\docs\semantic_topics_plan.md)
- [plan_e2_e3_embed_guard.md](D:\GitHub\OpenClaw%20Related%20Repos\episodic-claw\docs\plan_e2_e3_embed_guard.md)
- [bayesian_dynamic_tuning_plan.md](D:\GitHub\OpenClaw%20Related%20Repos\episodic-claw\docs\bayesian_dynamic_tuning_plan.md)
- [d1_dynamic_clustering_plan.md](D:\GitHub\OpenClaw%20Related%20Repos\episodic-claw\docs\d1_dynamic_clustering_plan.md)
- [phase_3_1_replay_scheduler_plan.md](D:\GitHub\OpenClaw%20Related%20Repos\episodic-claw\docs\phase_3_1_replay_scheduler_plan.md)
- [phase_4_1_recall_calibration_plan.md](D:\GitHub\OpenClaw%20Related%20Repos\episodic-claw\docs\phase_4_1_recall_calibration_plan.md)
- [phase_4_2_release_readiness_plan.md](D:\GitHub\OpenClaw%20Related%20Repos\episodic-claw\docs\phase_4_2_release_readiness_plan.md)

---

## リリーステーマ

`v0.2.0` のテーマはこれ。

- `Safe`
- `Meaningful`
- `Adaptive`
- `Human-like`

言い換えると、

1. 壊れた embed や空本文で memory を汚さない
2. episode に「何の記憶か」を持たせる
3. segment / recall のスコアを固定値から卒業させる
4. D1 を「似たもの圧縮」から「文脈-aware な統合」に進める

---

## 現状から見た依存関係

4 本のプランは独立ではない。

依存関係はこう見るのが自然。

### 1. E2/E3 は土台

空本文や frontmatter 周りが曖昧なままだと、

- topics 生成
- D1 要約
- dynamic tuning

の全部にゴミが混ざる。

### 2. `topics` は D0/D1 の意味ラベル基盤

`topics` が入ると、

- recall のファセット
- D1 の上位概念抽出
- 将来の schema/topic memory

が全部やりやすくなる。

### 3. Bayesian segmentation は D1 の前にやる価値が高い

D1 は D0 を材料にする。  
材料の切れ目が雑なままだと、どれだけ賢い cluster を組んでも D1 品質が頭打ちになる。

### 4. D1 dynamic consolidation は後半の主役

これは `topics` と `surprise-boundary` の恩恵を受ける側なので、少し後ろに置く方が効率がいい。

### 5. Bayesian recall rerank は D1 改修と並走できるが、仕上げは最後が良い

recall rerank は D0/D1 の質が上がるほど効く。  
なので、実装を早めに始めても、 tuning 完了は最後に持っていくのがきれい。

### 6. replay scheduling は recall の前に入れると API 効率が良い

`Phase 3.1` は recall の代替ではない。  
役割は「どの記憶を定着対象として再活性化するか」を local に決めること。

先にここを入れると、

- recall 側で触る記憶の質が上がる
- 不要な API 呼び出しを減らせる
- D1 と high-salience memory を優先して育てられる

### 7. recall を入れた後に calibration を 1 段挟むと安定する

`Phase 4` の recall rerank は、機能としては先に入れられる。  
ただし、その直後に

- usefulness が強すぎないか
- replay state が recall を乗っ取っていないか
- topics strict が空振りを増やしていないか

を整える軽い calibration phase を 1 段挟むと、`Phase 5` が observability 整理だけで終わらず、実運用の手触りまで揃えやすい。

### 8. calibration の直後に release-readiness closure を挟むと、残件が見えやすい

`Phase 4.1` までで recall の重みと責務境界はかなり整う。  
ただし、そのまま `Phase 5` に入ると

- telemetry の粒度不足
- replay / recall observability の薄さ
- docs index / runbook のズレ
- vector regression test の不足

が最後の箱に混ざって、release blocker が見えにくい。

なので `Phase 4.2` を 1 段挟み、

- `importance_score` 用の前方互換観測
- structured run summary
- rebuild / recovery の導線
- recall / replay guardrail test

を先に閉じる方が、`Phase 5` を packaging と最終確認へ寄せやすい。

---

## 推奨実装順

## Phase 0: Hardening

対象:

- `plan_e2_e3_embed_guard.md`

やること:

1. E2 調査を終えて `doc.Body` の定義を確定する
2. E3 の空文字 embed guard を入れる
3. skip 時の warn ログを揃える

このフェーズの狙い:

- memory 汚染を止める
- 後続フェーズの入力品質を安定させる

完了条件:

- 空本文で embed しない
- frontmatter 由来の誤 embed がない
- `go build ./...` が通る

理由:

ここを後回しにすると、後の phase の検証ログが全部濁る。

状態:

- `plan_e2_e3_embed_guard.md` 反映済み
- Phase 0 実装と再監査は完了
- `go build ./...` 成功確認済み
- `semantic_topics_plan.md` の TS-side 実装は着地済み
- `semantic_topics_plan.md` の Go-side Phase 1 実装も完了

## Phase 1: Metadata Foundation

対象:

- `semantic_topics_plan.md`

やること:

1. `topics` スキーマ追加
2. `ep-save` の `topics` 対応
3. HealingWorker で slug + topics を継承・保持する
4. D0 / D1 frontmatter と Pebble に `topics` を保存

このフェーズの狙い:

- 「この記憶は何についてか」を構造化する
- 後続の D1 / recall / schema を意味レベルで支える

完了条件:

- D0 に `topics` が入る
- D1 にも `topics` を持てる
- 既存データと後方互換
- Go build が通る
- topic reverse index で `ListByTopic()` が O(N) scan に依存しない

状態:

- Phase 1 core は完了
- 旧データの物理 backfill は任意の後続タスクとして残す
- HealingWorker の `topics` 自動生成は Phase 2 以降の拡張に回す

理由:

`topics` は後ろのフェーズ全部で使える。早く入れた方がいい。

## Phase 2: Adaptive Segmentation

対象:

- `bayesian_dynamic_tuning_plan.md` の Phase 0 / Phase 1

やること:

1. raw `surprise` の観測ログ追加
2. per-agent segmentation state を持つ
3. `surpriseThreshold = 0.2` を卒業する
4. `ai.surprise` を `ai.segmentScore` 系へ拡張する

このフェーズの狙い:

- D0 の切れ目を会話ごとに適応させる
- `surprise-boundary` を将来の `must-not-link` に育てる

完了条件:

- boundary 数が暴走しない
- 過分割と取り逃しが減る
- D0 の粒度が安定する

理由:

D1 より前に D0 品質を上げる方が、全体の歩留まりが良い。

状態:

- `bayesian_dynamic_tuning_plan.md` は Pre/Post 監査まで収束（Round 3 で `✅ converged`）
- Go: `ai.segmentScore` を追加し、per-agent segstate を Pebble に永続化
- TS: `EventSegmenter` を `ai.segmentScore` へ切替、tuning config も追加
- `go build ./...` / `npm run build:ts` ともに成功
- usefulness posterior / Bayesian rerank は Phase 4 側で仕上げる（Phase 2 の範囲外）

## Phase 3: Human-like D1 Consolidation

対象:

- `d1_dynamic_clustering_plan.md` の Phase 1

やること:

1. exact-pairwise primary clustering を導入
2. `temporal context vector` を作る
3. `surprise-boundary -> must-not-link`
4. union-find + guardrail cluster
5. `high-salience singleton` 救済
6. `maxClusterTokens` / `perNodeTokenCap` guard
7. `consolidation_key` による idempotency

このフェーズの狙い:

- D1 を「似たログ 10 件の要約」から脱却させる
- 同じ流れに属する経験をまとめる

完了条件:

- D1 cluster が time gap と boundary を無視しない
- high-salience な単発記憶が埋もれない
- `ep-expand` の child 群が読みやすい

理由:

ここが `v0.2.0` の一番の目玉。  
ただし、材料の D0 と metadata が整ってから入れた方が成功率が高い。

状態:

- Phase 3 core 実装は完了
- primary path は監査反映で `exact pairwise` に確定
- `contextVector` は ephemeral 計算のみで、永続 schema 変更は最小化
- `consolidation_key` を frontmatter に追加して retry 重複を防止
- `go build ./...` / `npm run build:ts` ともに成功
- Post-Implementation 再監査まで完了し、`✅ converged`
- carry-over は `collectActiveD0Nodes()` の全走査最適化から始まり、Phase 3.1 全体で解消済み

## Phase 3.1: Replay Scheduler & Collection Efficiency

対象:

- `phase_3_1_replay_scheduler_plan.md`

やること:

1. `collectActiveD0Nodes()` の全走査をやめる
2. active D0 の早期停止可能な収集へ寄せる
3. D1 優先の local replay scheduler を入れる
4. `FSRS-inspired` な `stability / retrievability / due_at` を持つ
5. implicit `Again/Good` で state を更新する
6. replay API budget を固定する

このフェーズの狙い:

- carry-over の性能問題を Phase 4 前に潰す
- 「何を定着させるべきか」を local に決められるようにする
- recall 前に memory lifecycle を 1 段整える

完了条件:

- active D0 収集が総件数に比例しにくくなる
- D1 / high-salience memory に `due_at` が付く
- replay 候補選別が local-only で動く
- 1 run あたりの API 上限が守られる

実装状況:

- ✅ Phase 3.1a: active D0 の in-memory snapshot index を追加し、`collectActiveD0Nodes()` の主経路を全走査から切り替えた
- ✅ Phase 3.1b: `ReplayState` / `ReplayObservation` / `ReplayLease` を別 keyspace で永続化した
- ✅ Phase 3.1c: due candidate 選別、lease/in-flight 制御、background replay scheduler を入れた

理由:

これは recall の後ではなく前にやる方が効率がいい。  
Phase 4 の「引く」前に、Phase 3.1 で「育てる」を整える。

## Phase 4: Smarter Recall

対象:

- `bayesian_dynamic_tuning_plan.md` の Phase 2
- `semantic_topics_plan.md` の recall facet 部分

やること:

1. `topics` aware recall（hit0 時は vector-only fallback）
2. candidate rerank 導入
3. usefulness posterior を持つ
4. `semantic + freshness + surprise + usefulness + exploration` の軽量 rerank
5. `Phase 3.1` が入る場合は `due_at / retrievability / stability` を補助 signal として扱う
6. `assemble()` 経路で `ai.recallFeedback` を返し、shown/used/expanded の telemetry を残す

補足（Phase 3.1 との衝突回避）:

- `due_at` / `retrievability` は **semantic relevance が十分高い候補にだけ**「tie-breaker」として効かせる（query relevance を守る）
- `topics` は **strict facet がヒット0のときは soft hint にフォールバック**し、topics 未充足でも recall が空になりにくいようにする

このフェーズの狙い:

- memory を出す側も賢くする
- D0/D1 の改善を実利用へ返す

完了条件:

- same-query stability が上がる
- token waste が減る
- 役に立つ記憶が上に来やすい

理由:

保存側と統合側が改善された後にやると、チューニング効率が高い。

### `Phase 3.1` の影響

影響はある。しかも比較的強い。  
ただし Phase 4 を壊す種類ではなく、「前提を良くする」影響。

主に変わるのは次。

- rerank 候補に `due_at` / `retrievability` / `stability` を補助 feature として足せる
- `usefulness posterior` と replay state を分けて持つ設計が必要になる
- retrieval 側の exploration を強くしすぎると replay scheduler と二重投資になる

要するに、Phase 4 は再設計不要。  
ただし `Phase 3.1` 前提で score feature と weight の置き方は少し見直した方がいい。

## Phase 4.1: Recall Calibration & Importance Bridge

対象:

- `phase_4_1_recall_calibration_plan.md`

やること:

1. usefulness posterior の clamp / semantic floor を固定する
2. `due_at / retrievability / stability` を tiny tie-breaker として明文化する
3. `topics strict / soft / fallback` の運用ルールを固定する
4. score breakdown と rerank telemetry を structured に残す
5. `v0.2.1` の `importance_score` に流用できる観測を recall 側から先に集める

このフェーズの狙い:

- Phase 4 を「動く」から「安定して調整できる」へ進める
- replay と recall の責務分離を固定する
- importance policy の導入を勘ではなく観測ベースに寄せる

完了条件:

- usefulness を少し上げても unrelated memory が勝ちにくい
- replay due 候補が recall をハイジャックしない
- topics strict hit 0 でも recall が死ににくい
- score breakdown を見て順位変動の理由が追える
- API 呼び出し数は増えない

理由:

`Phase 4` だけだと recall は賢くなるが、運用上の調整点がまだ散る。  
`Phase 4.1` を挟むと `Phase 5` は release polish と telemetry 整理に集中しやすい。

### `hippocampus_replay_importance_note.md` との関係

`Phase 4.1` は importance policy の本実装ではない。  
ここでやるのは

- 重みの安定化
- 観測の先行追加
- replay / recall / future importance の責務分離

まで。

`importance_score` 本体、`noise_score`、`prune/tombstone` は `v0.2.1` 側へ回す。

## Phase 4.2: Release Readiness & Telemetry Closure

対象:

- `phase_4_2_release_readiness_plan.md`

やること:

1. `Phase 5` で約束した telemetry の最低限を実体化する
2. replay / recall の structured observability を閉じる
3. release notes / runbook / docs index を今のアーキテクチャに揃える
4. `go/internal/vector` の recall / replay regression test を追加する

このフェーズの狙い:

- `Phase 4.1` の橋渡しを release-ready な形で閉じる
- `Phase 5` を雑多な片付けではなく packaging に寄せる
- `v0.2.1` の `importance_score` に向けた観測基盤を固める

完了条件:

- `recall_shown_count` など最低限の aggregate telemetry が揃う
- replay / recall の run summary を structured に追える
- rebuild / recovery / rollback の runbook が docs 化される
- `go/internal/vector` に最低限の regression test が入る
- `README` と `master plan` が現状と矛盾しない

理由:

ここを挟むと、release blocker が `Phase 5` に埋もれない。  
しかも、`importance_score` の前提観測を docs だけでなくコードにも落とせる。

## Phase 5: Release Polish

対象:

- 全体横断

やること:

1. config defaults と feature flags の最終整理
2. migration / rebuild / recovery の実運用チェック
3. release candidate の packaging 確認
4. v0.2.0 release notes の最終化
5. docs の最終同期と release checklist 化

このフェーズの狙い:

- リリースとして回る状態に仕上げる
- `Phase 4.2` までで閉じた telemetry / observability / tests を、release 手順へ安全に接続する

### `Phase 3.1` の影響

影響はある。ただし中くらい。

増える作業は次。

- replay state の設定値整理
- active D0 index の rebuild / recovery 手順
- `due_at` / replay budget の既定値整理
- release notes への `D1-first replay scheduling` 追記
- `Phase 4.2` で入れた telemetry / observability の最終確認

目的は変わらないが、polish 範囲は明確に増える。

### `importance_score` 導入を見越した telemetry 先行仕込み

この節の**実装本体は `Phase 4.2`**で行う。  
`Phase 5` では naming / docs / release note の最終確認だけを見る。

`v0.2.0` では、まだ `importance_score` そのものは score 計算や prune 判定に入れない。  
代わりに、`v0.2.1` 以降で重みを決めるための判断材料だけを先に残す。

方針はこう。

- API 呼び出しは増やさない
- LLM 判定を増やさない
- `EpisodeRecord` の意味をまだ変えない
- append-only で観測を残し、後から集計できるようにする

### 先に残すべき観測カテゴリ

#### 1. importance 候補 signal

各 episode について、将来の importance selection に使える材料を残す。

- `episode_id`
- `class` (`d1` / `manual-save` / `singleton` / `d0`)
- `surprise`
- `topics_count`
- `is_d1`
- `is_manual_save`
- `has_parent_d1`
- `child_count`
- `age_seconds`

狙い:

- 「強い記憶か」
- 「人間が明示的に重要と言ったか」
- 「すでに D1 に吸収されているか」

を後から再計算できるようにする。

#### 2. usefulness / reuse signal

実際に recall や expand で役に立ったかを残す。

- `recall_shown_count`
- `recall_top_rank`
- `expand_count`
- `direct_good_count`
- `miss_count`
- `last_recalled_at`
- `last_expanded_at`

狙い:

- semantic に近いだけの記憶
- 実際に使われ続ける記憶

を分けて見られるようにする。

#### 3. replay weakness / timing signal

疑似 FSRS 側の状態を importance 側からも参照できるようにする。

- `stability`
- `retrievability`
- `difficulty`
- `review_count`
- `lapses`
- `due_at`
- `due_lag_seconds`

狙い:

- 「弱いから捨てる」のではなく
- 「弱いが補強価値がある」を後から見分ける

ための土台を作ること。

#### 4. noise / disposal signal

将来の `retain / compress / tombstone / prune` 判定に使う材料を残す。

- `redundancy_with_parent_d1`
- `absorbed_into_d1`
- `never_reused_days`
- `quarantine_tag`
- `consolidation_skip_tag`
- `consolidation_failed_tag`

狙い:

- 低 importance なだけの記憶
- 本当にノイズ寄りの記憶

を混同しないようにすること。

#### 5. API efficiency signal

replay scheduler がどこで API を使い、どこで local に止められたかを残す。

- `replay_selected_count`
- `replay_skipped_reason`
- `replay_llm_called`
- `replay_no_review_count`
- `budget_skip_count`

狙い:

- importance policy を足した時に API コストが本当に下がったか
- どの skip 条件が効いているか

を後から検証できるようにすること。

### 実装上の差し込みポイント

大きな schema 変更ではなく、既存フローに相乗りする。

- `ReplayObservation` に optional field を足して、class / due lag / skipped reason を残す
- `RecordRecall()` と recall rerank 周辺で `shown` / `rank` / `topics hit` を残す
- `handleExpand()` 由来の Good 系イベントを reuse signal として残す
- replay timer / manual replay の両方で run summary を structured log に残す

### Phase 5 でやるべき範囲

`v0.2.0` に入れるのはここまで。

- telemetry field の整理
- structured log / observation key の命名統一
- recovery 手順と observability 手順の docs 化
- release note に「importance_score の前提観測を先行で追加」と書ける状態まで整える

まだ入れないもの:

- `importance_score` の本計算
- importance を replay rerank に直接入れること
- prune / tombstone の自動実行
- importance 判定のための新規 LLM 呼び出し

---

## 実装ロードマップ

## Milestone A

範囲:

- E2/E3
- `topics` スキーマ
- `ep-save` `topics` 対応

成果:

- memory の入力が安全になる
- D0 に意味ラベルが入る

ユーザー体感:

- 手動保存が賢くなる
- 将来の recall / D1 の種ができる

## Milestone B

範囲:

- HealingWorker の topics 自動生成
- Bayesian segmentation Phase 1

成果:

- 自動保存 D0 の意味と境界が安定する

ユーザー体感:

- episode の切れ方が自然になる

## Milestone C

範囲:

- D1 dynamic consolidation Phase 1

成果:

- D1 が context-aware, boundary-aware になる

ユーザー体感:

- `ep-expand` で見た時に「この塊は確かに同じ流れだ」と感じやすくなる

## Milestone C.5

範囲:

- collection efficiency
- D1-first replay scheduling

成果:

- consolidation のベースコストが下がる
- 定着させる memory が local に選別される

ユーザー体感:

- 無駄な再処理が減る
- よく使う記憶がだんだん安定して残りやすくなる

## Milestone D

範囲:

- topics-aware recall
- Bayesian rerank

成果:

- memory を引く側も賢くなる

ユーザー体感:

- 「欲しい記憶」が上に来やすくなる

## Milestone D.5

範囲:

- recall calibration
- usefulness / replay / topics の guardrail 固定

成果:

- recall が「賢いが不安定」ではなく「賢くて調整しやすい」状態になる
- `v0.2.1` の importance policy に使える観測が先に貯まる

ユーザー体感:

- 上位結果のブレが減る
- 不意に関係ない記憶が上がる挙動が減る

## Milestone D.8

範囲:

- release-readiness closure
- telemetry / observability / runbook / vector regression tests

成果:

- `Phase 5` の前に release blocker が見える
- `importance_score` 用の前方互換観測が docs だけでなくコードに揃う
- rebuild / recovery / rollback が人間に追える

ユーザー体感:

- 壊れた時に戻しやすい
- recall / replay の挙動が調べやすい
- リリース後の不安が減る

## Milestone E

範囲:

- release polish
- replay scheduler 周辺の運用整理

成果:

- config / rebuild / recovery が人間に運用しやすい形で揃う

ユーザー体感:

- 変化が大きくても壊れにくく、戻しやすい

---

## どの順番が効率的か

いちばん効率がいい順はこれ。

1. `E2/E3`
2. `topics`
3. `Bayesian segmentation`
4. `D1 consolidation`
5. `Replay scheduler & collection efficiency`
6. `Bayesian recall rerank`
7. `Recall calibration & importance bridge`
8. `Release readiness & telemetry closure`

理由はシンプル。

- `E2/E3` は全体の安全弁
- `topics` は全体の意味メタデータ基盤
- `Bayesian segmentation` は D0 品質を上げる
- `D1 consolidation` は D0 を材料にする
- `Phase 3.1` は D1 をどう定着させるかを決める
- `recall rerank` は最後に全改善の利益を回収する
- `Phase 4.1` は recall を運用で壊れにくい形へ整え、次の importance policy への橋を架ける
- `Phase 4.2` は release blocker を先に露出させ、Phase 5 を packaging に寄せる
- `Phase 5` は増えた state と config を人間が扱える形へ畳む

逆に非効率なのは、

- 先に D1 を作り込んでから D0 を直す
- 先に recall rerank を詰めてから D1 品質を直す

この順。後で前提が変わって手戻りが増える。

---

## v0.2.0 の定義

`v0.2.0` を切っていい状態は次。

- empty embed guard が入っている
- `topics` が D0/D1 に保存される
- fixed threshold `0.2` から脱却している
- D1 が `context-aware, boundary-aware, replay-prioritized` の初期版になっている
- D1 / high-salience memory に local replay scheduling が入っている
- recall が少なくとも `topics` と軽量 rerank を扱える
- recall の weight / tie-break / topics fallback が calibration された状態になっている
- release-ready な telemetry / observability の最低限が揃っている
- `internal/vector` の recall / replay guardrail に回帰テストがある
- replay state / active index の rebuild 手順が整理されている

ここまで入ると、`v0.1.x` から見て明確に別物と言える。

---

## 今回やらないこと

`v0.2.0` では無理に入れない。

- full schema memory
- D1 からさらに D2 への昇格
- LLM judge ベースの重い feedback loop
- full BOCPD
- learned replay policy の本格運用

これらは `v0.3.x` 以降へ回す方が健全。

---

## リスクと対処

## リスク 1

D1 改修が重くて 10 分 timeout に近づく

対処:

- temporary D0 HNSW
- cluster size / span guard
- replay priority で全件一律処理を避ける

## リスク 2

topics と D1 prompt の変更で API 呼び出しが増える

対処:

- HealingWorker でまとめて生成
- D1 prompt は `topics` を利用して補助する
- 最初は追加呼び出しではなく既存呼び出し拡張を優先

## リスク 3

Bayesian tuning と D1 clustering を同時に触ってデバッグが難しくなる

対処:

- segmentation と consolidation を milestone で分離
- 観測ログを先に増やす

## リスク 4

FSRS をそのまま移植して episodic memory と噛み合わない

対処:

- full FSRS ではなく `FSRS-inspired`
- 対象は D1 と high-salience memory に限定
- optimizer は `v0.2.0` に入れない

---

## 推奨の着手順

もし明日から実装するなら、この順がいちばんきれい。

1. `plan_e2_e3_embed_guard.md` を完了
2. `semantic_topics_plan.md` の Step 1-4 を完了
3. `bayesian_dynamic_tuning_plan.md` の Phase 0-1 を完了
4. `d1_dynamic_clustering_plan.md` の Phase 1 を完了
5. `phase_3_1_replay_scheduler_plan.md` の Phase 3.1a-3.1c を完了
6. `semantic_topics_plan.md` の recall facet
7. `bayesian_dynamic_tuning_plan.md` の Phase 2
8. `phase_4_1_recall_calibration_plan.md`
9. `phase_4_2_release_readiness_plan.md`

---

## 最終判断

`v0.2.0` の親ロードマップは、

- まず壊れないようにする
- 次に意味を持たせる
- その上で境界を学習させる
- その材料で D1 を人間っぽく統合する
- 最後に recall を賢くする
- その直後に release-readiness を閉じる

この順で進めるのが最も効率がいい。

Episodic-Claw の現状から見ると、これがいちばん手戻りが少なく、しかもリリースとしての変化量も大きい。`v0.2.0` の道筋としてかなり素直です。

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Post-Implementation  
> Prior audits: 0 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| なし | 初回監査 |

✅ No new critical issues found. Document has converged.

### ⚠️ Impact on Related Features *(new only)*
- なし

### 🚨 Potential Problems & Risks *(new only)*
- なし

### 📋 Missing Steps & Considerations *(new only)*
- なし

### 🕳️ Unaddressed Edge Cases *(new only)*
- なし

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| LOW | 追加アクションなし | 変更点が実装範囲と整合 | ✅ New |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Pre-Implementation  
> Prior audits: 1 | New findings this round: 5

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| なし（Round 1 は Post-Implementation で Phase 4 未対象） | 🔄 Not applicable |

### ⚠️ Impact on Related Features *(new only)*
- Phase 4 の recall rerank は Phase 3.1 の replay scheduler と同じ feature（`due_at` / `retrievability` / `stability`）を触るので、設計が曖昧だと「replay で育てる」と「recall で引く」が衝突する。特に `due` の意味を「今復習すべき」に寄せすぎると、query relevance を壊して unrelated memory が上に来る。
- `topics` は Phase 1 の保存経路だけでなく、Phase 4 の recall と TS 側 `EpisodicRetriever` にも影響する。ここが未接続だと「topics を入れたのに効かない」という体験になる。

### 🚨 Potential Problems & Risks *(new only)*
- **BLOCKER**: `due_at` / `retrievability` / `stability` を recall rerank に入れる条件が未定義。セマンティック一致が弱い候補に `dueBoost` を与えると、replay policy が recall をハイジャックする。Phase 4 では「query relevance を守るガード」を必須にするべき。
- **HIGH**: `topics` の扱いが「strict filter」なのか「soft boost」なのか、この master plan の文言だと解釈が割れる。strict にすると topics 未充足期間や表記揺れで recall が空になりやすい。
- **HIGH**: usefulness posterior の観測定義が Phase 3.1 の `ReplayObservation` とズレる可能性がある。`recall_shown` / `expand_good` / `manual-save` をどの event に紐づけるかが曖昧なままだと、posterior が二重カウントまたは更新不足になり、rerank が不安定になる。

### 📋 Missing Steps & Considerations *(new only)*
- Phase 4 の完了条件が結果指標だけで、最低限の検証手順が書かれていない。少なくとも「topics 指定あり/なし」「topics がヒットしない」「replay が直前に走った直後」の 3 ケースで recall の安定性を確認する手順が要る。
- Phase 4 で `candidateK` を増やす場合の I/O コスト（frontmatter parse, body 読み込み）と、API 呼び出し増加を避ける方針が master plan 側に明文化されていない。

### 🕳️ Unaddressed Edge Cases *(new only)*
- `topics` フィルタ指定があるが、候補側に topics が無い（未 backfill / legacy）場合に「空を返す」のか「vector-only にフォールバックする」のかが未定義。
- replay scheduler が `DirectGood/ExpandedGood` を付けた直後に同じクエリで recall が走った場合、posterior と replay state の両方が効いて同じエピソードに過剰バイアスが掛かる可能性がある（double counting）。feature を入れるなら weight と clamp のルールが必要。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| BLOCKER | `due_at` / `retrievability` / `stability` は「semanticScore が一定以上」の候補にだけ小さな補助 feature として適用し、上限 clamp を決める | query relevance を守りつつ Phase 3.1 の利益を回収するため | ✅ New |
| HIGH | `topics` は Phase 4 では strict filter ではなく「boost + ヒット0ならフォールバック」を既定にし、strict は将来のオプションにする | topics 未充足期間でも recall が壊れないようにするため | ✅ New |
| HIGH | usefulness posterior の更新契約を master plan に追記する（例: `shown` は recall 応答で、`hit` は expand / manual-save / replay Good で） | posterior が壊れると rerank 全体が不安定になるため | ✅ New |
| MED | Phase 4 の最低限の検証シナリオと observability（score 分解ログ）を追記する | tuning を短期で回せるようにするため | ✅ New |
| LOW | Phase 2 状態欄の「未実装」表現は、実装の進捗とズレやすいので「Phase 4 で仕上げ」に寄せて曖昧さを減らす | ドキュメント駆動での手戻りを減らすため | ✅ New |

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Post-Implementation  
> Prior audits: 2 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| `due_at` 系 feature が recall をハイジャックしうる | ✅ Resolved（`sim >= 0.35` かつ clamp 付きの tiny tie-breaker に限定） |
| topics の strict/boost が曖昧 | ✅ Resolved（`strictTopics` で明示。既定は boost-only、ep-recall は strict を既定） |
| usefulness posterior の更新契約が曖昧 | ✅ Resolved（`RecordRecall` + `ai.recallFeedback` を基本線に固定） |
| Phase 4 の最低限検証・観測が不足 | 🔄 Partially addressed（score 分解の観測は Phase 5 telemetry へ） |
| Phase 2 状態欄の「未実装」表現 | ✅ Resolved（表現を「Phase 4 で仕上げ」に寄せた） |

✅ No new critical issues found. Document has converged.
