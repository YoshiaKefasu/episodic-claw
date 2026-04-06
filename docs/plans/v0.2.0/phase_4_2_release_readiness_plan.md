# Phase 4.2: Release Readiness & Telemetry Closure Plan

更新日: 2026-03-30

## 目的

`Phase 4.1` までで recall の挙動はかなり整った。  
ただし、`v0.2.0` を安心して切るには、まだ 4 種類の穴が残っている。

- `importance_score` 用 telemetry が docs の約束より薄い
- replay / recall observability が運用向けに閉じていない
- release docs / runbook / index が新アーキテクチャに追いついていない
- `internal/vector` の回帰テストが薄い

`Phase 4.2` は、この 4 つをまとめて閉じるためのフェーズである。  
主役は新しい記憶アルゴリズムではない。  
主役は **release readiness の実体化** である。

---

## 結論

`Phase 4.2` は入れた方がいい。  
理由は明快で、いま残っている穴はほとんど `Phase 5` 的に見える一方で、

- recall / replay の境界にあるもの
- `importance_score` の前提観測に直結するもの
- `v0.2.0` の実運用手触りを左右するもの

が中心だから。

先にここを切り出すと、

- `Phase 4.1` の橋渡しを本当に橋として閉じられる
- `Phase 5` を「最後の片付け」に寄せやすい
- `v0.2.1` の `importance_score` を観測ベースで始められる

---

## まず答え

### 1. 何を Phase 4.2 に入れるか

入れるのは次の 4 本。

1. telemetry schema closure
2. replay / recall observability closure
3. release docs / recovery runbook closure
4. vector regression test closure

### 2. 何をまだ入れないか

ここではまだ入れない。

- `importance_score` の本計算
- prune / tombstone / disposal automation
- learned ranking
- replay optimizer
- D2 以上の memory 昇格

---

## なぜ Phase 5 ではなく 4.2 として切るのか

`Phase 5` は広い。  
このままだと、

- docs 更新
- release notes
- rebuild / recovery
- telemetry
- observability
- tests

が 1 つの箱に入って、どれが release blocker かが見えにくい。

今回の残りは実際には `Phase 4` の後始末に近い。

- recall が何を返したか
- replay が何を育てたか
- それをどう観測するか

という、ranking と memory lifecycle の境界にある。

だから `Phase 4.2` として独立させた方が整理しやすい。

---

## アーキテクチャ上の位置づけ

```text
Phase 4
  = recall を賢くする

Phase 4.1
  = recall を壊れにくく調律する

Phase 4.2
  = recall / replay / telemetry / docs / tests を release-ready に閉じる

Phase 5
  = 残りの config / migration / packaging をまとめて仕上げる
```

`Phase 4.2` は recall の機能拡張ではない。  
**release gate を越えるための実装閉路** である。

---

## 現状の穴

### 1. telemetry が docs 先行

`Phase 4.1` で `shown / used / expanded` 契約までは入った。  
でも `Phase 5` で列挙した

- `recall_shown_count`
- `recall_top_rank`
- `expand_count`
- `direct_good_count`
- `miss_count`
- `due_lag_seconds`
- `replay_selected_count`
- `replay_skipped_reason`
- `budget_skip_count`

のような集約 signal はまだ薄い。

### 2. replay scheduler の observability が stderr 中心

現状の replay scheduler は動く。  
ただし、

- selection
- skip reason
- budget hit
- no-review
- success / failure

を `structured log` として後追い集計しやすい形までは閉じていない。

### 3. docs index / runbook が古い層を引きずっている

`docs/README.md` はまだ古い phase 群と `Phase 6 Semantic Topics` の表現を持っていて、
今の `v0.2.0` ロードマップの入口として弱い。

### 4. vector package に回帰テストがない

いま一番変化量が大きいのは `go/internal/vector` なのに、

- recall rerank
- topics fallback
- replay state update
- replay candidate selection

に package-local test がない。

---

## Phase 4.2 のスコープ

### やること

1. `importance bridge telemetry` を docs の約束まで閉じる
2. replay / recall の structured observability を追加する
3. runbook / release notes / docs index を新アーキテクチャに揃える
4. `internal/vector` の最低限の regression test を追加する

### やらないこと

