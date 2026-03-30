# Phase 4.1: Recall Calibration & Importance Bridge Plan

更新日: 2026-03-30

## 目的

`Phase 4` で入った `topics-aware recall + lightweight Bayesian rerank` を、

- query relevance を壊さず
- `Phase 3.1` の replay scheduler と衝突させず
- 将来の `importance_score` へ自然につなげる

ための軽量な仕上げフェーズとして整理する。

このフェーズの主役は新しい派手な記憶機能ではない。  
主役は **重みの安定化、観測の追加、責務分離の固定** である。

---

## 結論

`Phase 4.1` は入れる価値が高い。  
ただし、ここでやるべきなのは `hippocampus-inspired importance policy` の本実装ではない。

入れるべきなのは次の 3 つ。

1. usefulness posterior の重みと clamp を明文化して安定化する
2. replay state (`due_at / retrievability / stability`) を recall では tiny tie-breaker に固定する
3. `v0.2.1` の `importance_score` に使う観測を、追加 API なしで先に残す

逆に、まだ入れないものはこれ。

- `importance_score` の本計算
- recall rank への importance 直接投入
- prune / tombstone / disposal 自動化
- importance 判定のための追加 LLM 呼び出し

要するに、`Phase 4.1` は **Phase 4 の調律フェーズ** であり、**v0.2.1 の橋渡しフェーズ** でもある。

---

## なぜ Phase 4 の次に挟むのか

現状の `Phase 4` はもう機能している。  
ただし、そのままだと今後の調整点が 3 箇所に散る。

### 1. usefulness が強すぎると semantic relevance を壊す

`usefulness posterior` は「前に役立った」記憶を押し上げる。  
ここが強すぎると、今回の query にそこまで合っていないのに、過去に人気だった memory が勝つ。

### 2. replay state を recall へ強く入れると役割が混ざる

`Phase 3.1` の `due_at / retrievability / stability` は「今、育てたいか」の signal。  
Recall は「今、聞かれていることに合うか」が主役なので、ここを逆転させてはいけない。

### 3. `importance_score` を入れたくなった時に観測が足りない

次の `v0.2.1` で importance / noise policy を入れるなら、

- 何が繰り返し使われたか
- 何が replay 対象になっても使われなかったか
- 何が D1 に吸収済みか

を先に観測しておかないと、重みが勘ベースになる。

---

## Phase 4.1 のスコープ

### やること

1. recall score の guardrail を固定する
2. usefulness posterior の調整 knobs を config 化する
3. score breakdown と telemetry を structured に残す
4. `topics strict / soft` の使い分けを docs と config で固定する
5. `Phase 3.1` と `Phase 4` の責務境界を文書化する

### やらないこと

1. 新しい memory class の導入
2. full bandit / profile optimizer
3. new LLM judge feedback
4. importance-aware pruning
5. replay candidate gate の score 化

---

## アーキテクチャ上の位置づけ

`Phase 4.1` を入れると、記憶の役割分担はこう固定される。

```text
Phase 3.1 replay scheduler
  = 何を育てるか / いつ再活性化するか

Phase 4 recall rerank
  = 今の query に何を返すか

Phase 4.1 calibration
  = 両者が喧嘩しないように重みと観測を固定する

v0.2.1 importance policy
  = 将来、何を残し何を落とすかを score 化する
```

つまり `Phase 4.1` は新しい brain ではない。  
**brain 間の信号整理レイヤー** である。

---

## 実装方針

## 1. usefulness posterior は「補正」であって主役にしない

Recall の主役は常に `semanticScore`。  
`usefulnessPosteriorMean` は「その候補は過去に効いた」を足す補正で止める。

基本方針:

- `semantic` を最大ウェイト
- `usefulness` は中小ウェイト
- `surprise` は小ウェイト
- `exploration` は微小ウェイト
- `replay-state` は tiny tie-breaker

### 推奨ガード

- semantic floor を設ける  
  `semanticScore` が一定未満なら、`usefulness` や `dueBoost` で無理に押し上げない
- usefulness contribution clamp を設ける  
  contribution が semantic を追い越さないようにする
- replay-state boost clamp を設ける  
  `due_at / retrievability / stability` は最終順位を少し動かすだけにする

---

## 2. replay state は recall では「育成優先の補助 signal」に限定する

`Phase 3.1` から来る `due_at / retrievability / stability` は有益だが、
Recall で強く効かせると query relevance が壊れる。

