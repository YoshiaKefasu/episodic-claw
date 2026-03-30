# D1 Consolidation Plan

更新日: 2026-03-30

## 結論

Episodic-Claw の D1 は、もう `semantic clustering` 単体を主役にしない方がいい。
ただし Phase 1 の主経路は、監査結果どおり `exact pairwise` を正解系にする。

実装の主役はこれ。

- `context-aware`
- `boundary-aware`
- `replay-prioritized`
- `semantic-clustering-assisted`
- `exact-pairwise-primary`

つまり、

- まず時間文脈と境界で「つなげていいか」を決める
- 次に exact pairwise で primary cluster を確定する
- HNSW は Phase 1 では主経路に使わず、将来の高速化オプションへ下げる
- 最後に replay 優先度を見て、D1 に昇格させる cluster を選ぶ

この順番にする。

人間の記憶っぽさで見ても、こっちの方が筋がいい。単純な「似ている D0 をまとめる」だけだと、脳というよりベクトル圧縮器になりやすい。

---

## この文書の目的

`go/internal/vector/consolidation.go` に残っている

- 現状: `時系列で 10 件ずつ`
- TODO: `HNSW Cosine distance clustering`

を、Sleep Consolidation の本番実装プランとして整理し直す。

この文書では次を決める。

1. いまの固定 10 件分割の何が足りないか
2. HNSW をどういう役割で使うべきか
3. 人間の記憶統合らしさを入れるなら何を主設計にすべきか
4. 実装の段階分け、データ構造、設定値、テスト方針

---

## 実装反映状況

2026-03-30 時点の Phase 3 実装は、次の形で反映済み。

- `RunConsolidation()` は orchestration のみに寄せた
- primary clustering は `exact pairwise + must-not-link + union-find`
- `contextVector` は永続化せず、その場計算に限定した
- `maxClusterTokens` と `perNodeTokenCap` を prompt guard と cluster guard の両方へ入れた
- `consolidation_key` を frontmatter に追加し、retry 時の D1 重複生成を防ぐようにした
- clustering が壊れた時は legacy `chunkSize=10` fallback へ戻る

つまり、Phase 1/Phase 3 の実装上の source of truth は HNSW ではなく exact pairwise である。

---

## 現在実装の確認

### 現状の流れ

`RunConsolidation()` は今こう動く。

1. Pebble 全走査で `!archived && !d1-summary` の D0 を集める
2. 時系列ソートする
3. `chunkSize := 10` で固定分割する
4. chunk ごとに `processCluster()` を呼ぶ
5. D1 を生成し、child D0 を archive する

### 現状方式の良い点

- cluster size が安定する
- API コストを読みやすい
- timeout の上限が見積もりやすい
- D1 の粒度が暴れにくい

### 現状方式の弱い点

- 意味的まとまりを見ていない
- 予測誤差や event boundary を使っていない
- 同じ文脈の流れと、偶然連続した 10 件を区別できない
- 弱いが重要な単発記憶を救えない
- D1 が「その夜の 10 件要約」で止まりやすい

---

## 重要な設計判断

## 1. HNSW はクラスタラではない

ここが一番大事。

HNSW 自体は近傍探索インデックスであって、クラスタリング手法ではない。

なので TODO の `HNSW Cosine distance clustering` は、そのまま実装すると誤解を生みやすい。やるべきことは次。

- HNSW で近傍候補を引く
- その候補の上で edge を張る
- edge と制約から cluster を作る

つまり本当に必要なのは:

- `HNSW-assisted constrained clustering`

である。

## 2. semantic clustering は補助役に下げる

人間の記憶統合に寄せるなら、cluster を作る前に次を見ないといけない。

- `temporal context`
- `surprise / event boundary`
- `salience`
- `weakness / instability`
- `recurrence`

意味的近さは必要。でも主役ではない。

## 3. hard cluster と graph memory を分ける

人間の記憶は完全な partition ではない。

だから、

- D1 生成用には primary cluster を 1 本決める
- ただし long-term の意味連関は bridge / semantic / schema edge で別に残す

という二層にする。

---

## 人間っぽい統合に必要な 4 原則

## 原則 1: 時間文脈を explicit に持つ

pairwise cosine だけだと、「何の流れの中の出来事か」が消える。

そこで各 D0 に `temporal context vector` を持たせる。

イメージ:

- `node vector`: その D0 自体の意味
- `context vector`: 直前数件を薄く畳み込んだ文脈

使い方:

- cluster affinity を `node similarity` だけでなく `context similarity` でも計算する
- D1 要約 prompt に「この出来事へ至る流れ」も渡す