1. 新しい ranking feature の導入
2. `importance_score` の実装
3. pruning policy の導入
4. replay scheduler の再設計
5. large-scale migration / backfill の自動実行

---

## Workstream 1: Telemetry Schema Closure

## 1.1 目的

`Phase 4.1` で定義した recall calibration 観測を、  
`Phase 5` と `v0.2.1` でそのまま使える粒度まで閉じる。

## 1.2 方針

raw event と aggregate counter を分ける。

- raw event: append-only
- aggregate counter: cheap to read

これを混ぜると、

- hot path が重くなる
- 後から意味が変わる
- debug と運用メトリクスが衝突する

ので分ける。

## 1.3 推奨データ設計

### raw observation

用途:

- 後追い分析
- debug
- calibration

最低限の field:

- `event_id`
- `workspace_id`
- `episode_id`
- `event_type` (`recall_shown` / `recall_used` / `recall_expanded` / `replay_selected` / `replay_skipped` / `replay_reviewed`)
- `query_hash`
- `rank`
- `candidate_rank`
- `topics_mode`
- `topics_state`
- `occurred_at`
- `source`

### aggregate stats

用途:

- rerank の補助 signal
- release 後の health check
- `importance_score` の前方互換 signal

最低限の field:

- `recall_shown_count`
- `recall_top_rank_best`
- `expand_count`
- `direct_good_count`
- `miss_count`
- `last_recalled_at`
- `last_expanded_at`
- `replay_selected_count`
- `replay_reviewed_count`
- `replay_no_review_count`
- `budget_skip_count`
- `last_replay_at`
- `last_replay_skip_reason`

### replay timing stats

- `due_lag_seconds_last`
- `due_lag_seconds_max`
- `last_due_at`

## 1.4 実装ルール

- `EpisodeRecord` を重くしすぎない
- raw event は別 keyspace に置く
- aggregate は episode 単位の軽量メタに寄せる
- `handleRecallFeedback` は telemetry-only を維持する
- usefulness posterior の更新と telemetry 集約を混同しない

## 1.5 対象ファイル

- `go/main.go`
- `go/internal/vector/store.go`
- `go/internal/vector/replay.go`
- `src/retriever.ts`
- `src/rpc-client.ts`
- `src/types.ts`

## 1.6 完了条件

- docs に書いた aggregate signal が最低限揃う
- `shown / used / expanded` が raw event と aggregate の両方へ橋渡しされる
- replay 側も `selected / skipped / reviewed` が追える

---

## Workstream 2: Observability Closure

## 2.1 目的

replay / recall の動作を、  
release 後に「なんとなく」ではなく「数字で」追えるようにする。

## 2.2 現状の問題

いまの replay scheduler は stderr 出力中心で、

- skip reason
- budget stop
- reviewed count
- no candidate

が structured に残らない。

## 2.3 追加すべき run summary

1 run ごとに少なくともこれを出す。

- `workspace_id`
- `started_at`
- `finished_at`
- `due_candidates`
- `selected_count`
- `reviewed_count`
- `no_review_count`
- `lease_conflict_count`
- `budget_skip_count`
- `skipped_reasons`
- `error_count`

## 2.4 recall 側の observability

少なくとも次を残す。

- query hash
- result count
- strict topics fallback 発火有無
- top1 / topK score breakdown
- semantic floor violation count

## 2.5 出力方針

- `EmitLog()` 経由で JSON 化できる形に揃える
- per-result 全量永続化はしない
- sampling または debug mode を使う

## 2.6 対象ファイル

- `go/main.go`
- `go/internal/vector/replay.go`
- `go/internal/vector/store.go`

## 2.7 完了条件

- replay run summary が structured に残る
- recall calibration の異常を log から追える
- docs に log 読み方が書かれている

---

## Workstream 3: Runbook & Release Docs Closure

## 3.1 目的

`v0.2.0` を使う人が、

- 何が変わったか
- 壊れた時にどこを見るか
- index / replay state がずれた時にどう戻すか

を 1 回で辿れるようにする。

## 3.2 追加すべき docs

新規作成候補:

- `docs/v0_2_0_release_notes_draft.md`
- `docs/v0_2_0_operations_runbook.md`

更新対象:

- `docs/README.md`
- `docs/v0_2_0_master_plan.md`