したがってルールはこれで固定する。

- `semanticScore` が十分高い候補にだけ適用する
- 主効果ではなく tie-breaker にする
- due だから上げる、ではなく「近い候補の中で少し優先する」に留める

これで、

- replay は育成
- recall は検索

という責務分離が保てる。

---

## 3. `topics` は hard failure を起こさない

`topics` は recall の質を上げるが、未 backfill や表記揺れの期間は薄い。

`Phase 4.1` ではこの運用ルールを固定する。

- `ep-recall`: `strictTopics=true` を許す
- `assemble()` / 自動 recall: `strictTopics=false` を基本にする
- strict hit 0 の時は vector-only fallback を既定にする

これで「topics を入れた結果 recall が空になる」を避ける。

---

## 4. `importance_score` 用 telemetry を Phase 4.1 から収集する

`Phase 5` でも観測整理は続ける。  
ただし `Phase 4.1` では recall 重み調整に直結する観測を先に揃える。

### 先に残すべき観測

- `episode_id`
- `semantic_score`
- `freshness_score`
- `surprise_score`
- `usefulness_score`
- `exploration_score`
- `replay_tiebreak_score`
- `topics_match_count`
- `topics_mode` (`strict` / `soft` / `none`)
- `rank_before`
- `rank_after`
- `shown`
- `expanded`
- `used`

### 理由

これがあると後で、

- usefulness が強すぎたか
- replay boost が効きすぎたか
- topics strict が recall を殺したか
- よく出るが使われない memory は何か

を見返せる。

### calibration 期間のガード

`Phase 4.1` の telemetry は **観測専用** として扱う。  
ここで集めた `shown / used / expanded` や rank 変化は、重みの初期調整には使うが、同じ実行中に `importance_score` の学習ラベルへ直接流し込まない。

守ること:

- live recall の副作用と calibration の学習材料を混ぜない
- `RecordRecall()` で増える `Retrievals` は運用メトリクスとして扱い、calibration の正解ラベルには使わない
- `RecordHit()` は明示的な `ep-expand` などの強いシグナルだけに限定して解釈する

この線引きがないと、観測するたびに posterior が動いて、重みの比較が自己汚染される。

## 5. API 契約を固定する

`Phase 4.1` の一番の事故は、score breakdown の形が呼び出し元ごとにバラけること。  
なので `ai.recall` の戻り値は、既存の `ScoredEpisode` を拡張して統一する。

### recall result contract

各 result に次を載せる。

- `Score`
- `SemanticScore`
- `FreshnessScore`
- `SurpriseScore`
- `UsefulnessScore`
- `ExplorationScore`
- `ReplayTieBreakScore`
- `TopicsMode`
- `TopicsState`
- `TopicsMatchCount`
- `CandidateRank`
- `Rank`

### topics state contract

`TopicsState` は 4 値で扱う。

- `none`: recall 側で topics filter を使っていない
- `matched`: record の topics が query topics に一致した
- `mismatch`: topics はあるが一致しなかった
- `missing`: record 側に topics がなく、legacy fallback も空だった

`mismatch` と `missing` を同じ penalty にしない。  
ここを混ぜると、backfill 済みの記憶と legacy の記憶が同じように沈む。

### recall telemetry contract

`ai.recallFeedback` は telemetry-only に固定する。

- `shown`: recall response に出た episode ids
- `used`: 実際に会話の中で参照された episode ids
- `expanded`: `ep-expand` などで明示的に掘られた episode ids

返却値は `updated / skipped` で統一する。  
`stored / duplicates` のような別名は使わない。

## 6. 設定注入経路を固定する

TS 側の tuning 値は JSON object のまま Go 側へ送る。  
`config.ts` だけで終わらせず、`rpcClient.recall()` の params に calibration を載せる。

### 注入経路

```text
src/config.ts
  -> buildRecallCalibration(cfg)
  -> src/index.ts / src/retriever.ts
  -> rpcClient.recall(..., calibration)
  -> go/main.go handleRecall
  -> vector.Store.RecallWithTopicsMode(...)
```

### 対象 knobs

- `recallSemanticFloor`
- `recallUsefulnessClamp`
- `recallReplayTieBreakMaxBoost`
- `recallReplayLowRetrievabilityBonus`
- `recallTopicsMatchBoost`
- `recallTopicsMismatchPenalty`
- `recallTopicsMissingPenalty`

### 運用ルール