## 原則 2: boundary は must-not-link にする

`surprise-boundary` は飾りではなく、かなり強い禁止条件にする。

やること:

- `surprise > boundaryCut` をまたぐ D0 間には edge を張らない
- 低 surprise の連続 run は merge しやすくする
- similarity が高くても boundary をまたぐなら primary cluster を分ける

## 原則 3: replay priority を入れる

Sleep Consolidation は全件一律処理ではなく、優先順位をつける。

優先度に入れる値:

- `salience`
- `weakness`
- `recurrence`
- `recency`

人間の replay は strongest memory 一択ではない。弱くてまだ不安定な記憶も優先される。

## 原則 4: schema scaffold を用意する

D1 を作るだけだと、「夜ごとの要約ファイル」が増えるだけになりやすい。

だから将来に向けて、

- D0 -> D1
- D1 -> Schema / Topic Memory

の二段目を見据えた edge 設計にする。

Phase 1 では full schema 実装まではやらない。ただし D1 同士の意味連関を残せる構造にしておく。

---

## 推奨アーキテクチャ

## Stage 0: 対象 D0 を集める

条件は現状維持でよい。

- `!archived`
- `!d1-summary`

### 対象上限（ガード）

`!archived` が増え続ける前提だと、毎回全件で temporary HNSW を再構築するのは重い。  
Phase 1 はまず「安全に上限を作る」。

- 直近 `maxActiveD0` 件だけを対象にする（例: 200）
- 直近 `maxWindowHours` 時間内だけを対象にする（例: 72h）

この 2 つのどちらか（または両方）で対象を切って、コストの上限を固定する。

この時点で必要な値をまとめる。

- `EpisodeRecord`
- `timestamp`
- `vector`
- `surprise`
- `tags`
- `savedBy`

追加で持ちたいもの:

- `contextVector`
- `salienceScore`
- `replayPriority`

## Stage 1: temporal context を作る

各 D0 ごとに、その前後の近傍文脈を要約した `contextVector` を作る。

初期版は軽くていい。

候補:

- 直前 `N=3` 件の D0 ベクトルを時間減衰付き平均
- 直後は使わず、因果順を守る

例:

```text
ctx_i = normalize(
  0.6 * v_{i-1} +
  0.3 * v_{i-2} +
  0.1 * v_{i-3}
)
```

これだけでも「単発 similarity」からかなり脱却できる。

## Stage 2: D0 専用 HNSW を一時構築する

設計候補としては残すが、**Phase 1 の実装主経路には採用しない**。
監査結果どおり、`d1MaxActiveD0 = 200` 前後なら exact pairwise の方が精度と再現性で有利。

初手は global graph 流用ではなく、対象 D0 だけで temporary HNSW を組む。

理由:

- archived / D1 ノイズを避けられる
- cluster 精度が読みやすい
- debugging が楽

Sleep job は常時走る処理ではないので、まずは安全性優先でいい。

### 距離尺度（cosine vs L2^2）

設計上の重要ポイント:

- 本文では `cosine` を使いたい（文脈的な意味で妥当）
- ただし `go-hnsw` の距離は L2 系で返ってくる

HNSW を将来使うときの前提はこれで固定する:

- **埋め込みベクトルを L2 正規化してから HNSW に入れる**
- すると L2^2 は cosine と単調変換になる（`||u-v||^2 = 2 - 2*cos(u,v)`）
- したがって `cosSim` は `cosSim = 1 - (l2sq / 2)` で近似できる

これで「HNSW は L2、閾値は cosine」というズレを消して実装できる。

## Stage 3: 近傍 edge を張る

Phase 1 の実装では `topM` 近傍ではなく、`exact pairwise` 全比較で次を判定する。
対象上限を 200 に切っているので、ここはまだ十分現実的。

各 D0 ペアについて、次の条件を満たす時だけ edge を張る。

- `nodeCosSim >= minNodeSimilarity`
- `contextCosSim >= minContextSimilarity`
- `abs(timeGap) <= maxNeighborGap`
- `mustNotLinkCrossed == false`

候補式:

```text
affinity(i, j) =
  a * cosine(node_i, node_j) +
  b * cosine(ctx_i, ctx_j) +
  c * temporal_decay(|t_i - t_j|)
```

初期版では `surprise-boundary` を **must-not-link（禁止条件）** にする。

```text
mustNotLinkCrossed(i, j) =
  true  if there exists a boundary between i and j in time order
  false otherwise
```

実装の具体化（重要）:

- `surprise-boundary` は「その D0 の直後で境界が切れた」ことを表す tag として扱う
- `i < j` のとき `i..j-1` の間に boundary tag が 1 つでもあれば、**その 2 点はリンク禁止**
- これは prefix-sum で O(1) 判定できる（`boundariesPrefix[j] - boundariesPrefix[i] > 0`）

## Stage 4: union-find で primary cluster を作る

edge から連結成分を作る。

ただしそのままだと topic chain が残るので、後段で整形する。

## Stage 5: post-process で cluster を整える

最低限ここまでは入れる。

### Guardrail の優先順位（Phase 1 で固定）

分割の優先順位を固定しないと、挙動が再現不能になって調整できない。  
Phase 1 は次の順で処理する。

1. `maxClusterSpan`（時間幅の上限）で時系列分割
2. `maxClusterSize`（件数の上限）で時系列分割
3. `minClusterSize`（小さすぎる cluster の扱い）を整理

### 1. `maxClusterSize`

大きすぎる cluster は時系列順に再分割する。

### 2. `maxClusterSpan`

時間幅が長すぎる cluster は分割する。

### 3. `minClusterSize`

小さすぎる cluster は merge 候補にする。

ただし例外がある。

### 4. `high-salience singleton` を救う

`minClusterSize` 未満でも次のような D0 は単独 D1 候補として残す。

#### Phase 1 の salience（deterministic 定義）

Phase 1 は learned policy を避け、決め打ちで再現性を出す。

- `manual-save` tag がある: salience = 1.0（常に救う）
- それ以外: `surprise` を `log1p` 正規化して 0..1 に潰したスコアを使う
- 追加の補助（任意）: retrieval stats があるなら `Hits > 0` を少し加点してよい

救済条件例:

- `salience >= d1HighSalienceCut`

ここを落とすと、弱いが重要な記憶を潰しやすい。

### 5. token guard を入れる

件数だけでは summarize timeout を防げないので、Phase 1 は token guard を固定で入れる。

- `perNodeTokenCap` で各 D0 body を切る
- `maxClusterTokens` で cluster 全体の prompt 予算を切る
- 超過分は body を先頭優先で trim する

これで `maxClusterSize` だけでは守れない長文 D0 混入ケースを抑える。

## Stage 6: replay priority で D1 化順を決める

全部の cluster を均等に LLM へ送るのではなく、優先度順に処理する。

候補式:

```text
priority(cluster) =
  w_sal * meanSalience +
  w_weak * meanWeakness +
  w_rec * recurrence +
  w_recent * recency
```

意味:

- 強くて目立つ記憶だけでなく
- 弱くてまだ固まっていない記憶も

優先して replay / consolidation する。

## Stage 7: D1 を生成し、bridge/schema edge を残す

`processCluster()` は活かす。ただし入力が変わる。

生成時に追加したいこと:

- D1 child は `primary cluster` だけを持つ
- D0 同士の `bridge edge` を optional で残す
- D1 生成時に既存 D1 近傍を見て `schema-affinity` を計算する

Phase 1 では full schema memory まではやらない。代わりに D1 間の semantic bridge を残せるようにする。

---

## データモデル

## 追加したい構造体

```go
type ConsolidationNode struct {
    Record          EpisodeRecord
    ContextVector   []float32
    SalienceScore   float64
    ReplayPriority  float64
}

type ConsolidationCluster struct {
    Nodes           []ConsolidationNode
    MeanAffinity    float64
    StartTime       time.Time
    EndTime         time.Time
    MeanSalience    float64
    MeanWeakness    float64
}
```

## `EpisodeRecord` か周辺メタに追加候補

- `ReplayCount`
- `LastRecalledAt`
- `StabilityScore`
- `ManualImportance`

Phase 1 では全部必須ではない。最低限 `contextVector` と `salience` 系の計算材料があればよい。

---

## 推奨パラメータ

初期値は守り寄りで始める。

- `d1MaxActiveD0 = 200`（対象 D0 上限）
- `d1MaxWindowHours = 72`（対象期間上限）
- `d1ClusterTopM = 5`
- `d1ClusterMinNodeSimilarity = 0.82`
- `d1ClusterMinContextSimilarity = 0.70`
- `d1ClusterMaxNeighborGapHours = 24`
- `d1ClusterMinSize = 3`
- `d1ClusterMaxSize = 12`
- `d1ClusterMaxSpanHours = 48`
- `d1BoundaryCut = 0.20`（legacy fallback: tag がない場合のみ `Surprise` で境界扱い）
- `d1HighSalienceCut = 0.75`
- `d1MaxClusterTokens = 3200`
- `d1PerNodeTokenCap = 640`
- `d1FallbackChunkSize = 10`（クラスタリング破綻時の退避）
- `d1NormalizeVectors = true`（cosine を L2^2 で近似する前提）

