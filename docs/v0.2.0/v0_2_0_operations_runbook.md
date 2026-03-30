# v0.2.0 Operations Runbook

更新日: 2026-03-30

## Purpose

`v0.2.0` の replay / recall / D0-D1 pipeline を運用するための最小 runbook。

## Health Checks

1. `go build ./...` が通ること
2. `npm run build:ts` が通ること
3. `replay:last_summary` meta が更新されていること
4. `docs/v0_2_0_master_plan.md` の Phase 4.2 と Phase 5 の境界が明確であること

## Replay Recovery

1. replay scheduler の structured summary を確認する
2. `budget_skip_count` と `lease_conflict_count` を確認する
3. `replay:last_skip_reason` と `replay:last_summary` を確認する
4. 必要なら replay state keyspace を rebuild する

## Recall Calibration

1. `strictTopics` が false か true かを確認する
2. `semanticFloor` が高すぎないかを確認する
3. `topicsMissingPenalty` が legacy episode を沈めていないかを確認する

## Active D0 Index

1. active D0 の snapshot index が空でないことを確認する
2. drift が疑われるなら rebuild する
3. archive / quarantine 後に index が追随しているか確認する

## Rollback

1. recall calibration knobs をデフォルトへ戻す
2. replay scheduler を止める
3. structured summary を見て原因を切り分ける
4. regression test を再実行する
