# Hippocampus-Inspired Replay Importance & Noise Note

このメモは、Phase 3.1 の次で

- 「今のノイズ記憶を最終的にどう処分するか」
- 「本当に重要な記憶だけをもっと賢く選ぶには何を足すか」

を整理するための note です。

これは実装済み plan ではなく、**次の改善方針メモ**です。

---

## 結論

方向性はかなり良い。

単に `FSRS-inspired` を全記憶へ掛けるのではなく、

1. まず **hippocampus-inspired importance score** で replay 候補を絞る
2. そのあとに **pseudo-FSRS** で「いつ復習するか」を決める
3. replay から落ちた低価値記憶は **保持 / gist 化 / tombstone / prune** に分ける

のが一番筋が良い。

要するに、

- **importance selection**
- **replay scheduling**
- **noise disposal**

を 1 つの score に押し込まず、役割分離する方がよい。

---

## 研究的な拝借ポイント

### 1. hippocampal replay は「強い記憶」だけでなく「弱いが補強が必要な記憶」を優先しうる

Human hippocampal replay の研究では、wake replay は単に strongest memory を再生するのではなく、**補強が必要な記憶を優先する** 方向が示唆されている。

参考:

- [Human hippocampal replay during rest prioritizes weakly learned information and predicts memory performance](https://pmc.ncbi.nlm.nih.gov/articles/PMC6156217/)

Episodic-Claw への示唆:

- importance は `強さ` だけで決めない
- **弱いが将来効きそうな記憶** を replay 候補に残す

### 2. hippocampal post-learning dynamics は salient / rewarding event を優先しうる

reward や salience が高い文脈は、post-learning rest で優先保持されやすい。

参考:

- [Post-learning hippocampal dynamics promote preferential retention of rewarding events](https://pmc.ncbi.nlm.nih.gov/articles/PMC4777629/)

Episodic-Claw への示唆:

- `manual-save`
- `expand`
- 高 surprise
- task completion に効いた記憶

は importance を押し上げてよい。

### 3. episodic memory はそのまま保存され続けるのではなく gist / semantic に変換される

研究的には、文脈依存の episodic memory は時間とともに gist / semantic 化していく。

参考:

- [Memory Transformation and Systems Consolidation](https://www.cambridge.org/core/journals/journal-of-the-international-neuropsychological-society/article/abs/memory-transformation-and-systems-consolidation/18511C7CFD1671AA7A5F2A3E93BED12D)

Episodic-Claw への示唆:

- 低価値 D0 を永遠に保持しない
- **D1 化済みなら child D0 は replay 対象から落とす**
- さらに古いものは gist に吸収されたら prune 候補へ回す

### 4. 脳っぽい agent memory は multi-timescale / salience-aware に分ける方がよい

最近の hippocampus-inspired agent 系でも、episodic / semantic / salience-aware memory を分ける方向が多い。

参考:

- [HiMeS: Hippocampus-inspired Memory System for Personalized AI Assistants](https://arxiv.org/abs/2601.06152)
- [BMAM: Brain-inspired Multi-Agent Memory Framework](https://arxiv.org/abs/2601.20465)

Episodic-Claw への示唆:

- replay scheduler は **memory selection brain**
- FSRS-inspired state は **timing brain**
- D1 / topics / usefulness posterior は **retrieval brain**

として分けると衝突しにくい。

### 5. FSRS は重要性判定そのものではなく「復習タイミング決定器」として使う方がよい

FSRS の核は `difficulty / stability / retrievability` であって、「何が重要か」までは判定しない。

参考:

- [Free Spaced Repetition Scheduler](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)

Episodic-Claw への示唆:

- FSRS は importance score の後段に置く
- `pseudo-FSRS = importance を通過したものにだけ掛ける`

---

## 問題の分解

いま困っているのは 2 つの別問題。

### A. 何を復習すべきか

これは **importance selection**。

### B. いつ復習すべきか

これは **pseudo-FSRS scheduling**。

この 2 つを混ぜると、

- 重要でない記憶まで due になる
- 重要だが弱い記憶が落ちる
- 古いノイズが scheduler を埋める

ので分離した方がよい。

---

## 提案: Hippocampus-Inspired Importance Score

まず replay 候補を選ぶために、`importance_score` を持つ。

### 入れるべき signal

#### 正の signal

- `is_d1`
- `is_manual_save`
- `is_high_salience_singleton`
- `surprise`
- `expand_count`
- `hit_count`
- `topics_persistence`
- `task_success_association`
- `novelty`
- `weakness_need = 1 - retrievability`

#### 負の signal

- `redundancy_with_parent_d1`
- `age_without_reuse`
- `never_reused`
- `quarantine_like_failure`
- `low_information_density`
- `duplicate_cluster_coverage`

### ざっくり式

```text
importance_score =
  + w1 * is_d1
  + w2 * is_manual_save
  + w3 * is_high_salience_singleton
  + w4 * normalized_surprise
  + w5 * expand_signal
  + w6 * usefulness_signal
  + w7 * topic_persistence
  + w8 * novelty
  + w9 * weakness_need
  - w10 * redundancy
  - w11 * stale_unused_penalty
  - w12 * failure_penalty
```

### 特に重要な考え方

- **弱いから落とす** ではなく、**弱いが重要なら replay 候補に残す**
- **古いから捨てる** ではなく、**古くて役に立たず、gist へ吸収済みなら捨てる**

---

## 提案: Noise Score を別に持つ

`importance_score` だけだと「低 importance = 即 prune」になりやすい。

なので別で `noise_score` を持つ方がよい。

```text
noise_score =
  + redundancy_with_d1
  + age_without_reuse
  + no_expand_no_hit
  + no_topic_persistence
  + low_surprise
  + low_manual_signal
  + failure_or_quarantine
```

### 判断ルール

- `importance high` and `noise low` -> replay 対象
- `importance medium` and `noise low` -> retain するが replay しない
- `importance low` and `noise medium` -> gist 化 / merge 候補
- `importance low` and `noise high` -> tombstone / archive / prune 候補

ここで大事なのは、

- **retain**
- **replay**
- **compress**
- **prune**

を分けること。

---

## 不要や古いノイズ記憶は最終的にどう処分するか

### 推奨 4 段階

#### 1. replay 対象から外す

まず due queue に乗せない。

これは今の Phase 3.1 の方向と合っている。

#### 2. gist / D1 に吸収されたかを確認する

child D0 の意味がすでに parent D1 に入っているなら、

- child D0 の ReplayState は tombstone 化
- raw D0 は keep するにしても cold storage 扱い

でよい。

#### 3. tombstone 化する

完全削除の前に、

- `pruned_reason`
- `canonical_parent`
- `last_considered_at`

だけ残す軽い tombstone にするのが安全。

これで後から復元判断ができる。

#### 4. prune する

条件を満たしたものだけ実削除。

例:

- `redundancy high`
- `age_without_reuse high`
- `not manual-save`
- `not high-salience`
- `covered by D1`
- `never expanded`

を全部満たす時だけ prune。

### 実務的にはこれがよい

- いきなり delete しない
- 先に `replay-off`
- 次に `compress`
- 最後に `prune`

---

## pseudo-FSRS はどう使うか

`pseudo-FSRS` は importance を通過した記憶だけに掛ける。

### 正しい順番

1. importance score
2. noise score
3. candidate class decision
4. pseudo-FSRS due scheduling

### class decision の例

- `importance very high` -> replay
- `importance medium` -> retain, no replay
- `importance low but covered` -> compress
- `importance very low and noisy` -> prune pipeline

### ここでの pseudo-FSRS の役目

- `stability`
- `retrievability`
- `due_at`

を更新するだけ。

重要性の本判定までは持たせない。

---

## OpenClaw に入れるなら次に必要なもの

### 1. importance score の永続化

候補:

- `importance:<episode-id>`
- あるいは `ReplayState` に `Importance` を追加

ただし責務分離のため、本当は別の方がきれい。

### 2. noise / redundancy の計測

最低限ほしい signal:

- D1 parent coverage
- topic persistence
- expand / hit history
- age without reuse
- never-promoted D0 penalty

### 3. prune pipeline

必要な状態:

- `active`
- `cold`
- `compressed`
- `tombstoned`
- `pruned`

### 4. replay candidate gate を `importance_threshold` へ置き換える

今は class ベースで

- D1
- manual-save
- high-salience singleton

に寄せている。

次はそこに

- `importance >= threshold`

を足すべき。

---

## いまの実装に対する評価

いまの Phase 3.1 は悪くない。

むしろ初手としてはかなり安全。

良い点:

- raw D0 全件 replay を避けている
- D1 / manual-save / singleton を優先している
- pseudo-FSRS を timing に限定している

ただし次の限界がある。

- 重要性判定がまだ **class heuristic**
- ノイズ処分がまだ **soft ignore**
- `importance` と `noise` がまだ独立 score になっていない

---

## 次にやると良い順番

1. `importance_score` を導入する
2. `noise_score` を導入する
3. replay gate を class + score にする
4. child D0 -> D1 coverage を使って `compress / tombstone` を入れる
5. 最後に prune policy を入れる

この順番だと安全。

---

## 実装イメージ

```text
EpisodeRecord
  -> importance_score
  -> noise_score
  -> replay_class
  -> replay_state(stability, retrievability, due_at)

decision:
  if noise very high and covered by D1:
      tombstone/prune
  elif importance high:
      replay
  elif importance medium:
      retain without replay
  else:
      cold storage / compress
```

---

## まとめ

たぶん方向はその通り。

**Hippocampus-inspired concept を使うなら、FSRS を重要性判定器にしない** 方がいい。

その代わり、

- hippocampus-inspired **importance selection**
- hippocampus-inspired **salience / weak-memory prioritization**
- systems-consolidation-inspired **gist conversion / pruning**
- FSRS-inspired **review timing**

に分けると、かなり OpenClaw に合う。

一言でいうと、

**「何を残すか」は hippocampus-inspired scoring、  
「いつ復習するか」は pseudo-FSRS、  
「何を捨てるか」は noise/disposal policy**

で分けるのが一番うまい。