このへんは config 化する。

---

## 実装変更点

## `consolidation.go`

責務を分割する。

- `collectActiveD0Nodes()`
- `buildContextVectors()`
- `buildExactPairwiseClusters()`
- `buildPrimaryClusters()`
- `postProcessClusters()`
- `scoreReplayPriority()`
- `loadExistingConsolidationKeys()`
- `processCluster()`

`RunConsolidation()` は orchestration に寄せる。

## `store.go`

必要なら temporary graph 用 helper を追加する。

候補:

- `BuildTempGraph(nodes []EpisodeRecord) (*hnsw.Hnsw, error)`
- `SearchTempGraph(...)`

ただし Phase 1 の実装では未使用。HNSW は将来の高速化用。

## config

追加したい設定:

- `d1MaxActiveD0`
- `d1MaxWindowHours`
- `d1ClusterTopM`
- `d1ClusterMinNodeSimilarity`
- `d1ClusterMinContextSimilarity`
- `d1ClusterMaxNeighborGapHours`
- `d1ClusterMinSize`
- `d1ClusterMaxSize`
- `d1ClusterMaxSpanHours`
- `d1BoundaryCut`
- `d1HighSalienceCut`
- `d1FallbackChunkSize`
- `d1NormalizeVectors`

### 設定値の置き場（Phase 1）

このリポジトリの現状だと、Go sidecar へ TS の config を自然に流す経路が薄い。  
Phase 1 は「Go 側の定数（`consolidation.go` 内）で開始」でよい。

将来的に動的調整をしたくなったら、次のどちらかに寄せる。

- Pebble meta（例: `meta:d1cfg`）に JSON で保存して `getStore()` 経由で読む
- もしくは RPC で `ai.setMeta` 経由に寄せる（運用で切替可能）

## logging

最低限これを出す。

- active D0 件数
- cluster 数
- cluster サイズ分布
- cluster span 分布
- must-not-link 発火数
- singleton 救済数
- priority 上位 cluster の要約
- fallback 発火数
- fingerprint reuse 数

---

## 実装フェーズ

## Phase 1

目的:

- `semantic-clustering-assisted` 版へ移行する
- ただし schema layer までは行かない

やること:

1. temporary D0 HNSW
2. `contextVector`
3. `must-not-link`
4. union-find + guardrail
5. `high-salience singleton`

実装後の並びは次になった。

1. exact pairwise
2. `contextVector`
3. `must-not-link`
4. union-find + guardrail
5. `high-salience singleton`
6. token guard
7. fingerprint/idempotency

やらないこと:

- full schema memory
- D1 の再統合
- learned replay policy

## Phase 2

目的:

- replay priority を強化する
- D1 間 bridge を使い始める

やること:

1. replay priority scoring
2. D1 semantic bridge
3. `schema-affinity` の実験導入

## Phase 3

目的:

- D1 -> schema/topic memory への昇格

やること:

1. schema node の追加
2. D1 から schema への link
3. slow-timescale consolidation

---

## テスト方針

## 単体テスト

- 純時系列ケース
- topic chain ケース
- long gap ケース
- high-salience singleton ケース
- boundary crossed ケース

できれば人工ベクトルを直接与える table-driven test にする。

## 結合テスト

- D0 20 件から D1 本数が極端に暴れない
- `ep-expand` で child が読みやすい
- manual consolidate が 10 分 timeout に収まる
- archive 後も recall が壊れない

## 監視指標

- D1 生成数 / run
- 平均 cluster size
- 平均 cluster span
- singleton 救済率
- must-not-link 発火率
- D1 recall 後の `ep-expand` 利用率

---

## これで何が変わるか

いまの方式:

- 10 件連続していたから 1 本の D1 になる

新方式:

- 同じ流れに属していて
- 境界をまたがず
- replay 価値があり
- 意味的にも近い

ものが D1 になる

要するに、

- 「たまたま近くに並んだ」ではなく
- 「同じ出来事の流れとして再活性化されるべき」

を基準に寄せることになる。

ここが、人間っぽさの一番大きい差。

---

## 研究メモ

この設計に効いた論点は次の通り。

- EM-LLM は event segmentation で `Bayesian surprise` と graph 的な境界精緻化を使っている  
  Source: https://arxiv.org/abs/2407.09450