- `semanticFloor` は replay-state の補助 boost を止めるための guard
- `topicsMismatchPenalty` は topics が存在するが一致しない時だけ使う
- `topicsMissingPenalty` は legacy / backfill 途中の episode を不当に沈めないため、既定値は 0
- `usefulnessClamp` は usefulness を主役にしないための上限

これで「config を足したが Go rerank に届いていない」という事故を防ぐ。

---

## 実装ステップ

## Step 1: recall score contract を固定する

対象:

- `go/internal/vector/store.go`
- `go/main.go`
- `src/retriever.ts`
- `src/rpc-client.ts`

やること:

1. score breakdown の field 名を固定
2. usefulness / replay boost の clamp を定数化
3. `strictTopics` / fallback 挙動をコメントと docs に揃える

完了条件:

- 読み手が score 合成を 1 回で追える
- replay boost の効く条件がコード上で明確

## Step 2: tuning knobs を config に追加する

追加候補:

- `recallUsefulnessClamp`
- `recallReplayTieBreakMaxBoost`
- `recallReplayLowRetrievabilityBonus`
- `recallSemanticFloor`
- `recallTopicsMatchBoost`
- `recallTopicsMismatchPenalty`
- `recallTopicsMissingPenalty`

完了条件:

- 重み変更がコード改変なしでできる
- workspace / agent 単位で後から寄せやすい

## Step 3: calibration telemetry を追加する

やること:

1. rerank 前後の順位を残す
2. score breakdown を structured log 化する
3. `ai.recallFeedback` の `shown / used / expanded` と join しやすい key を揃える

完了条件:

- usefulness tuning を後追い検証できる
- `v0.2.1` の importance score 学習材料になる

## Step 4: validation scenario を固定する

最低限の検証ケース:

1. semantic は高いが usefulness は低い
2. usefulness は高いが semantic は弱い
3. replay due だが query relevance は低い
4. strict topics hit 0
5. soft topics は一致するが vector 上位とズレる
 6. legacy episode で topics が欠損している

### 判定基準

- `same-query stability`: 同一 query を短時間で再実行した時、上位候補が大きく揺れない
- `top1 semantic floor violation count`: semantic floor 未満の候補が 1 位に来る回数が 0 である
- `strict hit0 fallback rate`: strict topics が 0 件の時に vector-only fallback が正しく発火する
- `rollback trigger`: 上位 5 件のうち semantic 低下が 2 件以上連続したら、calibration knob を即ロールバックする

完了条件:

- 重み変更で悪化した時に、どこで壊れたか追える

### telemetry retention

Recall の breakdown は hot path の副産物なので、永続保存はしない。  
保存方針は次のいずれかに限定する。

- structured log にのみ残す
- 低頻度 sampling をかけて残す
- 期間限定の debug dump に落とす

少なくとも Phase 4.1 では、`topK x every recall` を Pebble に丸ごと保存しない。

---

## 成功条件

- usefulness を少し上げても unrelated memory が上に来ない
- replay due episode が recall を乗っ取らない
- `topics` 指定がある時も recall 空振りが増えない
- score breakdown を見て順位変動の理由が追える
- API 呼び出し数は増えない

---

## Phase 5 と v0.2.1 への接続

### Phase 5 への影響

良い影響がある。

- telemetry 命名が先に揃う
- release note に「Phase 4.1 で recall calibration を追加」と書ける
- observability と rebuild/recovery の整理がしやすくなる

### v0.2.1 への影響

ここが本命。

`Phase 4.1` を入れておくと、次の `importance_score` は

- 勘の重み
- いきなりの新規 score

ではなく、

- 既存 recall telemetry
- replay telemetry
- D1 coverage / reuse history

を土台にした導入にできる。

つまり `hippocampus_replay_importance_note.md` の内容を、
突然大きく入れるのではなく、**観測ベースで安全に昇格**できる。

---

## 最終判断

`Phase 4.1` は差し込んだ方がいい。

ただし名前の通り、ここは

- recall を壊さない
- replay と喧嘩させない
- 次の importance policy に備える

ための **calibration & bridge phase** として扱うのがちょうどいい。

この切り方なら `v0.2.0` のスコープを爆発させずに、
実装の手触りも、次の `v0.2.1` の伸びしろも両方守れる。

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Pre-Implementation  
> Prior audits: 0 | New findings this round: 5

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| なし | 初回監査 |