## 3.3 runbook に最低限入れるもの

1. active D0 index の rebuild / recovery
2. replay state keyspace の確認方法
3. strict topics fallback の確認方法
4. recall calibration knob の rollback 方法
5. replay scheduler の health check

## 3.4 release notes に最低限入れるもの

1. dynamic segmentation
2. topics-aware recall
3. context-aware D1 consolidation
4. D1-first replay scheduling
5. recall calibration
6. known limitations

## 3.7 反映済み成果物

- `docs/v0_2_0_release_notes_draft.md`
- `docs/v0_2_0_operations_runbook.md`

## 3.5 README 更新方針

- `v0.2.0` の主導線を最上段へ上げる
- 古い phase 名の表現を今の master に合わせる
- `Phase 4.2` と `Phase 5` の位置づけを短く書く

## 3.6 完了条件

- 新しい人が `README -> master plan -> runbook` で迷わない
- release notes 草案が 1 ファイルで存在する
- rebuild / recovery 手順が docs 化されている

---

## Workstream 4: Vector Regression Test Closure

## 4.1 目的

`go/internal/vector` の変更を、  
build success だけでなく behavior でも守る。

## 4.2 最低限ほしいテスト

### recall rerank

1. semantic floor 未満の候補が replay tie-break で 1 位にならない
2. `topicsMismatchPenalty` と `topicsMissingPenalty` が別挙動になる
3. strict topics hit 0 で fallback が発火する
4. `CandidateRank` と `Rank` が正しく出る

### replay state

1. `ExpandedGood` で `stability` が上がる
2. `Again` で `lapses` が増える
3. D1 / manual / singleton / d0 で初期 state が分かれる

### replay candidate selection

1. D0 全件ではなく D1 / manual / singleton 優先
2. due 未到来候補は選ばれない
3. lease 競合時に二重処理しない

## 4.3 テストファイル候補

- `go/internal/vector/store_recall_test.go`
- `go/internal/vector/replay_state_test.go`
- `go/internal/vector/replay_scheduler_test.go`

## 4.4 完了条件

- recall / replay の主要 guardrail に test がある
- `go test ./...` が `internal/vector` を本当に検証する

---

## 実装順

いちばん安全な順はこれ。

1. telemetry schema closure
2. replay / recall observability
3. vector regression tests
4. runbook / release notes / README 更新

理由:

- 先に schema を決めないと log と test が揺れる
- observability がないと test failure の意味が追いにくい
- docs は最後に、実装された事実へ合わせて閉じる方がぶれない

---

## 成功条件

- `Phase 5` に書いた telemetry 項目のうち、`v0.2.0` に必要な最低限が揃う
- replay / recall の run summary を structured に追える
- rebuild / recovery / rollback の手順が docs 化される
- `internal/vector` に最低限の regression test が入る
- `README` と `master plan` が現状と矛盾しない

---

## Phase 5 との関係

`Phase 4.2` を入れると、`Phase 5` はかなり細くできる。

`Phase 4.2` が受け持つ:

- telemetry の実体化
- observability closure
- runbook / release notes 草案
- vector regression tests

`Phase 5` に残す:

- config defaults の最終整理
- migration / rebuild 実運用チェック
- packaging / release cut
- release candidate の最終確認

つまり `Phase 4.2` は、  
**Phase 5 を「雑多な片付けフェーズ」にしないための整理フェーズ** である。

---

## v0.2.1 への接続

ここを入れておくと、次の `importance_score` は

- docs の願望
- 手作業の勘

ではなく、

- recall event
- replay event
- aggregate usage signal
- due lag / budget signal

を見ながら設計できる。

この意味で `Phase 4.2` は、  
`v0.2.0` の polish であると同時に、  
`v0.2.1` の観測基盤でもある。

---

## 最終判断

`Phase 4.2` は差し込んだ方がいい。

いま残っている穴は小さく見えるが、

- release readiness
- observability
- telemetry consistency
- regression safety

に集中している。  
ここを曖昧にしたまま `Phase 5` へ流すより、  
`Phase 4.2` で一度まとめて閉じた方が、`v0.2.0` の仕上がりは確実に良くなる。

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
| LOW | 追加アクションなし | 実装・docs・tests が計画と整合 | ✅ New |