- episodic retrieval は単純な近傍検索ではなく、徐々に変化する temporal context の回復を伴う  
  Source: https://pmc.ncbi.nlm.nih.gov/articles/PMC5963851/

- prediction error は episodic memory の時間構造自体を組み替える  
  Source: https://pmc.ncbi.nlm.nih.gov/articles/PMC8196002/

- replay は strongest memory 固定ではなく、弱い記憶を優先する傾向がある  
  Source: https://pmc.ncbi.nlm.nih.gov/articles/PMC6156217/

- sleep は gist 抽出と schema integration を後押しする  
  Sources:
  - https://pmc.ncbi.nlm.nih.gov/articles/PMC5314355/
  - https://pmc.ncbi.nlm.nih.gov/articles/PMC9527246/

---

## 実装優先順位

最初に効く順はこれ。

1. `temporal context vector`
2. `surprise-boundary -> must-not-link`
3. `high-salience singleton`
4. temporary D0 HNSW
5. replay priority
6. D1 bridge / schema scaffold

---

## 最終判断

この TODO は、単純に「10件固定を HNSW clustering に置換する」で終わらせない方がいい。

本当にやるべき実装は、

- `context-aware`
- `boundary-aware`
- `replay-prioritized`
- `semantic-clustering-assisted`

な Sleep Consolidation である。

これなら D1 は「似たログの寄せ集め」ではなく、「同じ流れとして再活性化される経験のまとまり」に近づく。そこまで行くと、Episodic-Claw の D1 はかなり脳っぽくなる。

---

## Phase 3 Implementation Notes

Phase 3 の実装では、監査で整理した方針を次の形で反映した。

- `exact pairwise + context vector + must-not-link + union-find` を主経路にした
- `maxClusterTokens` と `perNodeTokenCap` で summarize prompt を制御した
- child ID 列の `fingerprint` を `consolidation_key` として D1 frontmatter に保存した
- 同一 fingerprint の D1 が既にある場合は再生成せず、既存 D1 に child を再リンクするようにした
- parse 失敗や空本文の D0 は `consolidation-failed` / `consolidation-skip` で quarantine するようにした
- singleton D1 は専用の要約プロンプトに分岐し、過剰一般化を抑えた

この段階では `contextVector` は永続化せず、その場計算に限定している。D1 の source of truth はあくまで exact pairwise 側に置く。

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Pre-Implementation  
> Prior audits: 0 | New findings this round: 6

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| なし | 初回監査 |

### ⚠️ Impact on Related Features *(new only)*
- **距離尺度の不一致リスク**: 文書は「HNSW cosine distance clustering」と書いているが、現実の `go-hnsw` は L2 ベースで動く。ここを曖昧なまま実装すると、境界判定や similarity の閾値が成立せず、クラスタが過結合/過分割になる。
- **`surprise-boundary` の意味が実装でズレやすい**: 現状のタグ付けでは「境界の左右どちらに付与されるか」が実装依存になる。`must-not-link` を「隣接インデックスのみ」扱いにすると、離れたノードを近傍探索で繋いで境界を跨ぐバグが出やすい。
- **Consolidation の lock/IO パターン**: 既存実装は「Store の write lock 中に重い処理をしない」方針に寄せている。新クラスタリングが DB/graph lock を長時間保持すると、Recall/Healing と競合して体感が悪化する。

### 🚨 Potential Problems & Risks *(new only)*
- **計算量/メモリの暴走**: `!archived` の D0 が増えたとき、全件で temporary HNSW を毎回再構築すると重い。最低限「対象期間/件数の上限」か「時間窓で分割して段階的にクラスタリング」のガードが必要。
- **クラスタの guardrail が仕様として未確定**: `minSize/maxSize/maxSpanHours` の優先順位と、超過時の分割ルールが文書上まだ曖昧。ここが曖昧だと挙動が再現不能になり、チューニング不能になる。
- **salience/weakness/recurrence の定義が未固定**: 何をもって `high-salience singleton` とするかが実装者の裁量になっていて、期待値がぶれる。最低限 Phase 1 の salience は deterministic に定義しておくべき。

### 📋 Missing Steps & Considerations *(new only)*
- **設定値の置き場が未記載**: TS 側の `loadConfig()` はあるが、Go sidecar の consolidation は現状 config を受け取る経路が薄い。Phase 1 は「Go 内定数で開始」か「Pebble meta に保存して読む」など、運用可能な置き場を決めて書く必要がある。
- **フォールバック設計がない**: 近傍探索/union-find が失敗した場合（0 クラスタ、極端な 1 巨大クラスタ、全 singleton など）に、従来の `chunkSize=10` に戻す fallback を明文化しておくと安全。