### ⚠️ Impact on Related Features *(new only)*
- `Phase 4.1` は `go/internal/vector/store.go` の hot path である `RecallWithTopicsMode()` と、`go/main.go` の `handleRecall` / `handleRecallFeedback`、`src/retriever.ts` の `assemble` telemetry にまたがる。ここで score breakdown の schema を曖昧にしたまま進めると、Go 側の rank 調整と TS 側の telemetry が別々の定義で走り、後から重みの検証ができない。
- plan では tuning knobs を config 化すると書いているが、現状の recall weight は Go 側の `defaultRecallWeights` 定数で固定されている。設定の注入経路を決めないと、TS config を変えても Go rerank に届かず「設定したつもりで効かない」状態になる。

### 🚨 Potential Problems & Risks *(new only)*
- **BLOCKER**: score breakdown と telemetry の API 契約が未定義。plan は `semantic_score / usefulness_score / rank_before / rank_after` を残すと書いているが、現状 `ScoredEpisode` は `Score` しか返さず、`ai.recallFeedback` も per-candidate breakdown を受け取らない。このままだと Step 3 は実装者ごとの解釈で分岐し、観測が比較不能になる。
- **HIGH**: tuning knob の所有者と注入経路が未定義。Recall の本体は Go 側で実行されるのに、plan には「config に追加する」までしかなく、`ai.recall` params に載せるのか、store meta に保存するのか、Go の起動時 config にするのかが書かれていない。ここを決めないと per-workspace / per-agent 調整は成立しない。
- **HIGH**: `topics` soft mode の down-rank が legacy / unbackfilled data を系統的に不利にするリスクが plan 上で未処理。現実の store には `topics` が薄い期間が残るので、soft penalty を一律で掛けると「意味的に近いが topics 未充足の episode」が calibration 中だけ不当に沈む可能性がある。

### 📋 Missing Steps & Considerations *(new only)*
- validation scenario は列挙されているが、合格基準がない。少なくとも `same-query stability`、`top1 semantic floor violation count`、`strict hit0 fallback rate` のような観測指標と、悪化時に revert する基準を置くべき。
- telemetry をどこへ保存するかの retention 方針がない。Recall は hot path なので、`topK x every recall` の breakdown を Pebble に永続化するのか、structured log のみにするのか、sampling するのかを先に固定しないと Phase 4.1 自身が I/O ノイズ源になる。

### 🕳️ Unaddressed Edge Cases *(new only)*
- `RecordRecall()` が rerank 後に即 `Retrievals++` する現行設計のまま Phase 4.1 を入れると、重みの A/B 的な比較が「計測するたびに posterior を動かす」自己汚染になる。calibration 期間中に posterior 更新をそのまま使うのか、観測専用モードを設けるのかが未定義。
- plan は `workspace / agent 単位で後から寄せやすい` と書いているが、現状の recall API は `agentId` を受け取らず `agentWs` ベースで store を引く。agent-level tuning を本当にやるなら scope を workspace に落とすか、新しい識別子を足す必要がある。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| BLOCKER | `ScoredEpisode` 返却値または別 telemetry payload に、component score / topic mode / rank transition をどう載せるかの API 契約を plan に明記する | Step 3 の観測が実装者依存になるのを防ぐため | ✅ New |
| HIGH | tuning knobs の注入経路を 1 つに固定する（例: Go 側 config struct + `ai.recall` optional params + safe defaults） | TS と Go で設定が分離して効かない事故を防ぐため | ✅ New |
| HIGH | `topics` soft mode は「topics 不一致 penalty」と「topics 欠損 penalty」を分けるか、欠損 episode には penalty を掛けない方針を明記する | backfill 途中の legacy episode を不当に沈めないため | ✅ New |
| MED | calibration 期間の成功指標と rollback 条件を数値で追加する | 重み調整が悪化した時に止められるようにするため | ✅ New |
| MED | telemetry の保存先・保持期間・sampling 方針を明記する | hot path の I/O 増加を制御するため | ✅ New |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Post-Implementation  
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| BLOCKER: score breakdown and telemetry API contract undefined | ✅ Resolved |
| HIGH: tuning knob ownership/injection path undefined | ✅ Resolved |
| HIGH: topics soft mode down-rank could unfairly penalize legacy/unbackfilled data | ✅ Resolved |
| MED: validation scenario lacked acceptance criteria | ✅ Resolved |
| MED: telemetry retention / sampling was undefined | ✅ Resolved |

✅ No new critical issues found. Document has converged.
