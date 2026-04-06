# Bayesianスコア動的チューニング実装プラン

更新日: 2026-03-30

## 目的

Episodic-Claw の「Bayesian Surprise / recall score」を、固定値ベースの素朴な判定から、会話ごと・エージェントごとに追従する動的チューニングへ進める。狙いは2つ。

1. 境界判定の精度を上げる  
2. recall の無駄打ちを減らしつつ、当たりエピソードを上に出す

この文書は、現在実装の確認と外部リサーチを踏まえた、実装寄りの導入計画。

---

## 先に結論

いきなりフルの BOCPD や重い学習器を入れるより、まずは次の二段階がいちばん現実的。

1. `segmenter.ts` の固定しきい値 `0.2` をやめて、`surprise` の事後平均 + 事後分散から動く動的しきい値に置き換える  
2. `store.go` の recall 再ランキングを、`semantic × recency` の固定式から、`semantic + freshness + usefulness posterior + 探索ボーナス` の軽量 Bayesian rerank に広げる

この順番なら、今のアーキテクチャを壊さずに精度改善を狙える。しかも追加コストはかなり小さい。

---

## 現在実装の確認

### 1. Surprise は「Bayesian」と呼ばれているが、実体は単発の埋め込み距離

- README では「Bayesian Surprise」と説明されている
- ただし実装は `go/main.go` の `handleSurprise()` で `text1` と `text2` をそれぞれ embed し、`vector.CosineDistance()` をそのまま `surprise` として返している
- つまり今は「事前分布 / 事後分布の更新」も「不確実性」も持っていない

実質的には:

- `surprise = cosine_distance(embed(oldSlice), embed(newSlice))`

です。

### 2. 境界判定は固定しきい値 `0.2`

`src/segmenter.ts` では:

- `private surpriseThreshold = 0.2`
- `surprise > surpriseThreshold` で episode boundary
- 例外として `maxBufferChars` 超過でも強制 flush

問題はここで、会話の密度やドメイン差を一切見ていないこと。

- 雑談中心の会話
- コードレビュー
- ログ解析
- 設計議論

この4つは `surprise` の分布がぜんぶ違うのに、同じ `0.2` を当てている。

### 3. recall score は `semantic × temporal penalty` のみ

`go/internal/vector/store.go` の `Recall()` は、今こうなっている。

- `sim = 1 / (1 + dist)`
- `penalty = min(daysOld / 30 * 0.01, 0.20)`
- `finalScore = sim * (1 - penalty)`

つまり:

- 埋め込み類似度
- ごく弱い recency

しか見ていない。

一方で EpisodeRecord には `Surprise` が保存されているが、recall の再ランキングにはほぼ使われていない。

### 4. 設定面も動的チューニング前提になっていない

`src/config.ts` にあるのは主に:

- `reserveTokens`
- `recentKeep`
- `dedupWindow`
- `maxBufferChars`
- `maxCharsPerChunk`

で、Bayesian系の係数や学習率、探索率、信頼度下限の設定はまだない。

---

## リサーチから引ける設計原則

### 1. 境界判定は「単発 surprise」より「背景に対してどれだけ跳ねたか」が効く

`Bayesian Surprise Predicts Human Event Segmentation in Story Listening` では、単純な surprisal より、分布更新量としての Bayesian surprise の方が event boundary をよく説明している。しかも「背景の低い予測誤差に対して、一時的にどれだけ突出したか」という transient な見方が効いていた。  
参考: [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC11654724/)

ここから引ける実装原則:

- 生の `surprise` だけで切らない
- 直近ランニング分布に対する `z-score` か posterior quantile で切る
- つまり「絶対値」ではなく「その会話での異常度」を見る

### 2. オンライン境界検出は Bayesian changepoint の考え方と相性がいい