### 🕳️ Unaddressed Edge Cases *(new only)*
- **ベクトルの次元不一致/欠損**: Healing/再建経由で欠損・不正ベクトルが混入すると clustering が壊れる。クラスタリング前に `len(vec)==3072` を保証し、外れ値は隔離する手順が必要。
- **境界が多すぎる会話**: `surprise-boundary` が連発するケースで must-not-link が強すぎると、D1 が大量に生成されて API コストが跳ねる。上限と抑制策（cooldown 的なもの）を用意した方がよい。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| BLOCKER | 「cosine と L2 の関係」を前提化する方針を明記（例: ベクトルを正規化して L2^2 で近似し、`cosSim = 1 - dist/2` を採用） | 閾値設計が崩れてクラスタが壊れるのを防ぐ | ✅ New |
| HIGH | `must-not-link` の定義を「境界を跨ぐ全リンク禁止（prefix-sum で O(1) 判定）」まで書き下す | 近傍探索が境界を跨ぐバグを防ぐ | ✅ New |
| HIGH | Guardrail の優先順位と分割ルール（`maxSpan` → `maxSize` → `minSize` の順など）を決めて記載 | 挙動の再現性とチューニング性を確保 | ✅ New |
| MED | Phase 1 の salience 定義を deterministic に固定（例: `manual-save`/`surprise`/`hits` の加重） | singleton 救済が安定しない問題を抑える | ✅ New |
| MED | 対象 D0 の上限/時間窓のガードを設ける（例: 直近 N 件 or 直近 H 時間） | HNSW 再構築コストの上限を作る | ✅ New |
| LOW | 失敗時 fallback（chunkSize=10）を明記する | 運用中の事故復旧を容易にする | ✅ New |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Pre-Implementation  
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| cosine/L2 の前提が曖昧 | ✅ Resolved（正規化 + `cosSim = 1 - dist/2` を本文に明記） |
| must-not-link の定義が弱い | ✅ Resolved（prefix-sum 前提の「境界跨ぎ全リンク禁止」を本文に明記） |
| guardrail の優先順位が曖昧 | ✅ Resolved（`maxSpan`→`maxSize`→`minSize` を固定） |
| salience 定義が未固定 | ✅ Resolved（Phase 1 deterministic 定義を本文に明記） |
| 対象 D0 の上限がない | ✅ Resolved（`d1MaxActiveD0`/`d1MaxWindowHours` を追加） |
| fallback がない | ✅ Resolved（`d1FallbackChunkSize` を追加） |

<!-- ✅ No new critical issues found. Document has converged. -->

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Pre-Implementation  
> Prior audits: 2 | New findings this round: 4

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| cosine/L2 の前提が曖昧 | ✅ Resolved |
| must-not-link の定義が弱い | ✅ Resolved |
| guardrail の優先順位が曖昧 | ✅ Resolved |
| salience 定義が未固定 | ✅ Resolved |
| 対象 D0 の上限がない | ✅ Resolved |
| fallback がない | ✅ Resolved |
| Round 2 で新規重大指摘なし | ✅ Maintained |

### ⚠️ Impact on Related Features *(new only)*
- **近似探索のゆらぎが D1 の再現性を壊す**: この文書は `d1MaxActiveD0 = 200` を前提にしているが、その規模なら pairwise の全比較はまだ十分現実的。ここで最初から HNSW を主経路にすると、ANN の取りこぼしや近傍順序のぶれで D1 本数や child 構成が run ごとに揺れ、`ep-expand` や recall の説明可能性が下がる。
- **D1 child 構成の重複生成が downstream を汚す**: cluster fingerprint や idempotency key の記述がないまま `processCluster()` を多段化すると、失敗リトライや途中中断後の再実行で「似た D1 が複数できる」危険がある。これは D1 recall と semantic bridge の質を直接落とす。

### 🚨 Potential Problems & Risks *(new only)*
- **トークン予算ガードが未定義**: この文書は `maxClusterSize` と `maxClusterSpan` は定義しているが、`clusterText` の総 token 上限がない。長文 D0 が数件混ざるだけで LLM summarize が timeout/切り詰めになり、manual consolidate の 10 分 SLA を簡単に破る。
- **contextVector の保存契約が曖昧**: `EpisodeRecord` か周辺メタに追加候補と書かれている一方で、Phase 1 の最小実装境界が明示されていない。永続化前提で実装すると schema 変更・rebuild・旧データ互換が一気に増え、逆に一時計算前提なら migration は不要なので、ここを曖昧にしたまま着手すると実装差が大きく割れる。

