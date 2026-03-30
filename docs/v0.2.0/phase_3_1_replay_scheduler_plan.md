# Phase 3.1: Replay Scheduler & Collection Efficiency Plan

更新日: 2026-03-30

## 結論

`collectActiveD0Nodes()` の carry-over は、Phase 4 の直前に `Phase 3.1` として切るのがかなり良い。

理由は 2 つある。

- これは recall の「賢さ」より前にやるべき、基礎コストと replay 基盤の整備だから
- API 呼び出しを最小化したいなら、先に「何を再活性化すべきか」をローカルで決められるようにした方が効くから

ただし、ここで入れるべきなのは **FSRS のフル移植** ではない。

Phase 3.1 の主役は次の 2 本に絞る。

- `collection efficiency`
- `local replay scheduling`

FSRS はそのままコピーするより、`stability / retrievability / due scheduling` の考え方を D1 memory に合わせて借りる方が筋が良い。

---

## まず答え

### 1. `Phase 3.1` を Phase 4 の前に入れるべきか

はい。かなり自然。

順番としてはこうする。

1. Phase 3: D1 consolidation を人間っぽくする
2. Phase 3.1: replay 対象の選別と due scheduling をローカルで賢くする
3. Phase 4: recall rerank と topics-aware retrieval を仕上げる

この順だと、

- Phase 3 が「何を記憶の単位として残すか」
- Phase 3.1 が「どの記憶をいつ再活性化するか」
- Phase 4 が「必要な時にどう引くか」

できれいに役割分担できる。

### 2. FSRS を使うべきか

**そのまま full adoption はまだ早い。**

でも、

- `stability`
- `retrievability`
- `desired retention`
- `due_at`

の設計思想は、Episodic-Claw にかなり相性がいい。

結論としては:

- **FSRS-inspired は賛成**
- **raw D0 全件へ FSRS をそのまま適用するのは反対**
- **まず D1 と high-salience D0 に限定した lightweight replay scheduler として入れるのが最適**

---

## なぜ Phase 3.1 が要るか

現状の carry-over は一見ただの性能問題に見えるけど、実は Phase 4 の効率にも直結している。

### 現在の問題

- `collectActiveD0Nodes()` が Pebble を全走査してから最後に 200 件へ絞る
- どの memory を再活性化すべきかの local policy がない
- replay の順番がまだ「重要度っぽい heuristic」に留まっている
- recall 側に行く前に、定着させる記憶の優先順位が未整理

### 何が起きるか

- episode が増えるほど consolidation の開始コストが増える
- API を使わなくていい局面でも、どれを触るべきか曖昧
- D1 は作れても「忘れにくく育てる」レイヤーがまだ薄い

つまりこれは単なる micro optimization ではなく、

- `memory lifecycle`

の欠けている 1 ピース。

---

## FSRS から借りるべきもの

Anki/FSRS の一次情報を見ると、FSRS の核は「カードをいつ見せるか」ではなく、

- `difficulty`
- `stability`
- `retrievability`

で記憶状態を持ち、`desired retention` に応じて next review を決める点にある。

参考:

- Anki Manual: [Deck Options - FSRS](https://docs.ankiweb.net/deck-options)
- Anki FAQ: [Frequently asked questions about FSRS](https://faqs.ankiweb.net/frequently-asked-questions-about-fsrs.html)
- FSRS Algorithm Wiki: [The Algorithm](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm)
- Open Spaced Repetition README: [free-spaced-repetition-scheduler](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)
- Go implementation: [go-fsrs](https://github.com/open-spaced-repetition/go-fsrs)

特に重要なのはこの 4 点。

1. FSRS は replay 順序を `retrievability` ベースで決められる
2. `desired retention` を上げると workload が急増する
3. optimizer は review history がたまってから回すべき
4. scheduler 自体は local に動く

Episodic-Claw で欲しいのも、まさにここ。

---

## ただし FSRS をそのまま入れない理由

FSRS はもともと flashcard 前提なので、Episodic-Claw にそのまま載せるとズレる。

### ズレ 1: raw D0 は card ではない

raw D0 は、

- 曖昧
- 長さが不均一
- 複合イベント
- 単発ノイズを含む

ので、flashcard みたいに「1 item = 1 fact」とは言えない。

### ズレ 2: explicit grade がない

FSRS は本来 `Again / Hard / Good / Easy` の評価を前提にする。

Episodic-Claw は今のところ、

- その memory が retrieval に使われたか
- expand されたか
- manual save されたか
- 後続で役に立ったか

くらいしか直接は持っていない。

### ズレ 3: API を増やすと本末転倒

FSRS っぽい state を更新するために、毎回 LLM へ「覚えてるか判定」を聞きにいくと逆効果。

だから Phase 3.1 では、

- **state update は local signal 中心**
- **LLM を使う active rehearsal は budget 付き**

が必須。

---

## 推奨方針

## 方針 1: FSRS-inspired, not FSRS-complete

Phase 3.1 は full optimizer までやらない。

やるのは:

- memory state を持つ
- due scheduling を持つ
- replay budget を持つ
- local signal で更新する

やらないのは:

- review history 全体からの parameter fitting
- deck ごとの optimizer
- raw D0 全件への aggressive scheduling

## 方針 2: Phase 3.1 の対象は D1 優先

最初に対象にするのは次。

- D1
- `manual-save` D0
- `high-salience singleton` D0

後回しにするもの:

- 低 salience の raw D0 全件
- archived だが使われていない大量 D0

これで API と state の爆発を防ぐ。

## 方針 3: replay は「選ぶ」と「実行する」を分ける

まず local scheduler が、

- due
- retrievability
- salience
- usefulness

から replay 候補を選ぶ。

その後で、予算がある時だけ実行する。

これで「全件に API を打たない」が守れる。

---

## Phase 3.1 の設計

## 3.1-A Collection Efficiency

まず carry-over を潰す。

### 目的

- `collectActiveD0Nodes()` の全走査をやめる
- consolidation の開始コストを一定に近づける

### 実装案

- active D0 用の軽量 index を Pebble meta か別 keyspace で持つ
- 少なくとも `timestamp` 順に新しいものから辿れるようにする
- `maxActiveD0` と `maxWindowHours` を満たした時点で早期停止する

### index maintenance

index を足すなら、ここも最初から決めておく。

- D0 追加時に index へ追加
- `archived` / `consolidation-failed` / `consolidation-skip` 付与時に index から除外
- delete 時に index から除外
- drift を疑った時は full rebuild できるようにする

少なくとも、`rebuildActiveD0Index()` 相当の回復手順は Phase 3.1a に含める。

### 最低ライン

Phase 3.1 では full secondary index が重ければ、

- `createdAt desc` 相当で辿れる key

だけでもかなり効く。

---

## 3.1-B Replay State

各 memory に次の state を持つ。

```go
type ReplayState struct {
    Stability       float64
    Retrievability  float64
    Difficulty      float64
    DesiredRetention float64
    DueAt           time.Time
    LastReviewedAt  time.Time
    ReviewCount     int
    Lapses          int
}
```

Phase 3.1 では `Difficulty` を弱く扱ってよい。

実質的に重視するのは:

- `Stability`
- `Retrievability`
- `DueAt`

### 永続化方針

`ReplayState` は `EpisodeRecord` に直埋めしない。

理由:

- recall / replay ごとに state 更新頻度が高い
- `EpisodeRecord` 本体へ毎回書くと write amplification が起きやすい
- Phase 4 の `usefulness posterior` と責務が混ざりやすい

Phase 3.1 の前提はこれで固定する。

- `EpisodeRecord` は episode 本体
- `ReplayState` は別 keyspace の薄い state
- key 例: `replay:<workspace>:<episode-id>`

必要なら追加で持つ。

```go
type ReplayLease struct {
    Holder     string
    AcquiredAt time.Time
    ExpiresAt  time.Time
}
```

### state lifecycle / GC

`ReplayState` は作るだけでは足りない。消し方と引き継ぎ方も固定する。

- episode delete 時は `ReplayState` も削除
- `consolidation-failed` / `consolidation-skip` で replay 対象から外した episode は state も inactive 化する
- D0 が D1 へ昇格して canonical parent ができた時は、child D0 の state を parent D1 へ寄せるか、child 側を tombstone 化する
- D1 の再統合や slug 変更が起きても `episode-id` を canonical identity にして state continuity を壊さない

要するに、scheduler は `slug` ではなく **stable episode identity** を見る。

### class-specific cold start

初期値を全部同じにすると、D1 と `manual-save` と singleton の性格差が消える。

そのため v0.2.0 では class ごとの弱い prior を持つ。

- D1: 標準の初期 `Stability`
- `manual-save` D0: D1 より少し高い `DesiredRetention` または短い初回 `DueAt`
- `high-salience singleton` D0: D1 より短い初回 `DueAt`

ここは optimizer をまだ入れないので、固定値でよい。

---

## 3.1-C Implicit Grade Mapping

explicit な `Again/Hard/Good/Easy` がないので、まずは noisy でも deterministic な写像を作る。

### 初期版

- `Again`
  - 前回 `Good` または `ExpandedGood` と見なした memory が短時間で再検索を誘発し、同一 query family で役に立たなかった
- `Good`
  - recall 上位に入り、実際に prompt へ使われた
  - expand されて必要な child へ到達できた
- `Easy`
  - manual save / repeated successful reuse / strong positive signal

### ただし Phase 3.1 の推奨

最初は **2-grade 運用** に寄せる。

- `Again`
- `Good`

Anki FAQ でも `Again` と `Good` 中心でも成立しうるとされていて、こちらの方がノイズを減らしやすい。

ただし内部イベントは 2 値より少しだけ細かく持つ。

- `DirectGood`
- `ExpandedGood`
- `Miss`
- `NoReview`

scheduler へ反映する時だけ `Good` / `Again` 相当へ射影する。

- `DirectGood` -> `Good`
- `ExpandedGood` -> `Good` だが stability の増分は弱める
- `Miss` -> `Again`
- `NoReview` -> state 変更なし

これで「expand は成功だが、直引きよりは弱い」を表現できる。

### update trigger の source of truth

ここは曖昧にしない。

Phase 3.1 では次を観測イベントに固定する。

- `Good`
  - recall 返却後、その episode / D1 が実際に prompt assembly へ採用された
  - `ep-expand` で明示的に掘られた
- `Again`
  - 同一 topic / query family で短時間に再検索が必要になり、前回採用した candidate が役立たなかった

ここで大事なのは、**prompt assembly へ採用されなかっただけでは `Again` にしない** こと。

非採用には、

- token budget が足りない
- もっと強い candidate がいた
- その turn では別の topic が優先された

みたいな無関係な理由が混ざる。

そのため Phase 3.1 では「非採用」は原則 `NoReview` 扱いに寄せる。

最初は「ユーザーの最終満足度」ではなく、**sidecar と plugin が直接観測できるイベントだけ** を source of truth にする。

### observation contract

この source of truth は、TS plugin と Go sidecar の境界をまたぐので event 契約を決めておく。

```go
type ReplayObservation struct {
    ObservationID string
    WorkspaceID   string
    EpisodeID     string
    QueryFamilyID string
    Outcome       string // DirectGood | ExpandedGood | Miss | NoReview
    OccurredAt    time.Time
    Source        string // recall-assembly | ep-expand | replay-worker
}
```

最低限必要なのは次。

- `ObservationID` で idempotent apply
- `OccurredAt` で out-of-order event を弱く吸収
- `QueryFamilyID` で「同じ話題で取り直しになった」を判定

Phase 3.1b の完了条件には、**sidecar が observation を重複適用しない** ことを入れる。

---

## 3.1-D Replay Execution Budget

API 最小化の肝はここ。

### Local-first ルール

- due 判定
- replay priority 計算
- state 更新

は全部 local でやる。

### API を使ってよい場面

- top `K` 件の due memory だけを active rehearsal に回す
- idle / sleep consolidation 時だけ回す
- 1 run あたり budget を固定する
- 同一 memory には lease が取れた時だけ実行する

例:

- `maxReplayCandidatesPerRun = 5`
- `maxReplayLLMCallsPerRun = 2`
- `replayLeaseTTL = 10m`

### cheap replay

LLM を呼ばず、

- retrieval hit
- expand
- manual save
- repeated recurrence

から state を更新するだけの軽量モードを用意する。

これが本命。

### in-flight / lease ルール

ここは BLOCKER になりやすいので、初手で固定する。

- replay 実行前に `ReplayLease` を取る
- lease が生きている間は同一 memory を再実行しない
- 成功 / 失敗時に lease を解放する
- process crash 時は `ExpiresAt` で自然回復させる

これで background job の重複実行と API の二重消費を防ぐ。

### starvation 回避

due item だけで queue を埋めると、新しく重要化した memory が飢餓を起こしやすい。

そのため、Phase 3.1 では次を入れる。

- `noveltySlotCount >= 1`
- または `maxDueAge` を超えた item を切り捨てず round-robin で混ぜる

これで due backlog が重くても、新規重要 memory が queue に入れる。

---

## 3.1-E What to Replay

優先順位はこうするのが自然。

1. due な D1
2. due な `manual-save` D0
3. due な `high-salience singleton` D0
4. 直近で usefulness が高かった memory

raw D0 全件 replay はやらない。

理由:

- API が増える
- state が荒れる
- episodic noise を強化しやすい

### D1 と child D0 の二重 replay を避ける

D1 優先方針なら、child D0 は無条件に残さない。

ルール:

- 有効な parent D1 がある child D0 は replay 対象から原則除外
- 例外は `manual-save` または `high-salience singleton` で、D1 に吸収しきれない価値があるものだけ

これで D1 と child D0 を同時に再活性化して API を無駄にするのを防ぐ。

---

## 3.1-F How FSRS Maps to Episodic-Claw

### そのまま使えるもの

- forgetting curve 的な due scheduling
- item ごとの memory state
- desired retention と workload のトレードオフ
- local scheduler

### 変換が必要なもの

- explicit rating
- card-like atomicity
- optimizer 前提の parameter fit

### 変換方針

- explicit rating -> implicit grade mapping
- card -> D1 / selected D0
- optimizer -> 初期は固定 parameter

---

## API 最小化の観点から見た意見

ここはかなり大事。

### 良い案

- FSRS-inspired local scheduler で replay 対象を絞る
- replay 実行は budget 付き
- due になっても必ずしも LLM を呼ばない
- D1 優先で raw D0 を増やしすぎない

### 良くない案

- raw D0 全件へ FSRS state を持たせる
- state 更新のたびに LLM 判定を入れる
- optimizer を早期導入する
- replay と recall rerank を同時に重くする

要するに、API を減らしたいなら

- **FSRS を scoring brain にする**
- **LLM を executor にしすぎない**

のが正解。

---

## 実装フェーズ

### 実装状況

- ✅ Phase 3.1a: `Store.SnapshotActiveD0Records()` と active D0 index を追加し、`collectActiveD0Nodes()` の主経路を全走査から切り替えた
- ✅ Phase 3.1b: `ReplayState` / `ReplayObservation` / `ReplayLease` を別 keyspace で永続化し、`handleExpand()` からの Good 観測を入れられるようにした
- ✅ Phase 3.1c: due candidate 選別、lease/in-flight 制御、background replay scheduler、`ai.replay` 手動トリガを入れた

### 実装メモ

- `ReplayState` の canonicality は `PromoteReplayStateToParent()` で D0 -> D1 昇格時に寄せる
- replay は `D1`、`manual-save`、`high-salience singleton` を優先し、低優先 D0 は scheduler から外す
- replay 失敗時は `Again`、成功時は `ExpandedGood` として state を更新する
- `applyReplayObservation` は idempotent で、重複イベントを二重適用しない

## Phase 3.1a

やること:

1. `collectActiveD0Nodes()` の全走査改善
2. active D0 収集の早期停止
3. observability 追加
4. active D0 index の rebuild / drift recovery

完了条件:

- active D0 収集時間がデータ総量に比例しにくくなる
- `maxActiveD0` 到達で早く止まる
- index drift 時に rebuild で回復できる

## Phase 3.1b

やること:

1. `ReplayState` スキーマ追加
2. due scheduling
3. implicit `Again/Good` 運用
4. local-only state update
5. separate keyspace と update trigger 契約

完了条件:

- memory ごとに `due_at` を持てる
- LLM なしで replay queue が作れる
- state 更新が観測可能イベントだけで決まる
- duplicate / retry observation で state が二重更新されない

## Phase 3.1c

やること:

1. budgeted active rehearsal
2. D1 優先 replay
3. monitoring
4. lease / in-flight 制御
5. starvation 防止

完了条件:

- 1 run あたりの API 上限が守られる
- replay が D1 quality と recall quality の両方に効く
- 同一 memory の二重実行が起きにくい

---

## v0.2.0 に入れるべき範囲

入れていい。

ただし範囲は絞る。

### v0.2.0 に入れる

- `collectActiveD0Nodes()` 最適化
- local replay state
- D1 優先 due scheduling
- implicit `Again/Good`
- budgeted replay

### v0.2.0 に入れない

- optimizer による personal parameter fitting
- deck/preset 相当の多系統 scheduler
- raw D0 全件への本格 FSRS
- `Hard/Easy` まで含む複雑 grade mapping

---

## Phase 4 / 5 への影響

## Phase 4 への影響

影響は **あり**。しかも比較的強い。

ただし、Phase 4 を壊す種類の影響ではない。  
主に「前提を良くする」影響。

### 何が変わるか

- rerank 候補に `due_at` / `retrievability` / `stability` を feature として入れられる
- `usefulness posterior` と replay state を分離して持つ必要が出る
- exploration の掛け方を弱めやすくなる
- recall が「近い記憶を引く」だけでなく「忘れそうだが重要な記憶を拾う」方向へ広がる

### 影響の整理

- `semanticScore` はそのまま必要
- `freshnessScore` もそのまま必要
- `usefulnessPosterior` もそのまま必要
- 追加で `retrievabilityPenalty` または `dueBoost` を入れる余地ができる

### 注意点

Phase 3.1 と Phase 4 の両方で exploration を強く掛けると二重カウントになりやすい。  
そのため、Phase 4 実装時は次のどちらかへ寄せるのがよい。

- Phase 3.1 で replay exploration、Phase 4 で retrieval exploitation を主にする
- もしくは Phase 4 では exploration weight をかなり小さくする

要するに、Phase 4 は再設計不要だが、**feature 設計と weight の置き方は Phase 3.1 前提で少し見直すべき**。

## Phase 5 への影響

影響は **あり**。ただし中くらい。

### 何が増えるか

- config 項目が増える
- `ReplayState` の migration / rebuild 手順が増える
- observability 項目が増える
- release note で説明すべき変更点が増える

### 追加で整理が必要なもの

- `desiredRetention`
- replay budget
- due scheduling の既定値
- active D0 index の rebuild 手順
- replay state を壊した時の回復手順

### 結論

Phase 5 の目的自体は変わらない。  
ただし polish 範囲が増えるので、Phase 3.1 を入れるなら Phase 5 の checklist は明示的に増やした方が安全。

---

## 最終判断

`Phase 3.1` は入れた方がいい。

しかもこれは Phase 4 の後ではなく、**Phase 4 の前** が正しい。

理由は、Phase 4 が「必要な時に何を引くか」の層で、Phase 3.1 は「何を定着させ、いつ再活性化するか」の層だから。

そして FSRS についての結論はこれ。

- Anki/FSRS の思想はかなり使える
- でも raw episodic memory に full transplant するのはまだ危ない
- `FSRS-inspired replay scheduler for D1-first memory` として入れるのが、精度と効率のバランスが一番いい

この形なら、

- API 呼び出しを最小限にできる
- carry-over の性能問題も一緒に潰せる
- Phase 4 の recall をより意味のある memory に寄せられる

かなり良い中継フェーズになる。

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
- **Replay state の置き場が未確定で、Phase 4 / Phase 5 へ直接波及する**: 文書は `ReplayState` を追加すると書いているが、`EpisodeRecord` に埋めるのか、別 keyspace に分けるのか、更新頻度の高い state をどこに持つかが未記載。この判断を曖昧にしたまま進めると、Phase 4 の usefulness posterior と設計が衝突しやすい。
- **active D0 index が drift すると Consolidation の前提が壊れる**: `collectActiveD0Nodes()` 最適化のために index を足す方針は正しいが、archive / quarantine / delete / rebuild 時の追随手順がない。ここがずれると Phase 3 の D1 consolidation 自体が古い/無効な D0 を拾う。

### 🚨 Potential Problems & Risks *(new only)*
- **BLOCKER: replay 実行の lease / in-flight 制御がない**: due 判定と budgeted active rehearsal を入れるのに、同一 memory を同一 run あるいは並行 run で二重実行しない仕組みが書かれていない。sidecar の background job が重なると API budget を平気で二重消費する。
- **HIGH: implicit `Again/Good` の更新トリガが観測不能なまま**: 「候補に出たのに使われなかった」「prompt へ使われた」などの signal を使う方針自体は良いが、どこでそれを観測し、どのイベントを source of truth にするかが未定義。ここが曖昧だと state がノイズで壊れる。

### 📋 Missing Steps & Considerations *(new only)*
- **ReplayState の永続化戦略と key design がない**: 最低限、`state:<episode-id>` なのか `state:<workspace>:<episode-id>` なのか、batch flush するのか、crash recovery はどうするのかを書く必要がある。`EpisodeRecord` 直更新だと write amplification も起きやすい。
- **新規 memory の admission policy がない**: due scheduling を入れるなら、「新しく生成された D1 を最初にいつ review queue に入れるか」が必要。ここがないと、新規 D1 が scheduler 上で放置されるか、逆に初期過密レビューになる。

### 🕳️ Unaddressed Edge Cases *(new only)*
- **budget が小さい時の starvation**: `maxReplayCandidatesPerRun` と `maxReplayLLMCallsPerRun` を厳しくすると、常に古い due item だけが処理され、新しく重要になった memory が queue に入れず飢餓を起こす可能性がある。novelty slot か age cap が必要。
- **archive 済み D0 と D1-first scheduler の二重管理**: D1 優先方針でも `manual-save` / `high-salience singleton` D0 を replay 対象に残すなら、D1 に統合済み child D0 をどう扱うかの除外規則が要る。ないと同じ内容を D1 と child D0 の両方で再活性化しやすい。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| BLOCKER | replay 実行に `lease / in-flight marker / cooldown` のいずれかを追加し、同一 memory の二重実行を防ぐ | API budget の重複消費と state の二重更新を防ぐ | ✅ New |
| HIGH | implicit `Again/Good` の update trigger を API 契約レベルで固定する | 観測不能な signal で state が壊れるのを防ぐ | ✅ New |
| HIGH | ReplayState は `EpisodeRecord` と分離した keyspace に置く方針を明記する | write amplification と Phase 4 usefulness state との衝突を避ける | ✅ New |
| MED | active D0 index の maintenance / rebuild / drift recovery 手順を書く | archive / quarantine 後に古い D0 を拾う事故を防ぐ | ✅ New |
| MED | new-memory admission policy と starvation 防止策を追加する | due queue が新規重要 memory を殺すのを防ぐ | ✅ New |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Pre-Implementation  
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| Replay state の置き場未確定 | ✅ Resolved |
| active D0 index の drift / rebuild 手順不足 | ✅ Resolved |
| replay 実行の lease / in-flight 制御不足 | ✅ Resolved |
| implicit `Again/Good` の update trigger 不明確 | ✅ Resolved |
| new-memory admission / starvation / child D0 二重 replay | ✅ Resolved |

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
| LOW | 実装時は `ReplayObservation` の idempotency と `episode-id` の canonicality を先にテストで固定する | ここは plan 上は収束したが、実装で崩れやすい | 🔁 Carry-over |

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Post-Implementation  
> Prior audits: 2 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| ReplayObservation の idempotency / episode-id canonicality のテスト固定 | ⚠️ Still open |

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
| LOW | `ReplayObservation` の idempotency と `episode-id` の canonicality を先にテストで固定する | plan 上は収束したが、実装で崩れやすい | 🔁 Carry-over |