`Robust and Scalable Bayesian Online Changepoint Detection` は、オンライン更新を単純な代数操作で回せること、しかも従来手法より高速にできることを示している。  
参考: [arXiv:2302.04759](https://arxiv.org/abs/2302.04759)

ここから引ける実装原則:

- 毎ターン O(1) から O(W) くらいで更新できる形にする
- セグメンテーション用 state は Go sidecar 側のメタに保持する
- いきなり重い全履歴 DP をやらず、truncated run-length か posterior summary に留める

### 3. ranking は「固定 prior」に頼るとズレやすい

`Overcoming Prior Misspecification in Online Learning to Rank` は、Bayesian ranking bandit が prior misspecification に弱く、適応的に prior を直す必要があると示している。  
参考: [arXiv:2301.10651](https://arxiv.org/abs/2301.10651)

ここから引ける実装原則:

- 最初から1つの重み式を正解扱いしない
- global prior と per-agent posterior を分ける
- 後から観測で寄せられる設計にする

### 4. retrieval は「安定して効く例を上げ、ノイズを下げる」方向が強い

`Dynamic Uncertainty Ranking` は、informative で stable な retrieved sample を上げ、misleading なものを下げる動的 ranking threshold を導入している。  
参考: [ACL Anthology / NAACL 2025](https://aclanthology.org/2025.naacl-long.453/)

ここから引ける実装原則:

- recall 候補ごとに usefulness posterior を持つ
- よく効く episode は徐々に上へ
- 何度出しても役に立たない episode は徐々に下へ
- ただし探索枠は少し残す

### 5. 実運用では Thompson Sampling くらいの軽さがちょうどいい

Thompson Sampling 系は、Bayesian に探索と活用を両立しやすく、実装が軽い。Episodic-Claw のようなリアルタイム memory では、この軽さがかなり大きい。  
参考: [An Empirical Evaluation of Thompson Sampling](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/thompson.pdf)

ここから引ける実装原則:

- 重い online learning を毎回回さない
- 3〜5個の scoring profile を arm にしてもいい
- まずは episode 単位の Beta posterior、次に profile 単位の Thompson Sampling で十分

---

## 推奨アーキテクチャ

### 方針A: segmentation を動的しきい値化する

最初の本命はこれ。いちばん効果が出やすい。

#### 提案する score

今の raw surprise をそのまま捨てる必要はない。まずは観測値として使う。

- 観測値: `s_t = cosine_distance(oldSlice, newSlice)`
- state: `mu_t`, `sigma_t^2`, `n_t`
- 判定用: `z_t = (s_t - mu_t) / max(sigma_t, eps)`

境界判定は次のようにする。

- `boundary if z_t > z_cut`
- ただし `minRawSurprise` 未満なら切らない
- `maxBufferChars` 超過の安全弁は残す

#### 事後更新のやり方

精度と実装コストのバランスを考えると、最初は Normal-Inverse-Gamma か、そこまで行かずに empirical Bayes で十分。

保持する値:

- `count`
- `mean`
- `m2` または `variance`
- `lastBoundaryAt`
- `cooldownTurns`

更新ルール:

1. 新しい `s_t` を観測
2. 直近 state を online update
3. `dynamicThreshold = mean + lambda * std`
4. `s_t > dynamicThreshold` なら boundary
5. boundary 後は state を完全リセットではなく shrink する

この shrink が大事。完全初期化すると、boundary 直後に閾値が不安定になる。

#### 実装ポイント

- TS 側でしきい値を持たず、Go 側で `segment score` を返す方が一貫する
- `ai.surprise` を拡張して、返り値を:
  - `rawSurprise`
  - `dynamicThreshold`
  - `zScore`
  - `boundaryProbability` または `shouldBoundary`
  にする
- `src/segmenter.ts` 側は判定ロジックを薄くして、Go 側の結果を使う

#### なぜこれが効率的か

- 追加の埋め込み API は不要
- 毎ターンの計算は定数時間
- session / agent ごとの差を自然に吸収できる

### 方針B: recall を posterior-aware rerank にする

次の本命はこれ。保存した episode を「ちゃんと出す」側。

#### 現在の問題

今の `finalScore = sim * (1 - penalty)` は軽いけど、かなり素朴。

- semantic が強いが、 usefulness を見ない
- `Surprise` を活かせていない
- 毎回似た episode が出やすい
- 本当に効いた episode と、ただ近かっただけの episode が区別できない

#### 推奨する score 分解

まずは topK をいきなり返さず、HNSW から `candidateK = max(20, topK * 4)` を拾って軽く再ランキングする。

各 episode に対して:

- `semanticScore`
- `freshnessScore`
- `surprisePrior`
- `usefulnessPosteriorMean`
- `explorationBonus`

を作る。

最初の式はこれで十分。

```text
final =
  w_sem * semanticScore +
  w_fresh * freshnessScore +
  w_sur * surprisePrior +
  w_use * usefulnessPosteriorMean +
  w_exp * explorationBonus
```

ここで:

- `usefulnessPosteriorMean = (alpha + hits) / (alpha + beta + retrievals)`
- `explorationBonus` は `Beta(alpha, beta)` の sample か、簡易 UCB

#### usefulness の観測信号

ここは欲張ると失敗しやすい。最初は弱くても取れる信号だけでいい。

強い正例:

- `ep-expand` で掘られた
- `ep-recall` の manual query で再度当たった
- 同じ recall 後に追加検索なしで会話が前進した

弱い負例:

- 何度も出るのに即座に別 recall が必要になった
- token budget で毎回末尾に追いやられる

初期案としては:

- `retrievals += 1` は topK 採用時
- `hits += 1` は `ep-expand` / manual `ep-recall` 連動時

これだけでも十分スタートできる。

#### `Surprise` の使い方

保存済みの `Surprise` は recall で補助 prior として使う。

ただし強く掛けすぎない。

- 高 surprise episode は「転換点」なので再利用価値が高いことがある
- でも毎回それを上げると、劇的だった episode ばかり出て普通の作業文脈を落とす

なので:

- `surprisePrior = clipped(log1p(surprise))`
- 重みは小さめ

が安全。

### 方針C: scoring profile を Thompson Sampling で選ぶ

Phase 2 のあとでもっと攻めたくなったら、profile 選択を bandit 化する。

例:

- `semantic-heavy`
- `balanced`
- `recent-heavy`
- `surprise-heavy`

各 profile を arm にして、session 単位の proxy reward で更新する。

これは効くが、最初から入れなくていい。Phase 3 で十分。

---

## 実装ステップ

## Phase 0: 観測を増やす

まずは学習前の土台。

追加ログ:

- raw surprise
- dynamic threshold
- z-score
- boundary reason
- candidate recall score breakdown
- topK に採用された episode ids

追加保存:

- per-agent segmentation state
- per-episode retrieval stats

対象:

- `go/main.go`
- `go/internal/vector/store.go`
- 新規 `go/internal/scoring/` または `go/internal/vector/bayes.go`

## Phase 1: 動的 segmentation threshold

実装内容:

- `ai.surprise` を `ai.segmentScore` に置換または拡張
- Go 側で posterior update
- TS 側の `surpriseThreshold = 0.2` を撤去
- config に以下を追加
  - `segmentationLambda`
  - `segmentationWarmupCount`
  - `segmentationMinRawSurprise`
  - `segmentationCooldownTurns`

成功条件:

- boundary 数が極端に増減しない
- topic shift での取り逃しが減る
- 雑談やコード作業で過分割が減る

## Phase 2: Posterior-aware rerank

実装内容:

- EpisodeRecord に追加
  - `Retrievals`
  - `Hits`
  - `Alpha`
  - `Beta`
  - `LastRetrievedAt`
  - `LastHitAt`
- recall を 2 段階化
  - HNSW candidate retrieval
  - Bayesian rerank

### `Phase 3.1` が入る場合の追加反映

`Phase 3.1` を入れるなら、Phase 2 の rerank はそのままでも動く。  
ただし、設計上は次の 3 点を追加で反映した方がよい。

1. `usefulness posterior` と `replay state` を分ける  
   `usefulness` は「使って役立ったか」、`retrievability/stability` は「忘れかけているか」の情報なので、混ぜずに別 feature として持つ。

2. `due_at` / `retrievability` を補助 signal にする  
   これで recall は「近い記憶」だけでなく「そろそろ再活性化したい重要記憶」を拾いやすくなる。

3. exploration weight を下げる  
   replay scheduler 側ですでに exploration を持つなら、retrieval 側の exploration は弱めないと二重投資になりやすい。

config に追加:

- `recallCandidateMultiplier`
- `recallSemanticWeight`
- `recallFreshnessWeight`
- `recallSurpriseWeight`
- `recallUsefulnessWeight`
- `recallExplorationWeight`

成功条件:

- 同じ query で「役に立つ episode」が上に安定する
- 無関係な high-similarity episode の混入が減る
- token waste が減る

### `Phase 3.1` 後の成功条件

Phase 3.1 が入った後は、次も見る。

- due memory の再提示が過剰にならない
- `usefulness` と `retrievability` の signal が喧嘩しない
- API 呼び出しを増やさずに rerank quality が上がる

## Phase 3: Thompson Sampling profile selection

実装内容:

- profile arm を 3〜5 個定義
- per-agent / global で Beta posterior を持つ
- recall ごとに 1 arm を sample
- session reward proxy で update

成功条件:

- 手動 weight 調整の頻度が下がる
- agent / workspace ごとの差を自動吸収できる

## Phase 4: BOCPD-lite への拡張

これは optional。

Phase 1 の `mean + lambda * std` で足りない場合だけ検討する。

条件:

- 長い会話で drift が強い
- 閾値が追従しきれない
- false split / false merge がまだ多い

この段階で、truncated run-length を持つ BOCPD-lite に進む。

---

## 変更対象の目安

### TypeScript

- `src/segmenter.ts`
  - 固定しきい値判定を撤去
  - Go 返却の動的判定に追従
- `src/retriever.ts`
  - debug 表示に score breakdown を載せられるようにする
- `src/config.ts`
  - Bayesian tuning 関連設定を追加
- `src/types.ts`
  - score breakdown / feedback 用の型を追加

### Go

- `go/main.go`
  - `handleSurprise` 拡張
  - recall feedback endpoint 追加
- `go/internal/vector/store.go`
  - EpisodeRecord 拡張
  - Recall rerank 拡張
- 新規 `go/internal/scoring/bayes.go`
  - segmentation posterior
  - episode usefulness posterior
  - Thompson Sampling helper

---

## 精度と効率のバランス上、やらない方がいいこと

### 1. いきなり LLM judge を feedback ループに入れる

精度は出やすいが、遅いし高い。まずは implicit feedback で十分。

### 2. full BOCPD を最初から入れる

理屈はきれいでも、今の段階では過剰。まずは posterior threshold でよい。

### 3. recall ごとに profile を大量に試す

オンライン memory でそれをやると latency が死ぬ。Thompson Sampling で 1 本だけ選ぶ方がいい。

### 4. `Surprise` を recall に強く効かせすぎる

転換点バイアスが強くなり、日常的に役立つ作業 episode が沈む。

---

## 推奨データ構造

### per-agent segmentation state

```json
{
  "count": 42,
  "mean": 0.137,
  "variance": 0.0021,
  "last_boundary_turn": 118,
  "cooldown_remaining": 0
}
```

Pebble meta key の候補:

- `meta:segstate:<agent-id>`
- `meta:segstate:global`

### per-episode usefulness state

```json
{
  "retrievals": 11,
  "hits": 4,
  "alpha": 2.0,
  "beta": 3.0,
  "last_retrieved_at": "2026-03-29T10:15:00Z",
  "last_hit_at": "2026-03-28T18:04:00Z"
}
```

---

## 重要な実装上の判断（Pre-Implementation 追記）

この Phase 2 は「動的チューニング」が主題なので、実装前に API 契約と state の置き場だけは固める。
ここが曖昧だと、後で TS/Go の責務分離が崩れて手戻りが増える。

### 1) `ai.surprise` は互換維持し、新しい endpoint を追加する

- 既存: `ai.surprise` は stateless に `cosine_distance(embed(text1), embed(text2))` を返す（デバッグ用途も兼ねている）
- 追加: `ai.segmentScore` を新設し、「raw surprise + 動的判定 + breakdown」を返す
- 既存の `src/segmenter.ts` は Phase 2 で `ai.segmentScore` を呼ぶように切替する（`ai.surprise` は残す）

### 2) segmentation state は Store(Pebble) 内に保存し、key は「store単位 + agent単位」にする

`getStore(agentWs)` により store は `agentWs` ごとに分かれる前提なので、
segmentation state のキーは基本的に `meta:segstate:<agentId>` でよい。

注意点:
- 現状 `ai.surprise` の入力には `agentId` が無い。`ai.segmentScore` の params には `agentId` を必須で入れる。
- state の更新は「判定に使った値」と同じ正規化（NFKC や trim ではなく、ここでは text slice の組み立てルール）で行う。
- 超短文や極端な truncation（payload 上限で切られた slice）が増えると分布が歪むため、ログに `len(text1)`, `len(text2)` を残す。

### 3) usefulness posterior は EpisodeRecord に埋め込まず、別 keyspace にする

`EpisodeRecord` の msgpack blob を recall ごとに更新すると write amplification が起きやすい。
ここは分離して「薄いレコード」を別 keyspace で持つほうが安全。

- key 例: `use:<episode-id>`
- 値: msgpack の `UsefulnessState`（retrievals/hits/alpha/beta/last_* など）
- flush: recall ごとに即 Sync write せず、一定間隔で batch flush（プロセス落ち時の損失は許容、または `pebble.NoSync` + 定期 Sync）

### 4) reward proxy を明文化する（曖昧だと posterior が壊れる）

まずは「人間の評価」や LLM judge ではなく、Episodic-Claw 内で観測できる proxy に寄せる。

推奨:
- `retrieval` = `ai.recall` が topK を返した回数
- `hit` = その候補が `assemble()` に実際に注入された、または `ep-expand` で明示的に参照された

これを実現するため、TS 側の `assemble()` 経路から `ai.recallFeedback` を呼び、`shown` / `used` / `expanded` の telemetry を残す。posterior そのものは `handleRecall` / `handleExpand` 側の proxy で更新する。

---

## API 契約（提案 / Phase 2）

### `ai.segmentScore`（新設）

目的: raw surprise を返すだけではなく、「この agent の直近分布に対してどれだけ異常か」を返す。

request:

```json
{
  "agentWs": "<episodes dir>",
  "agentId": "<string>",
  "text1": "<old slice>",
  "text2": "<new slice>"
}
```

response:

```json
{
  "rawSurprise": 0.31,
  "mean": 0.14,
  "std": 0.05,
  "threshold": 0.24,
  "z": 3.4,
  "isBoundary": true,
  "reason": "surprise-z"
}
```

### `ai.recallFeedback`（新設 / optional）

request:

```json
{
  "agentWs": "<episodes dir>",
  "feedbackId": "<uuid>",
  "shown": ["epid-1", "epid-2", "epid-3"],
  "used": ["epid-2"],
  "expanded": ["epid-2"],
  "source": "assemble"
}
```

備考:
- `feedbackId` は idempotency 用（同一 feedbackId を二重適用しない）
- `shown` は recall response に出た episode 群、`used` / `expanded` は実際に役立った proxy として分ける
- posterior 更新は `handleRecall` の retrievals と `handleExpand` の hits を主経路にする

---

## 評価指標

### segmentation

- boundary / 100 turns
- false split proxy
- false merge proxy
- forceFlush 依存率
- average episode size

### recall

- recall hit proxy
- repeated recall rate
- token waste rate
- `ep-expand` follow-up rate
- same-query stability

### system

- added latency per turn
- added latency per recall
- extra Pebble writes
- extra memory footprint

---

## おすすめの導入順

最短でちゃんと効かせるなら:

1. Phase 0
2. Phase 1
3. 1週間ログ観測
4. Phase 2
5. 必要なら Phase 3

個人的には、Phase 1 だけでも体感差が出る可能性が高いと思っている。今の `0.2` 固定は、さすがに雑すぎる。

---

## 実装判断

今回の結論はこれ。

- segmentation では「raw surprise の固定しきい値」を卒業する
- recall では「semantic-only に近い再ランキング」を卒業する
- ただし heavy な online learner ではなく、posterior summary と Thompson Sampling までに留める

Episodic-Claw の今の構成だと、このラインがいちばん精度と効率の折り合いがいい。

---

## 実装結果（TS Phase 2）

- `segmenter.ts` の固定 `0.2` を撤去し、オンライン平均/分散 + warmup/cooldown の動的しきい値に置き換え
- `config.ts` / `types.ts` に Bayesian tuning 用の knobs を追加
- `index.ts` から `EventSegmenter` に tuning 値を注入
- `npm run build:ts` は 2026-03-30 に成功確認済み

---

## 実装結果 (Phase 2 / Go-side)

更新日: 2026-03-30

- `EpisodeRecord` に retrieval stats (`Retrievals`, `Hits`, `Alpha`, `Beta`, `LastRetrievedAt`, `LastHitAt`) を追加
- `RecallWithTopics` を軽量 Bayesian rerank に拡張
  - `semantic + freshness + surprise prior + usefulness posterior + exploration` の加重合成
  - candidateK を `max(topK*4, 20)` に引き上げたうえで再ランキング
- `handleRecall` で返却エピソードの retrievals を加算
- `handleExpand` で D1 slug に強い hit を記録

### 検証

- `go build ./...` (episodic-claw/go) 成功

### 既知の残件

- TS 側の動的 segmentation 反映は Phase 2 で別途実装
- Phase 3 の Thompson Sampling profile は未着手

---

## 参考ソース

- `Bayesian Surprise Predicts Human Event Segmentation in Story Listening`  
  [https://pmc.ncbi.nlm.nih.gov/articles/PMC11654724/](https://pmc.ncbi.nlm.nih.gov/articles/PMC11654724/)

- `Robust and Scalable Bayesian Online Changepoint Detection`  
  [https://arxiv.org/abs/2302.04759](https://arxiv.org/abs/2302.04759)

- `Overcoming Prior Misspecification in Online Learning to Rank`  
  [https://arxiv.org/abs/2301.10651](https://arxiv.org/abs/2301.10651)

- `Dynamic Uncertainty Ranking: Enhancing Retrieval-Augmented In-Context Learning for Long-Tail Knowledge in LLMs`  
  [https://aclanthology.org/2025.naacl-long.453/](https://aclanthology.org/2025.naacl-long.453/)

- `An Empirical Evaluation of Thompson Sampling`  
  [https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/thompson.pdf](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/02/thompson.pdf)

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-29  
> Mode: Pre-Implementation  
> Prior audits: 0 | New findings this round: 6

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| なし | 初回監査 |

### ⚠️ Impact on Related Features *(new only)*
- `src/segmenter.ts` の boundary 判定は今 `ai.surprise` 依存で、しかも slice が payload 上限で truncation される前提。動的閾値を入れると「truncated surprise 分布」にチューニングされるため、slice 長の偏りが増えると境界判定が破綻しやすい。
- recall の rerank を Bayesian 化すると、`store.go` のスコアと `src/retriever.ts` 側の提示順の関係が変わる。これまでの「だいたい semantic で安定」な挙動から、探索枠のせいで user-facing には “ブレ” に見える可能性がある。

### 🚨 Potential Problems & Risks *(new only)*
- **BLOCKER**: usefulness posterior の reward/hit の定義が曖昧なままだと、posterior がノイズで学習されて「良い episode が沈む」方向に壊れる。最低限、`retrieval`/`hit` の proxy を決め打ちし、どの event で update するかを固定すべき。
- **HIGH**: per-episode stats を `EpisodeRecord` に埋め込んで recall ごとに更新すると、Pebble の書き込みが増えてレイテンシやディスク負荷が上がりやすい。keyspace 分離と batch flush の方針が必要。
- **HIGH**: segmentation state を per-agent にしたいなら、Go 側が `agentId` を受け取れる API 形状が必須。現状の `ai.surprise` の params だけでは per-agent の state に辿り着けない。
- **MED**: `mean + lambda * std` 方式は分散が小さいフェーズで過敏になりやすい。`variance floor` / `warmup` / `cooldown` の挙動を決めないと、初動で過分割が出る。

### 📋 Missing Steps & Considerations *(new only)*
- API 契約（request/response）がまだ曖昧。TS/Go の責務境界を先に固定しておかないと、Phase 1 実装の時点で “どこで state を更新するか” がブレる。
- 書き込み頻度（segstate/usefulness の更新）の I/O 戦略がない。`Sync write` を多用すると Phase 0 の「無駄打ち削減」に逆行する。
- テスト/検証の粒度が不足。最低限、segmentation の state update と境界判定は deterministic にユニットテスト可能。

### 🕳️ Unaddressed Edge Cases *(new only)*
- `agentWs` が異なる（複数 workspace / 複数 agent）場合に segstate が混線しないことの担保が弱い。
- `ai.segmentScore` が 429/timeout で落ちた時に、TS 側がどうフォールバックするか（固定閾値に戻すのか、size-limit のみで進むのか）が未定義。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| BLOCKER | usefulness posterior の `retrieval/hit` 定義と update トリガを明文化し、可能なら `ai.recallFeedback` を追加する | posterior が壊れると改善どころか劣化になる | ✅ New |
| HIGH | `ai.segmentScore` を新設して `agentId` を必須化、`ai.surprise` は互換維持する | per-agent state を実現しつつ既存経路を壊さない | ✅ New |
| HIGH | per-episode stats は `EpisodeRecord` から分離して keyspace に保存し、batch flush 方針を入れる | write amplification/レイテンシ悪化を避ける | ✅ New |
| MED | seg threshold の warmup / variance floor / cooldown を明確化し、slice 長のログを追加する | 初動の過分割と誤検知を減らす | ✅ New |
| MED | `ai.segmentScore` 失敗時の TS フォールバック方針を決める | 実運用で segmentation が止まるのを防ぐ | ✅ New |
| LOW | 最小ユニットテスト（state update/threshold 判定）を追加する | 係数変更で regress しやすい領域のため | ✅ New |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-29  
> Mode: Pre-Implementation  
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| usefulness posterior の reward/hit 定義が曖昧 | ✅ Resolved |
| per-episode stats の write amplification リスク | ✅ Resolved |
| per-agent segstate に `agentId` が必要 | ✅ Resolved |
| warmup / variance floor / cooldown の必要性 | ✅ Resolved |
| `ai.segmentScore` 失敗時の TS フォールバックが未定義 | ✅ Resolved (方針追記) |
| API 契約が曖昧 | ✅ Resolved |

<!-- ✅ No new critical issues found. Document has converged. -->

---

## Phase 4 反映メモ（v0.2.0）

この plan の Phase 2 で「Phase 4 側へ回す」としていた recall 側の項目は、Phase 4 実装で次を反映済み。

- `ai.recall` は `topics` を受け取れる
  - `strictTopics=true` の場合は facet filter（reverse index が未整備な時は legacy scan fallback）
  - `strictTopics=false` の場合は boost-only hint（topics が空振りでも recall を空にしない）
- `usefulness posterior` は `Retrievals/Hits` から posterior mean を作って rerank に入る
  - `RecordRecall()`（露出）と `ai.recallFeedback`（強い正例）で更新できる
- Phase 3.1 が有効な場合の `due_at / retrievability / stability` は、query relevance を壊さない範囲で tiny tie-breaker として扱う（clamp 前提）

---

## 13. 実装結果（Phase 2 / Adaptive Segmentation）

実装日: 2026-03-29

### 実装したこと

- `ai.segmentScore` を追加し、raw surprise（cosine distance）に対して per-agent の動的しきい値判定を返すようにした
- per-agent segmentation state を Pebble に永続化（`meta:segstate:<agentId>`）
- TS 側 `EventSegmenter.processTurn()` は `ai.surprise + ローカル閾値` から `ai.segmentScore` へ切替
- TS config へ tuning パラメータを追加（`segmentationLambda` 等）
- 互換性のため `ai.surprise` は残した（デバッグ用途・旧経路維持）

### 実装していないこと（Phase 2 の残り）

- usefulness posterior の導入と Bayesian rerank（これは Master Plan の Phase 4 側で扱う）
- BOCPD-lite / Thompson Sampling profile selection

### 検証

- Go: `go build ./...`（`episodic-claw/go`）成功
- TS: `npm run build:ts` 成功

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-29  
> Mode: Post-Implementation  
> Prior audits: 2 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| usefulness posterior の reward/hit 定義が曖昧 | ✅ Resolved (Phase 2 範囲から切り出し、API 契約を明文化) |
| per-episode stats の write amplification リスク | ✅ Resolved (keyspace 分離方針で明文化、Phase 4 へ) |
| per-agent segstate に `agentId` が必要 | ✅ Resolved (agentId を `ai.segmentScore` params へ追加) |
| warmup / floor / cooldown の必要性 | ✅ Resolved (TS config + API params に反映) |

<!-- ✅ No new critical issues found. Document has converged. -->

---

## 🔍 Audit Report — Round 4
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-29  
> Mode: Post-Implementation  
> Prior audits: 3 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| warmup 中に split しない保証が必要 | ✅ Resolved（`ai.segmentScore` が warmup 中 `isBoundary=false` を返す） |

<!-- ✅ No new critical issues found. Document has converged. -->