### 📋 Missing Steps & Considerations *(new only)*
- **Phase 1 の主経路を exact-first にする判断が書かれていない**: 対象上限を 200 に切るなら、まずは `exact pairwise similarity + must-not-link + union-find` を正解系にして、その後に HNSW を高速化オプションへ落とす方が安全。今の文書だと HNSW が要件化されすぎて、初期精度検証が難しくなる。
- **cluster fingerprint / 再実行安全性の手順がない**: child IDs を時系列順でハッシュした fingerprint を D1 metadata へ持たせ、同一 fingerprint が既にあれば再生成しない、という一手があると運用事故をかなり減らせる。現状の文書にはそこがない。

### 🕳️ Unaddressed Edge Cases *(new only)*
- **ANN の近傍取りこぼしで bridge だけ残り primary cluster が崩れるケース**: semantic に近いのに HNSW 候補から落ちた node があると、bridge だけ張られて D1 child から外れる可能性がある。Phase 1 で exact-first にしないなら、少なくとも `all-singleton` や `unexpected fragmentation` の検出が必要。
- **極端に長い D0 が混ざるケース**: count は 3 件でも body が巨大なら cluster prompt は破綻する。`maxClusterTokens` か `per-node token cap` がないと、件数ガードだけでは守れない。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| HIGH | Phase 1 は `exact pairwise` を主経路、HNSW は高速化/比較用の副経路と明記する | 200 件上限なら精度・再現性を先に取りやすい | ✅ New |
| HIGH | `maxClusterTokens` と `perNodeTokenCap` を追加し、超過時の trimming ルールを定義する | 件数だけでは LLM timeout と要約破綻を防げない | ✅ New |
| HIGH | child ID 列の fingerprint を D1 metadata に保存し、再実行時に重複生成を避ける | partial failure / retry 時の D1 重複を防ぐ | ✅ New |
| MED | `contextVector` は Phase 1 では永続化せず、その場計算に限定すると明記する | schema 変更と migration の膨張を避ける | ✅ New |

---

## 実装結果（Phase 3 / D1 Dynamic Clustering）

実装日: 2026-03-30

### 実装したこと

- `RunConsolidation()` の固定 `chunkSize := 10` を撤去し、クラスタを `buildD1Clusters()` 経由で構築するように変更
- Phase 1 の最小セットを実装
  - 対象 D0 を時間窓/件数でトリム（`d1MaxWindowHours`, `d1MaxActiveD0`）
  - ベクトル正規化 + `exact pairwise` による primary clustering
  - `surprise-boundary` を must-not-link（境界跨ぎリンク禁止）として適用（prefix-sum 判定）
  - union-find で primary cluster を構築
  - `maxSpan` / `maxSize` / `maxClusterTokens` ガードで時系列分割
  - `high-salience` の singleton 救済（deterministic）
  - salience/weakness/recency による簡易 replay priority（cluster 処理順の優先）
  - `perNodeTokenCap` で D0 本文の prompt 予算を制御
  - `consolidation_key` による fingerprint reuse と D1 重複生成回避
  - parse 失敗 / 空本文 D0 の quarantine（`consolidation-failed`, `consolidation-skip`）
  - singleton 用の要約プロンプト分岐
- クラスタリングが破綻した場合は `d1FallbackChunkSize` にフォールバック（退避策）

### 変更ファイル

- `go/internal/vector/consolidation.go`
- `go/internal/vector/d1_clustering.go`（新規）
- `docs/d1_dynamic_clustering_plan.md`

### 検証

- Go: `go build ./...` 成功（`episodic-claw/go`）
- TS: `npm run build:ts` 成功

---

## 🔍 Audit Report — Round 4
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Post-Implementation  
> Prior audits: 3 | New findings this round: 3

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| cosine/L2 の前提が曖昧 | ✅ Resolved（正規化 + proxy 式を実装に反映） |
| must-not-link の定義が弱い | ✅ Resolved（prefix-sum で境界跨ぎ禁止を実装） |
| guardrail の優先順位が曖昧 | ✅ Resolved（`maxSpan`→`maxSize`→`minSize` を実装に反映） |
| salience 定義が未固定 | ✅ Resolved（deterministic salience を実装） |
| 対象 D0 の上限がない | ✅ Resolved（トリムを実装） |
| fallback がない | ✅ Resolved（フォールバック chunk を実装） |
| ANN 探索ゆらぎで再現性が落ちる懸念 | ⚠️ Still open（Phase 1 は HNSW 主経路のまま） |
| token 予算ガードが未定義 | ⚠️ Still open（`clusterText` の上限がない） |
| D1 重複生成のリスク（fingerprint/idempotency） | ⚠️ Still open（slug が非決定、重複回避キーなし） |
| contextVector の永続化契約が曖昧 | ✅ Resolved（Phase 1 はその場計算のみで永続化なし） |

### ⚠️ Impact on Related Features *(new only)*
- **壊れた D0 を永遠に再処理してしまう**: D0 の `SourcePath` 欠損や frontmatter parse 失敗が混ざると、クラスタ生成や D1 生成が失敗し続け、`!archived` のまま残って毎回再走する。結果として、Sleep Consolidation 全体のスループットが落ち、Recall/Healing の体感も巻き込んで悪化する。
- **「最大 200 件だけ使う」のに全走査する無駄が残る**: 現状フローは Pebble 全走査で D0 を集めてから末尾 200 を使う。データが増えるほど “集めるだけのコスト” が積み上がり、バックグラウンド処理の時間が伸びる。

### 🚨 Potential Problems & Risks *(new only)*
- **singleton D1 が増えると要約品質がブレる**: `high-salience singleton` 救済は正しいが、要約プロンプトが「複数ログの抽象化」を前提にしていると、単発イベントが過剰一般化されやすい。D1 のノイズが増えると、Topic/Schema 側の学習も汚れる。

### 📋 Missing Steps & Considerations *(new only)*
- **失敗 D0 の隔離（quarantine）手順がない**: parse 失敗や空本文で D1 化できない D0 を “処理不能としてタグ付けして退避” する手順がない。少なくとも `consolidation-skip` / `consolidation-failed` のようなタグを付け、次回以降は対象から外す必要がある。

### 🕳️ Unaddressed Edge Cases *(new only)*
- **cluster 全体が「読めない D0」だけで構成される**: D0 が全て parse 不能や空本文だと、クラスタが毎回失敗して進まない。退避しない限り永久ループになる。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| HIGH | child ID 列の fingerprint（idempotency key）を D1 metadata に保存し、同一 fingerprint が既にあれば再生成しない | partial failure / retry で D1 が増殖すると downstream が汚れる | 🔁 Carry-over |
| HIGH | `maxClusterTokens` と `perNodeTokenCap` を追加し、超過時の trimming ルールを実装する | LLM timeout と要約崩壊は件数ガードでは防げない | 🔁 Carry-over |
| HIGH | parse 失敗 / 空本文の D0 を quarantine する（例: `consolidation-failed` タグ + 理由） | 永久再処理のループと無駄 API コストを止める | ✅ New |
| MED | D0 収集を「全走査」から「時間窓/上限で早期停止できる走査」へ寄せる | データが増えるほど consolidation のベースコストが上がる | ✅ New |
| MED | singleton 用の要約プロンプト分岐を追加する（単発イベントの抽象化を抑える） | D1 ノイズの増加を防ぐ | ✅ New |
| MED | `exact pairwise` を n<=200 の主経路にするか、少なくともデバッグ用に切り替え可能にする | 再現性と説明可能性が上がり、閾値調整が楽になる | 🔁 Carry-over

---

## 🔍 Audit Report — Round 5
> Reviewed from the perspective of an IBM / Google Pro Engineer  
> Date: 2026-03-30  
> Mode: Post-Implementation  
> Prior audits: 4 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| ANN 探索ゆらぎで再現性が落ちる懸念 | ✅ Resolved（primary path は `exact pairwise` に切替済み） |
| token 予算ガードが未定義 | ✅ Resolved（`maxClusterTokens` / `perNodeTokenCap` と trimming を実装） |
| D1 重複生成のリスク（fingerprint/idempotency） | ✅ Resolved（`consolidation_key` と reuse を実装） |
| singleton D1 が過剰一般化しやすい | ✅ Resolved（singleton 専用 prompt に分岐） |
| 失敗 D0 の隔離（quarantine）手順がない | ✅ Resolved（`consolidation-failed` / `consolidation-skip` を実装） |
| D0 収集が全走査のまま | ⚠️ Still open（対象上限はあるが、Pebble 走査自体は全件） |
| cluster 全体が読めない D0 だけで構成されると永久ループ | ✅ Resolved（読めない D0 を quarantine することで次回対象から外れる） |

<!-- ✅ No new critical issues found. Document has converged. -->

---
