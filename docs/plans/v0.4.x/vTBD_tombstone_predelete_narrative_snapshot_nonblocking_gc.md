# vTBD — Tombstone Pre-Delete Narrative Snapshot (Non-Blocking GC)

> Date: 2026-04-22  
> Last re-check: 2026-05-31
> Status: 📝 PLAN ONLY（未実装 / バージョン未定 / 2026-05-31 現状再調査済み / 週次未使用審査方針へ更新）

---

## 0. 背景

要望:
- Tombstone 削除対象を一括で短く物語化（過去形）してから、削除したい。
- ただし運用安定性（GC詰まり）は維持したい。

本プランは、**「要約は実施するが、削除の必須ゲートにはしない」** 方針で設計する。

---

## 1. 実読ベースの根拠（Source Evidence）

### Evidence 1 — 現在の Tombstone GC は物理削除のみ
- `go/internal/vector/store.go:2337-2381`
  - `RunGarbageCollector()` は `PruneState=="tombstone"` かつ TTL 経過で `os.Remove(rec.SourcePath)` を実行。
  - LLM 生成や要約保存の経路は存在しない。

### Evidence 2 — GC は定期 HealingWorker Pass 4 で走る
- `go/main.go:2197-2205`
  - Pass 4 で Tombstone GC を実行。
  - この経路に外部API依存を直接入れると、メンテ系処理全体の安定性に影響しやすい。

### Evidence 3 — 既存の Narrative パイプラインは非同期再試行前提
- `src/narrative-worker.ts:517-550`
  - `cacheLeaseNext` → 生成 → `cacheAck` / 失敗時 `cacheRetry` の構造。
  - fallback / handoff / retry が前提で、成功保証を即時には置いていない。

### Evidence 4 — 物語スタイルは既存プロンプトで要件に近い
- `src/narrative-worker.ts:1409-1422`
  - 既定で「三人称・過去形・物語文」の制約を持つ。
  - Tombstone 用に同系統テンプレートを使い回せる。

### Evidence 5 — tombstone は既に検索系から除外される
- `go/internal/vector/store.go:1647-1650`
- `go/internal/vector/lexical.go:157-159`
  - `tombstone` は active/lexical から除外済み。
  - よって「要約が失敗したら削除を止める」必然性は低い。

---

## 2. 問題の本質（1文）

> Tombstone 削除前に「記録としての物語化」を残したいが、削除を LLM 成功に強結合すると運用安定性が下がる。

2026-05-31追記: ここでいう tombstone は「一定日数が来たら削除確定」ではない。まず **物語化日付から `tombstoneRetentionDays` の範囲内で一度も使われなかった MD episode を週次で審査し、tombstone 候補に入れる**。その後、一定数が集まった段階で snapshot + 削除へ進む。

---

## 3. 方針オプション

### Option A（推奨）: Non-Blocking Snapshot（要約ベストエフォート + 削除継続）

**概要**
- GC対象を先に収集
- 「tombstone-predelete snapshot」を作成するための専用Go queueへ、最小payloadだけを best-effort で投入（非同期）
- 専用queue投入失敗でも GC は続行

**メリット**
- 運用停止リスクが低い（KISS）
- Go側でGCとsnapshot生成を疎結合にできる
- 記録価値を追加できる

**デメリット**
- まれに要約未保存で削除される可能性がある

---

### Option B: Blocking Gate（要約成功後のみ削除）

**概要**
- 要約保存成功を削除前提条件にする

**デメリット（大）**
- API障害・429・timeoutで GC が滞留しやすい
- メンテ処理の可用性低下

> 本プロジェクトの現行設計（非同期 retry 前提）とは相性が悪い。

---

### Option C: 現状維持

**概要**
- 要約を作らず既存 Tombstone GC のみ維持

**デメリット**
- 削除前の知見保存という運用要件を満たせない

---

## 4. 採用方針（Decision Lock）

- 採用: **Option A（Non-Blocking Snapshot）**
- 非採用: Option B（運用詰まりリスク高）
- 現状維持: Option C は要件未達

---

## 5. 概念設計（アイディア中心）

> この章は **概念定義のみ**。実装手順・ファイル差分・コマンドは意図的に書かない。

### 5.1 コンセプト名
- **Pre-Delete Narrative Snapshot**

### 5.2 コア思想
1. Tombstone は「消える情報」なので、削除前に最小限の意味を残す。
2. ただし削除系の信頼性を落とさないため、記録生成は必須ゲートにしない。
3. 生成物は「短い・過去形・第三者視点」で統一し、後から読んだ人が即理解できる形にする。

### 5.3 概念フロー（論理順序）
1. **候補認識**: 「これから消える集合」を定義する。
2. **意味圧縮**: 集合を短い物語スナップショットへ変換する。
3. **記録保存**: 通常記憶とは識別可能なラベルで保存する。
4. **削除継続**: 保存結果に関わらず、削除の主処理は継続する。
5. **事後可視化**: 「何件残せて、何件削除したか」を運用で追える状態にする。

### 5.4 スナップショットの情報粒度（概念）
- 目的は「完全再現」ではなく「後日説明可能性」。
- 最低限残す情報:
  - 何を消したか（識別子）
  - いつ消したか（時系列）
  - なぜ消したか（Tombstone 条件の要約）
  - 何が重要だったか（1〜2文の過去形 narrative）

### 5.5 バッチ思想
- 1件ごとではなく小束で扱う（ノイズ低減）。
- ただし束が大きすぎると意味が薄まるため、適度に分割する。

### 5.6 命名思想
- 検索で混ざらないように、通常記憶とは分類軸を分ける。
- 「削除前スナップショット」であることが、ラベルだけで分かる命名にする。

---

## 6. 設計原則（Non-Functional Concepts）

1. **安定性優先**: 削除パイプラインの可用性を最優先にする。
2. **疎結合**: 記録生成の失敗が削除停止を引き起こさない構造にする。
3. **可監査性**: 後から「消した理由」と「残した要約」を追跡できること。
4. **低ノイズ**: 運用ログは意思決定に必要な最小情報に絞る。
5. **後方互換**: 既存の recall/replay の意味を変えない。

---

## 7. 検証観点（概念）

### 7.1 正しさ
- 削除対象の意味が、短い narrative として保持されるか。

### 7.2 安定性
- 記録失敗時でも削除主処理が継続するか。

### 7.3 可観測性
- 生成数・失敗数・削除数の関係が運用で説明できるか。

### 7.4 回帰リスク
- 既存の検索品質・再生フローに不要な混入を起こさないか。

---

## 8. 受け入れ基準（Concept AC）

- AC-1: 「削除前に意味を残す」という目的が、運用説明として成立する。
- AC-2: 「要約失敗でも削除は止めない」という方針が明文化される。
- AC-3: 生成物が通常記憶と概念上分離され、混同しない。
- AC-4: 監査視点で「何を消し、何を残したか」を追跡可能である。

---

## 9. リスクと対策（概念）

| リスク | 影響 | 対策 |
|---|---|---|
| snapshot が増えすぎる | 中 | 保存粒度の上限設計と分類分離 |
| 要約失敗時に記録欠落 | 低〜中 | 失敗可視化と再試行方針を定義 |
| GC 処理遅延 | 中 | 削除系と生成系を疎結合に保つ |

---

## 10. この文書の位置づけ

- これは「未定バージョン向けの概念設計書」。
- 次段階で実装版に落とす際、別途「実装計画（ファイル/手順/テスト）」を分離して作る。

---

## 11. 2026-05-31 現状再調査メモ（Current Reality Check）

### 11.1 読み直した現行ファイル

- `go/internal/vector/store.go`
- `go/main.go`
- `go/internal/cache/queue.go`
- `src/narrative-worker.ts`
- `src/narrative-queue.ts`
- `src/rpc-client.ts`
- `go/internal/vector/ruthless_e2e_test.go`

### 11.2 現状からの結論

元の方針 **Option A: Non-Blocking Snapshot** は今でも正しい。
ただし、2026-05-31時点の構成では、**「既存 narrative queue にそのまま乗せる」案は修正が必要**。

理由は3つある。

1. 今後の方針として、新機能の重い処理は Go 側に寄せる。TS は OpenClaw 受付・RPC・fallback の薄い層にする。
2. 既存 `cache.Queue` は `Ack()` 後も `rawText` を保持する。削除対象本文をそのまま queue に載せると、「削除したい本文が cache.db に残る」逆流リスクがある。
3. `NarrativeWorker.saveNarrative()` は `item.source !== "live-turn"` を `cold-start-import` タグに倒すため、`tombstone-predelete` をそのまま入れると誤分類される。

したがって、現時点の推奨は次の形に更新する。

> **Go-owned Tombstone Snapshot Worker** を追加する。
> 週次未使用審査で tombstone 化し、tombstone backlog が一定数たまったら、候補の最小payloadだけを Go 側の専用queueへ best-effort で渡して、snapshot と物理削除を小分けに進める。

---

## 12. 更新後の実装方針（Go-first / Non-Blocking）

### 12.1 新しい責務分担

| 層 | 役割 |
|---|---|
| Go `vector.Store` | 未使用 MD episode の週次審査、tombstone 化、batchable tombstone 候補の列挙、物理削除、DB/index整合性維持 |
| Go `tombstone snapshot` worker | 削除前payloadの短期保持、LLM要約、snapshot保存、失敗時破棄 |
| TS | 必要な場合のみ config/RPC/kill switch 表示。主処理は持たない |

### 12.2 重要な設計変更

旧案:

```text
RunGarbageCollector
→ 既存 narrative queue へ enqueue
→ NarrativeWorker が通常narrativeとして保存
→ GC継続
```

更新案:

```text
HealingWorker Pass 4
→ 週次未使用MD episode審査で、未使用 record を tombstone 化
→ tombstone backlog が `snapshotBatchMinRecords` 以上なら batchable tombstone candidates を Go で列挙
→ SourcePath から bounded excerpt を削除前に読み取り、predelete payload を作る
→ TombstoneSnapshotQueue へ bounded payload を best-effort enqueue
→ enqueue 成否に関係なく tombstone file を物理削除
→ Go background worker が snapshot queue を処理
→ 成功: tombstone-predelete snapshot として保存し、payloadを削除
→ 失敗: retry / dead-letter / TTL破棄。GCは巻き戻さない
```

### 12.2.1 週次未使用エピソード審査（2026-05-31更新）

`tombstoneRetentionDays` は、削除確定日ではなく **未使用判定の観測窓** として扱う。

判定対象は **MD episode のみ**。例:

```text
episode-2025-05-26T15-32-51.502515-000000.md
```

週次スキャンで次の条件をすべて満たした record だけを tombstone 化する。

```text
now - rec.Timestamp >= tombstoneRetentionDays
rec.PruneState == ""
rec.SourcePath ends with ".md"
rec.SourcePath is not under "notes/"      // ep-save manual memory is out of scope
rec.Tags does not contain "manual-save"   // ep-save must never be tombstoned by weekly unused review
rec.RecallShownCount == 0
rec.ExpandCount == 0
rec.Hits == 0                    // 現行 ep-expand path の実更新フィールドも見る
rec.InjectedCount == 0       // 新規追加候補
rec.LastRecalledAt is zero
rec.LastExpandedAt is zero
rec.LastHitAt is zero             // 現行 ep-expand path の実更新フィールドも見る
rec.LastInjectedAt is zero   // 新規追加候補
```

つまり「古いから消す」ではなく、**物語化されてから指定日数の間、ep-recall / ep-expand / 自動注入のどれにも一度も使われなかった自動生成episodeだけを、削除候補箱へ入れる**。

`ep-save` の産物は対象外にする。`ep-save` はユーザーが明示的に「これは覚えて」と保存した手動記憶なので、未使用でも週次整理で tombstone 化しない。実装時は二重ガードにする。

- tag guard: `manual-save` を持つ record は除外
- path guard: `notes/` 配下の record は除外

これは「自動で増える日記棚だけを整理し、手で金庫に入れたメモは触らない」ための境界線。

この段階では物理削除しない。`PruneState="tombstone"` と `TombstonedAt=now` を付けるだけにする。

### 12.2.2 tombstone batch snapshot の保存形式

tombstone が一定数たまったら、Go worker が削除前 snapshot を1つ作る。

保存する semantic memory は、全文ではなく1エピソード1行の短い墓碑銘にする。

```md
- 2025-05-26 15:32:51 — 彼は古い実装方針を検討し、後続の設計判断に使われなかった。
- 2025-05-27 09:10:12 — 彼女は一時的な調査ログを残したが、その後の recall や expand では参照されなかった。
- 2025-05-28 21:04:33 — その作業記録は短期の確認に留まり、長期記憶として再利用されなかった。
```

この snapshot は通常の narrative memory ではなく、`tombstone-predelete` / `gc-snapshot` タグを持つ監査用 semantic memory として保存する。

### 12.2.3 注入履歴の追加が必要

現行 `EpisodeRecord` には `RecallShownCount`, `ExpandCount`, `LastRecalledAt`, `LastExpandedAt` はあるが、自動注入専用の永続フィールドが弱い。

したがって実装時は `EpisodeRecord` に次を追加する。

```go
InjectedCount  int       `json:"injected_count,omitempty" msgpack:"injected_count,omitempty"`
LastInjectedAt time.Time `json:"last_injected_at,omitempty" msgpack:"last_injected_at,omitempty"`
```

`src/retriever.ts` が注入済み episode ID を `recallFeedback.shown` として送っているため、Go 側では `handleRecallFeedback()` で `shown` を保存するだけでなく、`RecordInjected(id, now)` のような record 更新も行う。

`ep-recall` で候補に出ただけの `RecordRecall()` と、実際に context へ入った `RecordInjected()` は分ける。

重要: `src/retriever.ts` には TS-side recall cache があり、cache hit 時は現行コードだと `rpcClient.recallFeedback(...)` を呼ばずに cached result を返す。実装時は、cached result に `episodeIds` がある場合も `RecordInjected()` 相当の feedback を送る。これをしないと、実際に注入された episode が「未使用」と誤判定される。

また、現行 `ep-expand` handler は `Hits` / `LastHitAt` を直接更新しており、`RecordHit()` を呼んでいない。実装時は `handleExpand` から `vstore.RecordHit(params.Slug, now)` を呼ぶ形へ寄せ、`ExpandCount` / `LastExpandedAt` を正規の expand signal にする。移行中の安全策として、未使用判定では `Hits` / `LastHitAt` も見る。

### 12.3 なぜ既存 narrative queue をそのまま使わないか

- `src/narrative-queue.ts:16-34` の `CacheQueueItem` は `rawText` を持つ。
- `go/internal/cache/queue.go:202-214` の `Ack()` は `deleteAfter=false` で rawText を保存する。
- tombstone 削除対象の本文を `rawText` に入れると、ファイルを消しても cache.db に本文が残る。

これは「削除前に意味を残す」目的を超えて、**削除対象の本体を別DBに温存する**動きになり得る。
そのため、tombstone snapshot は専用queueで扱い、成功/失敗後に payload を短期で消す設計にする。

---

## 13. 現行コードに基づく根拠（2026-05-31）

### Evidence A — Tombstone GC は今も物理削除だけ

- `go/internal/vector/store.go:2337-2381`
  - `RunGarbageCollector()` は `PruneState == "tombstone"` かつ TTL 経過の record を集め、`os.Remove(rec.SourcePath)` する。
  - snapshot / enqueue / LLM の処理はまだ無い。

### Evidence B — GC は HealingWorker Pass 4 で10分timeout付き

- `go/main.go:2197-2205`
  - Pass 4 が `context.WithTimeout(..., 10*time.Minute)` で `vstore.RunGarbageCollector(ctxPass4)` を呼ぶ。
  - ここに LLM 成功待ちを直結すると、メンテ処理がAPI状態に引きずられる。

### Evidence C — tombstone は検索から除外済み

- `go/internal/vector/store.go:1648-1651`
  - `isActiveD0Record()` は `tombstone` / `merged` を active D0 から外す。
- `go/internal/vector/lexical.go:157-159`
  - lexical 側も `merged` / `tombstone` を除外する。

### Evidence D — 物理削除後のDB掃除は別経路

- `go/internal/vector/store.go:271-315`
  - `CleanOrphans()` が SourcePath 不在の ghost record を見つけて `Delete(id)` する。
- `go/internal/vector/store.go:820-874`
  - `deleteLocked()` は Pebble の `ep:`, `s2i`, `p2i`, replay key, lexical delete queue を掃除する。

### Evidence E — 手動削除RPCはtombstone GCとは別物

- `go/main.go:2869-2897`
  - `ai.deleteEpisode` は `vstore.DeleteByPath()` を呼ぶ物理/DB削除RPC。
- `go/main.go:2900-2928`
  - `ai.batchDeleteEpisodes` は `DeleteByPaths()` を呼ぶ。これは file watcher 由来の REMOVE batch 向けで、Stat guard がある。

このプランの初期対象は **週次未使用MD episode審査 + tombstone batch snapshot/delete** に限定する。
手動削除RPCへ広げると、UI削除・watcher削除・週次整理が混ざり、監査意味がぼやける。

### Evidence F — 既存 NarrativeWorker はsnapshot専用分類を持っていない

- `src/narrative-worker.ts:1377-1394`
  - 保存タグは `item.source === "live-turn" ? "auto-segmented" : "cold-start-import"`。
  - `tombstone-predelete` を追加しても、このままだと `cold-start-import` 扱いになる。

### Evidence G — recall / expand の痕跡はあるが、注入専用の永続フィールドはまだ弱い

- `go/internal/vector/store.go:45-53`
  - `LastRetrievedAt`, `RecallShownCount`, `ExpandCount`, `LastRecalledAt`, `LastExpandedAt` は存在する。
- `go/internal/vector/store.go:920-957`
  - `RecordRecall()` / `RecordHit()` は recall / expand の痕跡を record に残せる。
- `src/retriever.ts:1017-1029`
  - TS側は実際に注入した episode ID を `recallFeedback.shown` として Go へ送る。
- `go/main.go:2383-2444`
  - ただし現行 `handleRecallFeedback()` は feedback payload を `meta:recall_feedback:*` に保存するだけで、`EpisodeRecord` 本体へ `InjectedCount` / `LastInjectedAt` を反映していない。

このため、週次未使用審査を正確に行うには、注入履歴を record 本体へ永続化する変更が必要。

---

## 14. 実装スケッチ（次段階用）

### 14.1 Go側で追加する候補

新規 package 案:

```text
go/internal/tombstone/
  snapshot_queue.go
  snapshot_worker.go
  snapshot_prompt.go
  snapshot_types.go
```

型のイメージ:

```go
type PredeleteCandidate struct {
  ID           string
  SourcePath   string
  EpisodeTime  time.Time
  TombstonedAt time.Time
  DeletedAt    time.Time
  Tags         []string
  Topics       []string
  Tokens       int
  OneSentence  string // generated short line, not raw full body
  BodyExcerpt  string // bounded, temporary only, e.g. 4-8KB max
  BodyHash     string
}
```

重要: `BodyExcerpt` は永続保存しない。worker 成功/失敗/TTL到達時に削除する。
snapshot 本文には `BodyHash`, record IDs, source paths, tombstone reason, short narrative を残す。

`EpisodeRecord` 自体は本文を持たず、`SourcePath` だけを持つ。したがって、本文の抜粋は **物理削除前** に明示的に読み取る。

```go
func BuildPredeletePayloads(records []vector.EpisodeRecord, maxExcerptChars int) ([]PredeleteCandidate, PayloadStats)
```

- `SourcePath == ""` は本文なし候補として扱い、削除処理はno-op成功のままにする。
- `os.IsNotExist` は本文なし候補として扱い、既存GCと同じく削除成功相当にする。
- 本文読み取り失敗は snapshot payload 欠落として記録するが、GCは止めない。

出力 snapshot は `BodyExcerpt` をそのまま残さず、`EpisodeTime` と `OneSentence` だけを本文に出す。

### 14.2 `vector.Store` の変更方針

`RunGarbageCollector()` に直接 `cache` や `LLM` を import させない。
代わりに、責務を分ける。

候補:

```go
func (s *Store) ListBatchableTombstones(ctx context.Context, now time.Time, limit int) ([]EpisodeRecord, error)
func (s *Store) DeleteTombstoneFiles(ctx context.Context, records []EpisodeRecord) (deleted int, failed int)
```

週次未使用審査用には、別に以下を追加する。

```go
func (s *Store) ListUnusedMDEpisodes(ctx context.Context, now time.Time, retentionDays int, limit int) ([]EpisodeRecord, error)
func (s *Store) MarkEpisodesTombstone(ctx context.Context, records []EpisodeRecord, now time.Time) (marked int, skipped int, err error)
func (s *Store) RecordInjected(id string, at time.Time) error
```

`ListUnusedMDEpisodes()` は `rec.Timestamp` を基準にし、`LastRecalledAt` / `LastExpandedAt` / `LastHitAt` / `LastInjectedAt` がゼロで、かつ `RecallShownCount` / `ExpandCount` / `Hits` / `InjectedCount` がすべてゼロの MD episode だけを返す。

加えて、`manual-save` tag または `notes/` path を持つ record は必ず除外する。`ep-save` は自動生成episodeではなく、ユーザー意思で保存された長期記憶だから。

`main.go` の HealingWorker Pass 4 が orchestration する。

```text
batchable := vstore.ListBatchableTombstones(...)
payloads := tombstone.BuildPredeletePayloads(batchable, maxExcerptChars) // read before delete
snapshotQueue.EnqueueBounded(payloads) // best effort
vstore.DeleteTombstoneFiles(batchable)  // always continue
```

週次審査はこの前段として走る。

```text
weeklyCandidates := vstore.ListUnusedMDEpisodes(now, tombstoneRetentionDays, maxReviewBatchRecords)
marked := vstore.MarkEpisodesTombstone(weeklyCandidates, now)

if tombstone backlog >= snapshotBatchMinRecords:
  batchable := vstore.ListBatchableTombstones(...)
  payloads := tombstone.BuildPredeletePayloads(batchable, maxExcerptChars)
  snapshotQueue.EnqueueBounded(payloads)
  vstore.DeleteTombstoneFiles(batchable)
```

`ListBatchableTombstones()` は「古いから削除」ではなく、**すでに週次審査を通って tombstone 状態になった record のうち、batch snapshot に回せる分だけを取る**。必要なら `minTombstoneAgeHours` を設け、tombstone化直後の即削除を避ける。

これなら `vector` package は storage/index 責務のまま保てる。

### 14.3 保存タグ

snapshot保存時のタグは通常narrativeと混ぜない。

推奨:

```text
tags: ["tombstone-predelete", "gc-snapshot"]
topics: ["tombstone-gc", "predelete-snapshot"]
```

既定のrecall方針は **explicit query only** にする。通常の会話recallでは `tombstone-predelete` を除外し、ユーザーが「削除前スナップショット」「tombstone」「gc-snapshot」系を明示した時だけ検索対象にする。

理由:
- 削除前snapshotは監査メモであり、通常会話の最新narrativeではない。
- `narrative` タグを付けると `scanLatestNarrativeEpisode()` 系の通常continuityと混ざる恐れがある。
- down-rankだけだと、低候補数の時に通常recallへ混ざる余地が残る。

### 14.4 設定

初期は安全側に倒す。

```jsonc
{
  "tombstonePredeleteSnapshot": {
    "enabled": false,
    "weeklyUnusedReviewEnabled": false,
    "unusedReviewRetentionDays": 365,
    "reviewIntervalDays": 7,
    "maxReviewBatchRecords": 200,
    "snapshotBatchMinRecords": 20,
    "minTombstoneAgeHours": 0,
    "maxBatchRecords": 20,
    "maxExcerptCharsPerRecord": 4096,
    "payloadTtlHours": 24,
    "maxAttempts": 3
  }
}
```

KASOUでdry-run確認後に `enabled=true` へ上げる。

#### `tombstoneRetentionDays` との関係

現行UI/configには `tombstoneRetentionDays` があり、TS側では `-tombstone-ttl` として Go sidecar へ渡している。現行Goではこれは **tombstone状態になった後の物理削除TTL** として使われている。

この新設計では、ユーザー視点の `tombstoneRetentionDays` は **物語化日付からの未使用審査窓** として使う方が自然。

ただし実装時に同じ名前をそのまま二重利用すると危ない。実装計画では次のどちらかを選ぶ。

1. 互換重視: 既存 `tombstoneRetentionDays` は legacy physical TTL のまま残し、新しく `unusedReviewRetentionDays` を追加する。
2. UX重視: `weeklyUnusedReviewEnabled=true` の時だけ `tombstoneRetentionDays` を未使用審査窓として扱い、物理削除側は `minTombstoneAgeHours` / `snapshotBatchMinRecords` に分離する。

このプランでは **2を推奨** する。ただし実装前に CHANGELOG / config help / migration note で意味変更を明記する。

> **2026-06-03 追記**: 22.13 で `forgettingEpisodic.{retentionDays,physicalDeleteTtlDays}` を新しいユーザー向け設定として採用したため、この Option 2 は撤回する。`tombstoneRetentionDays` は意味変更せず、`forgettingEpisodic.physicalDeleteTtlDays` が未設定の時だけ参照する後方互換フォールバックに限定する。

---

## 15. 更新後のテスト計画

### 15.1 Go unit tests

1. `ListBatchableTombstones` が tombstone backlog から上限件数だけ返す。
2. `ListBatchableTombstones` が `TombstonedAt.IsZero()` と `PruneState != "tombstone"` を含めない。
3. snapshot enqueue が失敗しても `DeleteTombstoneFiles` が継続する。
4. payload は `maxExcerptCharsPerRecord` を超えない。
5. snapshot worker 成功後に payload が消える。
6. snapshot worker dead-letter / TTL 後に payload が消える。
7. `SourcePath == ""` の record は snapshot本文なし・削除no-op成功として扱う。
8. 既に file が無い record は snapshot本文なし・削除成功相当として扱う。
9. `ListUnusedMDEpisodes` は `rec.Timestamp` が `tombstoneRetentionDays` 未満の record を含めない。
10. `ListUnusedMDEpisodes` は `RecallShownCount > 0` / `ExpandCount > 0` / `InjectedCount > 0` の record を含めない。
11. `ListUnusedMDEpisodes` は `Hits > 0` / `LastHitAt` 非ゼロの record を含めない。
12. `ListUnusedMDEpisodes` は `LastRecalledAt` / `LastExpandedAt` / `LastInjectedAt` が非ゼロの record を含めない。
13. `ListUnusedMDEpisodes` は `.md` 以外、既に `PruneState` がある record、`SourcePath == ""` を含めない。
14. `ListUnusedMDEpisodes` は `manual-save` tag または `notes/` path を持つ ep-save record を含めない。
15. `RecordInjected` が `InjectedCount` と `LastInjectedAt` を更新する。
16. TS recall cache hit 時も injected episode IDs が `RecordInjected` に反映される。
17. `ep-expand` handler が `RecordHit()` を呼ぶ、または `Hits` / `LastHitAt` を未使用判定から除外条件として見る。
18. batch snapshot が `- {date} — {one sentence}` 形式で、全文を保存しない。

### 15.2 Existing regression tests

- `go/internal/vector/ruthless_e2e_test.go:136-147`
  - 既存の「tombstone file が消える」検証は、batchable tombstone deletion の regression として維持する。
  - snapshot enqueue 失敗時も同じ期待値で通す。

### 15.3 TS tests

TS主処理を増やさないなら最小限でよい。

必要になる場合だけ:

1. config schema parse test
2. kill switch env/config test
3. RPC wrapper shape test
4. normal recall が `tombstone-predelete` を除外する test
5. explicit tombstone query だけ snapshot を検索対象にする test
6. `recallFeedback.shown` が Go 側の `RecordInjected` へ渡る integration/smoke test
7. TS-side recall cache hit でも injection accounting が送られる test

---

## 16. 更新後のリスク表

| リスク | 影響 | 更新後の対策 |
|---|---|---|
| 既存 cache queue に削除対象本文が残る | 高 | 既存 narrative queue を生rawText保存先にしない。専用queue + payload TTL + 成功/失敗後削除 |
| snapshot 生成がLLM/API障害で詰まる | 中 | GCとsnapshot workerを疎結合。GCはenqueue失敗でも継続 |
| snapshotが通常narrativeとして混ざる | 中 | `tombstone-predelete` / `gc-snapshot` タグを付け、recall側の扱いを分ける |
| vector package が cache/LLM に密結合する | 中 | `vector.Store` は候補列挙と削除だけ。orchestration は `main.go` / tombstone package |
| agentId が record に無い | 中 | 初期は `agentId="main"` で保存。将来必要なら record metadata に agentId を追加する計画を別立て |
| 手動削除と週次整理が混ざる | 中 | 初期対象は週次未使用MD episode審査 + tombstone batch snapshot/delete のみ。`ai.deleteEpisode` / `ai.batchDeleteEpisodes` は対象外 |
| `ep-save` の手動記憶を誤って整理対象にする | 高 | `manual-save` tag と `notes/` path の二重ガードで `ListUnusedMDEpisodes` から除外する |
| `tombstoneRetentionDays` が削除確定日として誤解される | 高 | `next_due_at` ではなく `weekly unused review` として扱う。期限到達後も recall/expand/inject があれば tombstone 化しない |
| 注入されたepisodeを未使用と誤判定する | 高 | `InjectedCount` / `LastInjectedAt` を追加し、`recallFeedback.shown` から `RecordInjected` を更新する |
| TS recall cache hit の注入が記録されない | 高 | cache hit return 前にも cached `episodeIds` を feedback/RecordInjected へ送る。cache-hit regression test を追加 |
| ep-expand済みepisodeを未使用と誤判定する | 高 | `handleExpand` を `RecordHit()` へ寄せる。移行中は `Hits` / `LastHitAt` も未使用判定の除外条件に入れる |
| 365日分が一気にtombstone化される | 中 | `maxReviewBatchRecords` と `snapshotBatchMinRecords` で週次小分け。summary log のみにする |
| snapshotが全文保存に戻る | 高 | snapshot本文は `- date — one sentence` 形式。raw excerpt は一時payloadのみ、TTL/成功/失敗で破棄 |

---

## 17. 更新後の受け入れ基準

- AC-1: `forgettingEpisodic.enabled=false` では weekly unused-episode forgetting sweep が完全に停止し、既存GC挙動が維持される。
- AC-2: snapshot enqueue / LLM / save が失敗しても、batchable tombstone file の削除は継続する。
- AC-3: 削除対象の全文が `cache.db` に長期保存されない。
- AC-4: snapshot 成功時は `tombstone-predelete` と `gc-snapshot` で通常narrativeと識別できる。
- AC-5: log は件数・elapsed・失敗理由だけに絞り、本文やsecretを出さない。
- AC-6: Go tests で GC 継続・payload TTL・成功後payload削除を確認する。
- AC-7: 通常recallでは `tombstone-predelete` snapshot が出ず、明示的なtombstone監査クエリだけで出る。
- AC-8: 週次未使用審査は、物語化日付 `Timestamp` から `tombstoneRetentionDays` を超えた MD episode のみを見る。
- AC-9: `manual-save` tag または `notes/` path を持つ `ep-save` record は tombstone 化しない。
- AC-10: `ep-recall` / `ep-expand` / 自動注入のどれかが一度でもある episode は tombstone 化しない。
- AC-11: batch snapshot は `- {日付と時刻} — {内容1センテンス}` 形式で、削除対象本文の全文を保存しない。
- AC-12: TS-side recall cache hit 経由の注入も `InjectedCount` / `LastInjectedAt` に反映される。
- AC-13: `ep-expand` は `ExpandCount` / `LastExpandedAt` または `Hits` / `LastHitAt` のどちらかで必ず未使用判定から除外される。
- AC-14: `forgettingEpisodic.{retentionDays,physicalDeleteTtlDays}` と legacy `tombstoneRetentionDays` fallback の関係は config help / CHANGELOG / migration note で明示される。

---

## 18. Phase 1 実装ログ（2026-05-31）

Status: ✅ Phase 1 implemented / deletion and snapshot worker still not implemented.

今回入れた範囲は、週次未使用審査の土台だけ。
物理削除、tombstone化、snapshot生成、設定UI変更はまだ入れていない。

実装内容:

1. `go/internal/vector/store.go`
   - `EpisodeRecord` に `InjectedCount` / `LastInjectedAt` を追加。
   - `RecordInjected(id, at)` を追加。
   - `RecordHit()` を ep-expand の canonical signal として使えるようにし、`Retrievals`, `Hits`, `LastRetrievedAt`, `LastHitAt`, `ExpandCount`, `DirectGoodCount`, `LastExpandedAt` を更新する形に整理。
   - `ListUnusedMDEpisodes(ctx, now, retentionDays, limit)` を追加。これは dry-run friendly な候補列挙のみで、record mutation はしない。
   - `manual-save` tag と `notes/` path を持つ `ep-save` record は除外。

2. `go/main.go`
   - `handleRecallFeedback()` が `shown` episode IDs を `RecordInjected()` へ反映。
   - `handleExpand()` の独自 `UpdateRecord()` を `RecordHit()` 呼び出しへ寄せた。

3. `src/retriever.ts`
   - `recordInjectedEpisodes()` helper を追加。
   - 通常 assemble path と TS-side recall cache hit path の両方で injection accounting feedback を送る。
   - cache hit で実際に context へ再注入された episode が「未使用」と誤判定されないようにした。

4. Tests
   - `go/internal/vector/unused_review_test.go` を追加。
   - `RecordInjected` の永続更新を検証。
   - `ListUnusedMDEpisodes` が recent / recalled / expanded / injected / non-md / manual-save tag / notes path を除外することを検証。
   - `test_phase4_5_retriever_anchor.ts` に TS cache hit injection accounting regression を追加。

検証:

```text
go test ./internal/vector -run "TestRecordInjectedUpdatesEpisodeRecord|TestListUnusedMDEpisodesExcludesUsedAndManualSaveRecords"  ✅
npm run build                                                                                               ✅
npx cross-env EPISODIC_USE_GO_RUN=1 GEMINI_API_KEY= npx tsx test_phase4_5.ts                                ✅
go test ./...                                                                                               ✅
npm test                                                                                                    ✅
```

未実装として残すもの:

- `MarkEpisodesTombstone` 実装
- `ListBatchableTombstones` / `DeleteTombstoneFiles` 分離
- `tombstoneRetentionDays` config/help/migration note の意味整理
- snapshot queue skeleton
- one-sentence semantic snapshot worker
- KASOU dry-run soak

---

## 19. 現時点の判断

このプランは **Phase 1 の土台だけ実装済み**。
次に進むなら、まず別プランまたは本ファイルの続章として、Go package 単位の具体設計を書く。

最初の実装単位は小さくする。

1. `ListBatchableTombstones` / `DeleteTombstoneFiles` 分離
2. `tombstoneRetentionDays` の意味変更を config help / CHANGELOG / migration note に明記
3. `MarkEpisodesTombstone` を dry-run log only で実装
4. snapshot queue skeleton（payload TTLつき）
5. batch one-sentence snapshot worker 実装
6. KASOU soak後に default 有効化判断

---

## 20. Phase 2A + 2B 実装ログ（2026-06-01）

Status: ✅ Phase 2A/2B implemented / no unused-review tombstone mutation yet.

今回入れた範囲は、既存 tombstone GC の内部分離と説明整理だけ。
週次未使用審査による tombstone 化、semantic snapshot worker、実削除条件の新設はまだ入れていない。

実装内容:

1. `go/internal/vector/store.go`
   - `RunGarbageCollector()` の既存処理を `ListBatchableTombstones(ctx, now, limit)` と `DeleteTombstoneFiles(ctx, records)` に分離。
   - `ListBatchableTombstones` は既に `PruneState == "tombstone"` で、`TombstonedAt + TombstoneTTL` を超えた record だけを列挙する。
   - `DeleteTombstoneFiles` は物理ファイル削除のみを担当し、DB hard-delete は従来通り背景 FS watcher に任せる。
   - `RunGarbageCollector()` の外部挙動は維持する。Phase 2A は配管整理であり、未使用 episode を tombstone 化しない。

2. `go/internal/vector/unused_review_test.go`
   - `ListBatchableTombstones` が期限切れ tombstone だけを返すことを検証。
   - `DeleteTombstoneFiles` が期限切れ候補のファイルだけを削除し、TTL未満の tombstone file を残すことを検証。

3. `openclaw.plugin.json` / `CHANGELOG.md`
   - 現時点の `tombstoneRetentionDays` は **既に tombstone 状態の memory を物理削除するまでのTTL** と明記。
   - 将来の週次未使用 episode review window は、有効化前に別途明記する方針に整理。
   - まだ `tombstoneRetentionDays` のランタイム意味は変えていない。

未実装として残すもの:

- weekly unused review scheduler (cron/loop)
- semantic snapshot queue skeleton
- one-sentence semantic snapshot worker
- KASOU dry-run soak
- `MarkEpisodesTombstone` 本実装 (Phase 2C は dry-run log only までで停止)

---

## 22. Phase 3 設計 — Semantic Snapshot Worker（2026-06-01）

Status: 📐 設計のみ。実装前。  
目的: tombstone 確定 → 物理削除前に「memory-that-ive-forgotten」セマンティック記憶を残す。

### 22.1 責務分離（src/AGENTS.md / go/AGENTS.md 準拠）

| 層 | 責務 |
|---|---|
| **Go** | 1回の LLM 呼び出しを実行し raw テキストを返す RPC `episode.snapshot(text, expectedLang)`。ガードレール判断はしない。 |
| **TS** | ループ所有（gemini → ReAsk → gemma → ReAsk）。カスタムガードレール適用。MD ファイル書込。失敗時 debug ログのみ。 |

### 22.2 フェーズ / Attempt

```text
PHASE gemini-main (3.1 Flash Lite):
  attempt 1:  callGo(snapshot, promptA)
              → guard v2
              → pass:  return content
              → fail:  attempt 2 with reask suffix
  attempt 2:  callGo(snapshot, promptA + reaskSuffix)
              → guard v2
              → pass:  return content
              → fail:  fall to gemma

PHASE gemma-main (gemma-4-31b-it):
  attempt 1:  callGo(snapshot, promptA)
              → guard v2
              → pass:  return content
              → fail:  attempt 2 with reask suffix
  attempt 2:  callGo(snapshot, promptA + reaskSuffix)
              → guard v2
              → pass:  return content
              → fail:  debug log + return null

max LLM calls: 4
max wall time: 数秒（6 60s/120s backoff は使わない）
```

### 22.3 カスタムガードレール v2（5 ルール）

```text
1. non_empty       trim後 1文字以上
2. no_cot_prefix   先頭が "Sure,", "Okay,", "First,", "Let me..." 等でない
3. no_refusal      "I cannot", "I'm sorry", "As an AI" 等を含まない
4. one_line        最初の非空行が「- / * / + list item」または「クリーン1行」。
                   複数行・段落分割・preamble/postamble = NG
5. language_match  expectedLang 指定時、detected lang と一致（confidence >= 0.7）

fail時:
  (2)(4)     → ReAsk suffix: "1センテンスだけで、前置き・解説・改行なしの
                              要約のみ出力してください。"
  (3)        → ReAsk suffix: "生成を拒否せず、必ず1センテンスの要約を出力してください。"
  (5)        → ReAsk suffix: "{langName}で出力してください。"
  (1)        → 該当phase失敗扱いで次phaseへ（ReAsk しない）
```

注: list format (^- /^\* /^+ {content}) でもクリーン1行でも受け付ける。  
**worker 側 22.5 で bullet プレフィックスを必ず剥がしてからファイル行を組み立てる**  
（LLM が `- foo` を返しても、ファイル行は `episode-xyz — foo` の形に正規化）。

### 22.4 プロンプト

```text
promptA:
  次のエピソード本文を1センテンスで要約してください。

  - 出力は1行のみ（前置き・解説・改行なし）
  - {langName}で出力
  - 日付や箇条書きの `- ` は不要、要約の本文だけ

  エピソード本文:
  {text}
```

```text
reask (single_line / format):
  1センテンスだけで、前置き・解説・改行なしの要約のみ出力してください。
```

```text
reask (language):
  {langName}で出力してください。
```

### 22.5 出力ファイル構造

```
~/.openclaw/workspace/episodes/
  2026/
    05/
      episode-2026-05-26T15-32-51.502515-000000.md   ← 通常エピソード
      ...
      memory-that-ive-forgotten-1.md  ← 2026/05 の scan (N行)
    06/
      episode-...md
      memory-that-ive-forgotten-2.md  ← 2026/06 の scan (M行)
      ...
  2027/
    01/
      episode-...md
      memory-that-ive-forgotten-1.md  ← 2027年から番号リセット
```

**`semantic/` サブディレクトリは廃止**。`{agentWs}/episodes/{year}/{month}/` 配下に直接配置 (Phase 3.2 で B 採用)。理由: 単一ソース・オブ・トゥルース、FS watcher 挙動が決定的、backup 設定不要、月次レビューフローが自然。

**1ファイル = 1週のscan = N行**。scan ごとにファイルは1個。APPEND ではなく WRITE する（1scan=1ファイルなので毎回新規作成）。

ファイル中身（複数行、tombstoned になったエピソード数そのまま）:

```md
episode-2026-05-26T15-32-51.502515 — 漢字練習の継続日数と苦手字の傾向
episode-2026-06-01T12-18-09.314022 — reindex スクリプトの workflow 整理
```

- ファイル末尾は LF 1個
- 改行コードLF（CRLFではない）
- frontmatter なし、tag なし、`#` ヘッダなし
- 各行のフォーマット: `{original-filename-stem} — {1センテンス要約}`
- ファイルには **絶対に bullet `- ` を付けない**

### 22.5.1 正規化ステップ（worker 側）

LLM 出力は `^- ` / `^* ` / `^+ ` プレフィックス付きでもクリーン1行でもOK（22.3 ルール 4）だが、  
**ファイルに書き込む前に必ずプレフィックスを剥がす**。これで:

- LLM 側に柔軟性（bullet 形式でも plain 形式でも OK）
- ファイル形式は常に一貫（`{stem} — {summary}` の形に統一）
- 二重 bullet (`{stem} — - summary`) のような見た目を防げる

```ts
function stripListPrefix(s: string): string {
  // 先頭の空白を trim してから先頭の bullet / 数字付き list を剥がす
  const trimmed = s.trim();
  return trimmed.replace(/^([-*+]|\d+\.)\s+/, "");
}
```

LLM 出力 → guardrail v2 pass → `stripListPrefix` → ファイル行生成、という順。

### 22.6 番号カウンタ

`state.db` に `meta:tombstone_snapshot_counter:YYYY` を保持。

```text
key:    "meta:tombstone_snapshot_counter:2026"
value:  uint64 を ASCII 文字列で encode (e.g. "42")
op:     state.Store に新規追加する IncrementCounter() メソッド下で atomic
```

#### 22.6.1 BLOCKER 解決: Pebble Merge を使わない

`go/internal/state/store.go` の既存実装は:

- `pebble.Options{}` (Merges 未登録)
- `Get` / `Set` のみ公開、`db.Merge` は呼べない

→ 設計当初の「Pebble Merge で atomic increment」は **現状の state.Store では動かない**。  
go/AGENTS.md「軽量 deterministic fallback を heavy implementation の近くに置く」の精神で、  
`state.Store.IncrementCounter(key string) (uint64, error)` を **新規メソッドとして追加** する:

```go
// 擬似コード
func (s *Store) IncrementCounter(key string) (uint64, error) {
    s.mu.Lock()
    defer s.mu.Unlock()

    val, closer, err := s.db.Get([]byte(key))
    if err != nil && err != pebble.ErrNotFound {
        return 0, fmt.Errorf(...)
    }
    if closer != nil { closer.Close() }

    var n uint64
    if err == nil {
        n, err = strconv.ParseUint(string(val), 10, 64)
        if err != nil { return 0, fmt.Errorf(...) }
    }

    n++
    if err := s.db.Set([]byte(key), []byte(strconv.FormatUint(n, 10)), pebble.Sync); err != nil {
        return 0, fmt.Errorf(...)
    }
    return n, nil
}
```

ポイント:
- **mutex を 1 回の lock で Get+parse+increment+Set 全部包む** → atomic
- 既存 `Get` / `Set` は触らない（後方互換）
- RPC として `episode.snapshotCounterIncrement(year string) (number uint64)` を露出
- TS 側は新しいラッパーで呼び出す（src/AGENTS.md: 「narrow RPC methods with explicit request/response types」）

#### 22.6.2 採番とファイル書込の順序 (2026-06-01 シンプル化反映)

```text
1. lines = []    (loop で 1件ずつ LLM 呼び出し)
2. lines.length > 0 なら:
   a. number = go.snapshotCounterIncrement(year)   # atomic, returns new value
   b. filePath = "episodes/{year}/{month}/memory-that-ive-forgotten-{number}.md"  # month は 2桁ゼロパディング ("06")
   c. fs.mkdir(dir, recursive: true)
   d. fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8")
3. lines.length == 0 なら:
   カウンタを進めず、no-op ログのみ
```

**注 (2026-06-01)**: 旧案 (tmpfile+rename+fsync) は 22.11 SUGGESTION #8 で一旦採用されたが、ユーザー指示で **シンプル writeFile に変更** (22.10 / 22.12 参照)。理由: 「1scan=1ファイル」のシンプルさ優先、partial file が残っても次回 sweep が別番号で新ファイルを作るので欠番 cosmetic のみ。22.11 SUGGESTION #8 の「正式採用」表記は撤回、本セクションが最終決定。

#### 22.6.3 クラッシュ時挙動

| 障害点 | 状態 | 次の scan の挙動 |
|---|---|---|
| (a) 採番直後、(e) writeFile 前に crash | カウンタ N 消費、ファイル無し | 次の scan は N+1 から採番 → N は欠番 |
| (e) writeFile 中 crash | `.tmp` ファイル残骸 | 次の scan は N+1 から採番 → N は欠番 + orphan `.tmp` |
| (g) rename 前に crash | 旧ファイル無し (1scan=1新規) | 次の scan は N+1 から採番 |
| (g) rename 後 (a) 採番前に… あり得ない (a は g の前) | — | — |

欠番は **cosmetic のみ**。data loss なし。orphan `.tmp` は次の scan 開始時に `fs.readdirSync` で掃除（Phase 3.2 実装時 detail）。

- **1scan = 1番号**。scan が 1件以上の行を成功裏に書いた時だけインクリメント。
- 年が変われば自然に 1 から始まる（`2027` のキーは別物として扱う）
- 単一インスタンス前提（Episodic-Claw は 1gateway 1core）。複数 instance 化する場合は RWMutex か sync/atomic 化を再検討。
- gateway クラッシュで番号が飛んでも実害なし（その週のファイルだけ partial / 欠番 cosmetic）

### 22.7 入力テキスト cap

- フロントマター除外
- 先頭 1500 tokens ≒ 6000 chars で truncate
- 超長文エピソードでも LLM 入力サイズを一定に保つ

### 22.8 ワークフロー（Phase 5 完成形）

```text
[trigger]
  週次 scheduler 起動 (e.g., 毎週日曜 03:00)

[query]
  Go: ListUnusedMDEpisodes(now, retentionDays=365, limit)
    age >= 365 days かつ Hits==0 かつ InjectedCount==0 の episode を列挙

[branch]
  candidate = 0  → ログのみ ("no unused episodes this week") で終了
  candidate > 0  → snapshot sweep 実行

[snapshot sweep: 1件ずつ逐次、batch なし]
  lines := []
  for each tombstone candidate:
    1. text 抽出 (frontmatter 除く、先頭 6000 chars cap)
       - os.IsNotExist → ログのみ、buffer にも積まない (delete はステップ 4 で実行)
    2. snapshotEpisode(text, expectedLang)
       - RPC llm.generate (Go へ、context.Context + 30s timeout)
       - gemini-main 1〜2 attempts → gemma-main 1〜2 attempts
       - 5ルール custom guardrail v2
       - ReAsk suffix で最大2回まで自動再生成
       - 4 attempts 全部失敗 → null を返す
       - RPC 30s timeout 超過 → 即時次の phase へ（transport-retry 60s+ は使わない）
    3. success → guardrail pass → stripListPrefix → 行を buffer に積む:
       "{original-filename-stem} — {1センテンス要約}"
    4. failure → debug ログのみ、buffer には積まない
    5. **即時削除** (snapshot 成否に関わらず、その場で source MD を os.Remove)
       - IsNotExist OK、permission error はログのみ
       - これで sweep クラッシュ時も、その件は確実に削除済み

[file write: 全件処理後に1回だけ、シンプル writeFile]
  if lines.length == 0:
    ログのみ ("all LLM calls failed, no file written") で終了
  else:
    year   = formatYear(now)                                    # "2026"
    month  = formatMonth(now)                                   # "06" (2桁ゼロパディング)
    number = go.snapshotCounterIncrement(year)                 # atomic, returns new value
    dir    = "{agentWs}/episodes/{year}/{month}/"
    file   = "memory-that-ive-forgotten-{number}.md"
    fs.mkdir(dir, recursive: true)
    fs.writeFileSync(path, lines.join("\n") + "\n", "utf-8")
    # tmpfile+rename も fsyncSync も **しない** (シンプル優先)
    # 各 sweep は新ファイルを作るので partial file が残っても次回 sweep が上書きしない (欠番になるだけ)
    # クラッシュ時の cosmetic gap は受け入れる

[background]
  既存 FS watcher が:
    - 消えた source MD → EpisodeRecord hard-delete (既存経路そのまま)
    - 新規 memory-that-ive-forgotten-N.md (episodes/{year}/{month}/ 配下) → auto-ingest (Phase 3.2 で B として明示的に受容)
      → 通常エピソードとして取り込まれ、recall 可能になる
      → 別 episode の metadata として PruneState="" なので次週 sweep では再利用されない
```

**snapshot 失敗は物理削除をブロックしない**。  
2次記憶は best-effort。失敗は「失われた記憶」として素直に受け入れる設計。  
**per-item delete (sweep 途中のクラッシュでも各件は確実に削除済み)**。

### 22.9 残課題 / 実装フェーズ

Phase 3.1 (queue skeleton) は **削除**。workflow が直接 sync に list → 1-by-1 LLM → buffer → write するので、間に queue は介在しない。元 design (chapter 12) の TombstoneSnapshotQueue は撤回。queue が必要になった時 (e.g. crash recovery 用 persistence buffer) は別途 design する。

- **Phase 3.0**: `MarkEpisodesTombstone` (write) を `SimulateMarkUnusedAsTombstone` と対で追加。`RunGarbageCollector` からは未配線。 + `state.Store.IncrementCounter` 追加 + RPC `episode.snapshotCounterIncrement` 露出。
- **Phase 3.2**: snapshot worker (RPC `episode.snapshot`、TS 側ガードレール v2 ループ、bullet 正規化、atomic write)。**queue skeleton は作らない**。
- **Phase 4**:   KASOU dry-run soak（`SimulateMarkUnusedAsTombstone` を 1〜2 週間回し、候補ログを眺めて妥当性確認）。
- **Phase 5**:   tombstone 化 ON — 週次 scheduler で `MarkEpisodesTombstone` + snapshot worker + 物理削除を1本に繋ぐ。

### 22.10 確定フルフロー（ユーザー指示まとめ 2026-06-01）

```text
tombstoneRetentionDays: 365
  ↓
[trigger] 毎週 scan 開始 (setInterval 5min tick、日曜 03:00-03:59 window or 7.04日 catch-up)
  ↓
[Phase 1: Mark] Go: MarkEpisodesTombstone → age >= 365 AND Hits==0 AND InjectedCount==0
  ↓
[Phase 2: 候補 0件?]  ├─ 0件 → ログのみ終了
                       └─ N件 → 1件ずつループ
                                  ↓
                       [a] text 抽出 (frontmatter 除く、6000 chars cap)
                            - os.IsNotExist → ログのみ、buffer にも積まない
                       [b] prompt: 「1センテンスに要約してください」
                       [c] LLM 出力: 1センテンス要約のみ
                       [d] 結果フォーマット (worker が自動APPEND):
                           {original-filename-stem} — {1センテンス要約}
                       [e] success → buffer に積む
                           failure → debug ログのみ (buffer は空のまま)
                       [f] **即時削除** (snapshot 成否に関わらず source MD を os.Remove)
  ↓
[Phase 3: file write — 全件 loop 後に1回]
  if lines.length == 0:
    ログのみ → ファイル作らず、番号も進めない
  else:
    year   = formatYear(now)                            # "2026"
    month  = formatMonth(now)                           # "06" (2桁ゼロパディング)
    number = counter.increment(year)                    # 1scan=1番号 (per-year, reset 1)
    path   = "{agentWs}/episodes/{year}/{month}/memory-that-ive-forgotten-{number}.md"
    writeFile(path, lines.join("\n") + "\n", "utf-8")
    # tmpfile+rename なし、シンプル優先
  ↓
[Phase 4: 背景処理]
  FS watcher:
    - 消えた source MD → EpisodeRecord hard-delete
    - 新規 memory-that-ive-forgotten-N.md (episodes/{year}/{month}/ 配下) → 通常エピソードとして auto-ingest (B として受容)
```

**ポイント**:
- 1ファイル = 1週のscan = N行
- LLM は要約のみ生成、フォーマットは worker 側
- **per-item delete (各件は即削除、sweep クラッシュ時も個別に進行)**
- 物理削除は snapshot 結果と独立 (失敗しても止めない)
- 候補 0件 / 全LLM失敗 → ファイル作らず、番号も進めない
- FS watcher 干渉: B (auto-ingest) を受容 → semantic MD も recall 対象になる

### 22.11 コードレビュー指摘の反映ログ（2026-06-01）

`@code-reviewer` による design review の結果 **CHANGES REQUIRED** を受けた。  
1 BLOCKER / 2 HIGH / 2 MED / 2 LOW / 1 suggestion / 2 open Q を以下に反映。

#### BLOCKER

| # | 指摘 | 反映先 |
|---|---|---|
| 1 | `Pebble Merge` は `state.Store` の `pebble.Options{}` で未登録、使えない | 22.6.1 新設: `state.Store.IncrementCounter()` 新メソッド追加、mutex 1 lock で Get+parse+increment+Set |

#### HIGH

| # | 指摘 | 反映先 |
|---|---|---|
| 2 | LLM が `- foo` 返すと worker が `episode-xyz — - foo` 二重 bullet になる | 22.5.1 新設: `stripListPrefix()` でファイル書込前に必ず bullet 剥がし |
| 3 | Phase 3.1 (queue skeleton) は workflow に存在しない → vestigial | 22.9 で Phase 3.1 を削除、3.2 に統合 |

#### MED

| # | 指摘 | 反映先 |
|---|---|---|
| 4 | no_refusal 用 ReAsk suffix が generic で ref ケースに効かない | 22.3 で refusal 専用 suffix 追加: "生成を拒否せず、必ず1センテンスの要約を出力してください。" |
| 5 | 年跨ぎで番号リセット、crash で欠番 cosmetic | 22.6.3 でクラッシュ時挙動を表にして明示、欠番は cosmetic のみと宣言 |

#### LOW

| # | 指摘 | 反映先 |
|---|---|---|
| 6 | 旧 bullet コメント残骸 (line 801 付近) | 22.5 「ファイルには **絶対に bullet `- ` を付けない**」に書き換え |
| 7 | `memory-that-ive-forgotten` 命名が whimsical | **採用しない**。ユーザー指定名なので維持 |

#### SUGGESTION

| # | 指摘 | 反映先 |
|---|---|---|
| 8 | 採番前に tmpfile+rename で atomic write | 22.6.2 で正式採用: `writeFile(.tmp)` → `fsync` → `rename` |

#### OPEN Q

| # | 質問 | 反映先 |
|---|---|---|
| 9 | Go sidecar RPC 失敗時の transport-retry (60s+ × 21m) は週次 sweep に重すぎる | 22.8 RPC timeout = **30s**、超過時即 next phase へ。transport-retry フル スケジュールは使わない |
| 10 | 物理削除前に source MD ファイルが消えてた場合 | 22.8 step 1 で `os.IsNotExist` チェック、ログのみ、buffer 積まない、delete は進める |

#### Positive findings (acknowledged)

- Go/TS 責務分離 (22.1) は `go/AGENTS.md` 「kitchen」/ `src/AGENTS.md` 「reception desk」 双方に整合
- `ListUnusedMDEpisodes` 8-condition フィルタは厳密 (`store.go:2414-2431`)
- クラッシュ時挙動の documentation が充実
- 末尾 LF 1 個の保証が正しい

---

## 21. Phase 2C 実装ログ（2026-06-01）

Status: ✅ Phase 2C implemented (dry-run log only). まだ PruneState を書き換えない。

今回入れたのは、tombstone GC 候補列挙を **「未使用エピソードの週次審査シミュレーション」** として読み取り専用で走らせる経路だけ。
実体の `MarkEpisodesTombstone` (PruneState="tombstone" を書く) は次のフェーズに分離し、Phase 2C では書き込みゼロを保証する。

### 実装内容

1. `go/internal/vector/store.go`
   - 新規 `SimulateMarkUnusedAsTombstone(ctx, now, retentionDays, limit) (int, error)` を追加。
   - 内部で既存の `ListUnusedMDEpisodes(ctx, now, retentionDays, limit)` を呼び、列挙結果に対して:
     - 各候補に `dry-run: would tombstone id=... ageDays=... retentionDays=... source=...` の構造化ログを1行ずつ出す。
     - 1サマリ行 `dry-run: SimulateMarkUnusedAsTombstone count=... retentionDays=... limit=... scanMs=...` を出す。
   - 戻り値は候補数。`PruneState` / `TombstonedAt` / `LastInjectedAt` を含む **どのフィールドも絶対に書き換えない**。
   - `RunGarbageCollector()` からは呼ばない。配線ゼロで、Phase 2C は監査専用機能として独立。
   - context cancellation を `select { case <-ctx.Done(): }` で途中中断可能にし、partial count を返す。

2. `go/internal/vector/unused_review_test.go`
   - `TestSimulateMarkUnusedAsTombstoneIsReadOnly`:
     - eligible / recent / manual-save の3レコードを `BatchAdd` し、`SimulateMarkUnusedAsTombstone` を実行。
     - `count == 1` (eligible のみ) を期待。
     - 3レコード全部について `PruneState==""`, `TombstonedAt.IsZero()`, `LastInjectedAt.IsZero()` を確認し、**dry-run が書き込みゼロ** であることを保証。
   - `TestSimulateMarkUnusedAsTombstoneRespectsContextCancellation`:
     - 5件の候補を `BatchAdd` してから `cancel()` 済み ctx を渡し、`ctx.Err()` が返ることを検証。

### ログ作法 (go/AGENTS.md 準拠)

- hot-path quiet: dry-run サマリは1行、候補ログは1候補1行。
- 構造化フィールド: `id=`, `ageDays=`, `retentionDays=`, `source=`, `count=`, `limit=`, `scanMs=` を固定キーで出す。
- secrets / full path / body / raw prompt は出さない。`source=` は `filepath.Base()` で basename のみ。
- production 既定のログレベル (info) で `dry-run: would tombstone` プレフィックスがそのまま目視可能。

### 検証

- `go test ./internal/vector -run "TestSimulate..."` : pass
- `go test ./...` : pass (full Go suite, 約 17s)
- `go build -o ../dist/episodic-core .` : pass
- `npm run build` / `npm test` / `scripts/reindex.ps1` : Phase 2C 完了後に再走予定

### 残課題 (Phase 3 以降)

- `MarkEpisodesTombstone` の本実装 (PruneState 書き込み版) を `SimulateMarkUnusedAsTombstone` とは別関数として追加。
- 週次 scheduler (sync.Once loop or system cron-like timer) を追加し、`SimulateMarkUnusedAsTombstone` を dry-run 経路として運用、KASOU で 1〜2 週間 soak。
- semantic snapshot queue / one-sentence worker を実装し、tombstone 化 → batch delete → snapshot の流れを1本に繋ぐ。
- default 化の判断は KASOU dry-run soak 結果次第。

---

## 22.12 ユーザー確認ログ（2026-06-01: Phase 3.2 scope 確定）

### 確定事項

#### Q1: scheduler 自動化
- **採用: B 案** — setInterval 5min tick + ウィンドウ判定 + age gate catch-up
- 理由: 再起動耐性、miss-run catch-up、コードの読みやすさ、kill switch 親和性
- 設計詳細:
  - 5min tick interval、`timer.unref()` でプロセス終了をブロックしない
  - 通常発火: `now.getDay() === 0 && now.getHours() === 3` (日曜 03:00-03:59)
  - catch-up: `daysSince >= 7.04` (7日 + 1時間マージン)
  - kill switch: `EPISODIC_DISABLE_SNAPSHOT_WORKER=1` で setInterval 起動させない
  - 多重起動防止: state.db に `sweepInProgress` フラグ
- 「エージェント自身 (LLM) trigger」案は不採用 (日曜3時の決定論的発火は LLM には任せられない)

#### Q2: 出力先
- **採用: `{agentWs}/episodes/{YYYY}/{MM}/`** — 既存エピソードと並列配置 (B 採用)
- `semantic/` サブディレクトリは廃止、既存エピソードと同じ tree に置く
- 理由 (5つ): 単一ソース・オブ・トゥルース、FS watcher 挙動が決定的、backup 設定不要、月次レビューフロー、counter 意味が直感的
- 月は 2桁ゼロパディング ("06") で FS watcher の episode-YYYY-MM-DD 形式と整合
- Go 側 RPC `episode.listTombstonedEpisodes` は `(agentWs)` を受け取り、SourcePath prefix で agentWs 配下に絞り込み

#### Q3: LLM タイムアウト
- **採用: 30s / call** (物語化の per-call HTTP タイムアウトと統一)
- backoff 戦略は別: 物語化は 60-1280s × 6 attempts、snapshot は ReAsk のみで 2 attempts × 2 phase = 4 calls、backoff なし
- 理由: 物語化と完全に同じ戦略だと「日曜3時発火が日曜夜まで終わらない」事故が起きうる

### 追加確定 (ユーザー追加指示 2026-06-01)

#### per-item delete
- snapshot 成否に関わらず、その場で `os.Remove(SourcePath)` を実行
- 1件 = 1回ループ内で完結
- sweep クラッシュ時も、その件は確実に削除済み
- 「2次記憶は best-effort、原エピソードの消失は first priority」

#### write timing: α 案
- 全件 loop 後に1回だけ writeFile
- **tmpfile+rename も fsyncSync も採用しない** (シンプル優先)
- 各 sweep は新ファイル作成なので partial file が残っても次回 sweep が上書きしない (欠番になるだけ)
- クラッシュ時の cosmetic gap は受け入れる

#### FS watcher 干渉: B 受容
- 新規 memory-that-ive-forgotten-N.md (episodes/{year}/{month}/ 配下) は FS watcher に auto-ingest される (阻止しない)
- これは「記憶の忘却の記録」を通常エピソードとして recall 可能にする = 機能として正しい
- 新 MD ファイルは PruneState="" なので翌週 sweep では再利用されない
- exclude_paths 設定や pattern filter 追加は不要
- **tag 付与なし** (現行 FS watcher は ingest 時に tag を付与しない。B 受容 = 通常エピソード化と整合)

#### 出力先パス: B 採用 (2026-06-01 追加決定)
- **採用: `{agentWs}/episodes/{YYYY}/{MM}/memory-that-ive-forgotten-{N}.md`**
- 旧案 `{agentWs}/episodes/semantic/{YYYY}/` を撤回、B 案で確定
- 月は 2桁ゼロパディング ("06")、counter は per-year (1月1日にリセット)
- 「月」は scan が走った月、元エピソードの月ではない

#### language_match 実装: A 採用 (2026-06-01 追加決定)
- **TS 側 Unicode ブロック判定** (軽量、依存追加不要)
- 言語判定のロジック (ja/en 2 言語、frontmatter の lang フィールドから取得):
  - `ja`: テキストが `\u3040-\u30ff` (ひらがな・カタカナ) または `\u4e00-\u9fff` (CJK 漢字) を含む
  - `en`: テキストが `[\x20-\x7e\n]` (ASCII printable + 改行) のみ
  - 未知の言語: 判定スキップ (return true) で ReAsk 救済
- false positive 出ても ReAsk 1回で救済可能、Go 側 RPC 追加のコスト不要
- B 案 (Go sidecar 言語判定 RPC) は YAGNI 違反として不採用

#### M1 rename (2026-06-01)
- `ListAllTombstoned` → `ListAllTombstonedEpisodes` に rename
- 既存 `ListBatchableTombstones` (TTL 超過版) と対称で読みやすい
- Go function 名と RPC 名 (`episode.listTombstonedEpisodes`) も揃う

#### M3 fix (2026-06-01)
- 22.6.2 をシンプル writeFile に更新 (tmpfile+rename+fsync 廃止)
- 22.10/22.12 と整合済み

---

## 22.13 コードレビュー反映ログ (B 採用 + Phase 3.2 scope, 2026-06-01)

`@code-reviewer` による プラン変更 (B 採用 + Phase 3.2 scope 確定) の review。  
CHANGES REQUIRED: 0 BLOCKER / 2 HIGH / 3 MED / 2 LOW / 2 SUGGESTION / 3 OPEN Q

### HIGH

| # | 指摘 | 反映先 |
|---|---|---|
| H1 | Section 13 の `store.go:NNNN` 行番号が Phase 2A/2B リファクタリングでズレている | **保留** (Section 13 は古い調査ログ、Phase 3.2 スコープ外。後でまとめてクリーンアップ) |
| H2 | `language_match` guardrail の `matchesExpectedLang()` 実装詳細が未定義 | 22.12 に **A 採用 (TS 側 Unicode ブロック判定)** を追加、23.4 にコード例を追記 |

### MEDIUM

| # | 指摘 | 反映先 |
|---|---|---|
| M1 | `ListAllTombstoned` 命名が既存 `ListBatchableTombstones` と紛らわしい | 22.12 に **rename 採用**、`ListAllTombstonedEpisodes` に統一、23.1 にも反映 |
| M2 | 端間テスト不足 (フルフロー / 0候補 / lock 再入 / 言語統合 / FS watcher) | 23.6 に **3 ケース追加** (`test_e2e_full_sweep` / `test_e2e_zero_candidates` / `test_e2e_lock_prevents_reentry`) |
| M3 | 22.6.2 (tmpfile+rename) と 22.10/22.12 (シンプル writeFile) の矛盾 | 22.6.2 をシンプル版に書き換え、注記追加で 22.11 SUGGESTION #8 撤回を明記 |

### LOW

| # | 指摘 | 反映先 |
|---|---|---|
| L1 | snapshot ファイルの FS watcher auto-ingest 時の tag 付与ロジック未定義 | 22.12 に **tag 付与なし** (現行 FS watcher の挙動、B 受容と整合) を明記 |
| L2 | `sweepInProgress` stale lock recovery 戦略が未定義 | **Phase 5 保留** (Phase 3.2 では scheduler 内の 24h TTL 自動解放を optional recovery として後付け可能) |

### SUGGESTION

| # | 指摘 | 反映先 |
|---|---|---|
| S1 | `test_file_writer_path` の検証内容を具体的に | 23.6 に `episodes/2026/06/memory-that-ive-forgotten-1.md` 形式を明示 |
| S2 | RPC 名 `snapshotCounterIncrement` vs Go 関数名 `IncrementCounter` の混在 | **保留** (Phase 3.2 実装時に rpc-client.ts の命名規則に合わせて整理) |

### OPEN Q (ユーザー確認済み 2026-06-01)

| # | 質問 | 回答 |
|---|---|---|
| Q1 | language_match 実装方針 | **A 採用** (TS 側 Unicode ブロック判定) |
| Q2 | FS watcher auto-ingest の tag 付与 | **付与なし** (B 受容 = 通常エピソード化) |
| Q3 | `llm.generate` RPC 実装 (既存 `internal/ai` 再利用 vs 新規) | **実装前 read して判断** (Phase 3.2 着手時) |

### POSITIVE (acknowledged)

- パス変更 A→B の全箇所反映の一貫性が非常に高い (7 箇所で `semantic/{year}/` 残骸なし)
- Go/TS 責務分離が `go/AGENTS.md` / `src/AGENTS.md` と完全に整合
- クラッシュ時挙動のドキュメント化 (22.6.3) が充実
- `MarkEpisodesTombstone` の write-lock 下 re-check eligibility が TOCTOU 対策で正しい
- Scheduler 設計の網羅性 (5min tick / window / catch-up / kill switch / run lock / `unref()` の 6 要素)

### 残課題 (Phase 3.2 着手前)

- **Q3 read 必須**: `go/internal/ai` の構造を確認、既存 Gemini/Gemma client の有無
- **H1 後回し**: Section 13 の行番号 cleanup は別タスク
- **L2 後回し**: stale lock recovery は Phase 5 で optional 追加

### 追加決定: 外向き設定名は `forgettingEpisodic` にする (2026-06-03)

#### 結論

- ユーザー向けの config 名では `tombstone` を出さない。
- `openclaw.plugin.json` には `forgettingEpisodic` というネスト設定を追加する。
- 内部 DB 状態名 `PruneState="tombstone"` と既存 Go 関数名は、実装リスクを下げるため当面維持する。
- つまり、**外の服は `forgettingEpisodic`、中のエンジン部品名は `tombstone`** で分ける。

#### 追加予定 schema

```json
"forgettingEpisodic": {
  "type": "object",
  "description": "Controls the weekly unused-episode forgetting sweep. It finds old Markdown episodes that have not been recalled, expanded, or auto-injected, writes a one-line memory-of-forgetting snapshot, then removes the original episode file. Default: disabled.",
  "additionalProperties": false,
  "properties": {
    "enabled": {
      "type": "boolean",
      "default": false,
      "description": "Enable the weekly forgetting sweep. Default: false. If false, the scheduler does not mark, summarize, or delete unused episodes."
    },
    "retentionDays": {
      "type": "integer",
      "minimum": 1,
      "default": 365,
      "description": "How many days an ordinary Markdown episode must remain unused before it becomes eligible for forgetting. Default: 365. Manual saves and notes are excluded."
    },
    "physicalDeleteTtlDays": {
      "type": "integer",
      "minimum": 1,
      "default": 14,
      "description": "Compatibility TTL for records that are already in the internal tombstone state before their source files are physically removed. Default: 14. This replaces the older top-level tombstoneRetentionDays name."
    }
  }
}
```

#### Runtime mapping

| User-facing config | Internal meaning | Default |
|---|---|---|
| `forgettingEpisodic.enabled` | Weekly unused-episode forgetting sweep ON/OFF | `false` |
| `forgettingEpisodic.retentionDays` | Unused review window: old episode age required before marking | `365` |
| `forgettingEpisodic.physicalDeleteTtlDays` | Internal tombstone physical delete TTL | `14` |

#### Backward compatibility

`tombstoneRetentionDays` はすぐ削除しない。次の優先順位で読む:

```ts
const physicalDeleteTtlDays =
  rawConfig?.forgettingEpisodic?.physicalDeleteTtlDays
  ?? rawConfig?.tombstoneRetentionDays
  ?? 14;
```

`openclaw.plugin.json` 上では `tombstoneRetentionDays` を `[DEPRECATED]` 表記に変更し、説明で `forgettingEpisodic.physicalDeleteTtlDays` への移行を案内する。

#### Safety rule

`forgettingEpisodic.enabled === false` の場合、以下は一切実行しない:

- weekly scheduler の sweep 実行
- unused episode の tombstone 化
- LLM snapshot 生成
- original episode file の物理削除

`EPISODIC_DISABLE_SNAPSHOT_WORKER=1` は緊急停止用 kill switch として残す。優先順位は env kill switch が最上位:

```text
EPISODIC_DISABLE_SNAPSHOT_WORKER=1 → always OFF
forgettingEpisodic.enabled=false   → OFF
forgettingEpisodic.enabled=true    → ON
```

移行期間中に旧案の `tombstonePredeleteSnapshot` が残っている場合も、`forgettingEpisodic` を優先する。

```text
forgettingEpisodic が定義済み       → forgettingEpisodic.enabled を使う
forgettingEpisodic が未定義         → tombstonePredeleteSnapshot.enabled を legacy fallback として見る余地あり
両方が未定義                       → default OFF
```

ただし、`openclaw.plugin.json` に載せる正式なユーザー向け設定は `forgettingEpisodic` のみとする。14.4 の `tombstonePredeleteSnapshot` は古い内部検討案であり、実装時は削除するか、READMEに出さない expert-only 内部設定へ格下げする。

#### Naming boundary

- UI / config / README / user-facing logs: `forgetting`, `forgettingEpisodic`
- Go DB state / low-level vector store: `tombstone`, `PruneState="tombstone"`
- TS module filenames are allowed to remain `snapshot-*` because they describe the semantic snapshot step, not the feature brand.

#### Required config tests

実装時に最低限追加する config test:

| テスト | 期待 |
|---|---|
| `test_config_forgetting_default_off` | `forgettingEpisodic` 未設定なら `enabled=false`, `retentionDays=365`, `physicalDeleteTtlDays=14` |
| `test_config_forgetting_overrides_legacy_ttl` | `forgettingEpisodic.physicalDeleteTtlDays` が `tombstoneRetentionDays` より優先される |
| `test_config_legacy_tombstone_retention_fallback` | 新設定なし・旧 `tombstoneRetentionDays=30` なら `physicalDeleteTtlDays=30` |
| `test_config_env_kill_switch_precedence` | `EPISODIC_DISABLE_SNAPSHOT_WORKER=1` は `forgettingEpisodic.enabled=true` より強い |

---

## 23. Phase 3.2 実装計画 (Semantic Snapshot Worker)

### 23.1 Phase 3.2 スコープ

#### 追加 Go 側
| 追加 | 役割 | ファイル |
|---|---|---|
| `ListAllTombstonedEpisodes(ctx, agentWs, limit)` | TTL 無視の tombstone 全件列挙 (SourcePath prefix filter で agentWs 配下のみ) | `go/internal/vector/store.go` |
| `episode.listTombstonedEpisodes` RPC | agentWs を受け取り、SourcePath prefix で絞った tombstone リストを返す | `go/main.go` |
| `llm.generate` RPC | model 指定で 1回 HTTP → text 返却、30s context timeout | `go/main.go` (既存 `internal/ai` 再利用、なければ thin caller 新設) |

#### 追加 TS 側
| ファイル | 役割 |
|---|---|
| `src/snapshot-scheduler.ts` | setInterval 5min tick + window + age gate + run lock + kill switch |
| `src/snapshot-worker.ts` | Phase 1-3 メインループ (mark → list → 1件ずつ → write) |
| `src/snapshot-guardrail.ts` | 5ルール v2 + 専用 ReAsk suffix (non_empty / no_cot / no_refusal / one_line / language_match) |
| `src/snapshot-file-writer.ts` | counter 採番 + シンプル writeFile (tmpfile+rename なし) |
| `src/episode-extract.ts` | `SourcePath` から frontmatter 除外で先頭 ~6000 chars 抽出 |
| `src/rpc-client.ts` 追記 | `episode.markEpisodesTombstone` / `episode.listTombstonedEpisodes` / `episode.snapshotCounterIncrement` / `llm.generate` |
| `src/index.ts` 追記 | `new SnapshotScheduler().start()` を `init` 内に配線 |
| `src/snapshot-*.test.ts` | ユニット + integration (mock LLM レスポンスで guardrail 各ルール検証) |

### 23.2 Scheduler 設計

```ts
// src/snapshot-scheduler.ts (概要)
const CHECK_INTERVAL_MS = 5 * 60 * 1000;     // 5分
const TARGET_DAY = 0;                         // 0 = 日曜
const TARGET_HOUR = 3;                        // 03:00-03:59
const CATCHUP_THRESHOLD_DAYS = 7.04;          // 7日 + 1時間マージン

class SnapshotScheduler {
  start() {
    if (getEnvVal("EPISODIC_DISABLE_SNAPSHOT_WORKER") === "1") {
      logDebug("snapshot scheduler disabled by env kill switch");
      return;
    }
    if (!(this.config?.forgettingEpisodic?.enabled ?? false)) {
      logDebug("snapshot scheduler disabled by forgettingEpisodic.enabled=false");
      return;
    }
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }
  stop() { /* clearInterval */ }
  private async tick() {
    const now = new Date();
    const lastRun = await this.getLastRunAt();
    const daysSince = lastRun ? (now.getTime() - lastRun) / 86_400_000 : Infinity;
    const inWindow = now.getDay() === TARGET_DAY && now.getHours() === TARGET_HOUR;
    const dueByAge = daysSince >= CATCHUP_THRESHOLD_DAYS;
    if (!inWindow && !dueByAge) return;
    if (await this.acquireRunLock()) {
      try {
        await runSnapshotSweep(inWindow ? "scheduled" : "catchup");
        await this.setLastRunAt(now.getTime());
      } finally {
        await this.releaseRunLock();
      }
    }
  }
}
```

### 23.3 Worker ループ (per-item delete)

```ts
// src/snapshot-worker.ts (概要)
async function runSnapshotSweep(reason: "scheduled" | "catchup"): Promise<SweepResult> {
  // Phase 1: Mark (Go RPC)
  const marked = await go.markEpisodesTombstone(agentWs, retentionDays, limit);
  if (marked === 0) return { processed: 0, file: null };

  // Phase 2: List
  const tombstones = await go.listTombstonedEpisodes(agentWs, limit);
  if (tombstones.length === 0) return { processed: 0, file: null };

  // Phase 3: 1件ずつループ
  const lines: string[] = [];
  for (const tomb of tombstones) {
    const text = await extractText(tomb.sourcePath, { cap: 6000 });
    const summary = await snapshotEpisode(text, tomb.expectedLang);
    if (summary !== null) {
      lines.push(`${stripMdExt(path.basename(tomb.sourcePath))} — ${summary}`);
    }
    // 即時削除 (snapshot 成否に関わらず)
    await deleteSourceFile(tomb.sourcePath);
  }

  // Phase 4: writeFile
  if (lines.length === 0) {
    return { processed: 0, file: null };
  }
  const path = await writeMemoryFile(agentWs, lines);  // {agentWs}/episodes/{YYYY}/{MM}/memory-that-ive-forgotten-{N}.md
  return { processed: lines.length, file: path };
}
```

### 23.4 Guardrail v2 (5ルール)

```ts
// src/snapshot-guardrail.ts (概要)
function checkGuardrailV2(text: string, expectedLang: string): GuardrailResult {
  const t = text.trim();
  if (t.length === 0)        return { ok: false, rule: "non_empty" };
  if (/^(Sure|Okay|First|Let me)/i.test(t)) return { ok: false, rule: "no_cot_prefix", reask: "1センテンスだけで、前置き・解説・改行なしの要約のみ出力してください。" };
  if (/(I cannot|I'm sorry|As an AI)/i.test(t)) return { ok: false, rule: "no_refusal", reask: "生成を拒否せず、必ず1センテンスの要約を出力してください。" };
  if (t.split("\n").filter(l => l.trim()).length !== 1) return { ok: false, rule: "one_line", reask: "1センテンスだけで、前置き・解説・改行なしの要約のみ出力してください。" };
  if (!matchesExpectedLang(t, expectedLang)) return { ok: false, rule: "language_match", reask: `${expectedLang}で出力してください。` };
  return { ok: true };
}

// 言語マッチ判定 (A 採用: TS 側 Unicode ブロック判定、軽量、依存追加不要)
function matchesExpectedLang(text: string, expectedLang: string): boolean {
  switch (expectedLang) {
    case "ja": return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
    case "en": return /^[\x20-\x7e\n]*$/.test(text.trim());
    default:   return true;  // 未知の言語は判定スキップ、ReAsk 救済に任せる
  }
}
```

### 23.5 LLM チェーン (gemini-main → gemma-main)

```ts
// src/snapshot-guardrail.ts (続き)
async function snapshotEpisode(text: string, expectedLang: string): Promise<string | null> {
  const chain = [
    { model: "gemini-main", maxAttempts: 2 },
    { model: "gemma-main",  maxAttempts: 2 },
  ];
  for (const phase of chain) {
    let lastFailure: GuardrailResult | null = null;
    for (let attempt = 0; attempt < phase.maxAttempts; attempt++) {
      const prompt = attempt === 0 ? buildPrompt(text, expectedLang) : buildReask(text, expectedLang, lastFailure!);
      const result = await go.llmGenerate(phase.model, prompt, { timeoutMs: 30_000 });
      if (result.timedOut || result.text === null) {
        lastFailure = { ok: false, rule: "non_empty" };
        continue;
      }
      const check = checkGuardrailV2(result.text, expectedLang);
      if (check.ok) {
        return stripListPrefix(result.text);   // "- " / "* " / "+ " / "1. " を trim
      }
      lastFailure = check;
    }
  }
  return null;  // 4 attempts 全部失敗
}
```

### 23.6 テスト計画

| テスト | 検証内容 |
|---|---|
| `test_scheduler_window` | 日曜 03:00 → inWindow=true, catch-up=false |
| `test_scheduler_catchup` | 8日前 lastRun → catch-up=true |
| `test_scheduler_kill_switch` | `EPISODIC_DISABLE_SNAPSHOT_WORKER=1` → setInterval 起動せず |
| `test_scheduler_config_disabled` | `forgettingEpisodic.enabled=false` → setInterval 起動せず |
| `test_scheduler_lock` | sweep 中の tick → 2個目 acquireLock 失敗 |
| `test_worker_peritem_delete` | snapshot 失敗するモック → その source は削除される |
| `test_worker_peritem_delete_enoent` | 最初から source 無い → ログのみ、次へ |
| `test_worker_empty_buffer` | 全件 LLM 失敗 → ファイル作らず、番号も進めない |
| `test_guardrail_non_empty` | 空文字 → rule="non_empty" |
| `test_guardrail_no_cot_prefix` | "Sure, ..." → rule="no_cot_prefix" + ReAsk suffix |
| `test_guardrail_no_refusal` | "I cannot ..." → rule="no_refusal" + 専用 ReAsk suffix |
| `test_guardrail_one_line` | 2行出力 → rule="one_line" + ReAsk suffix |
| `test_guardrail_language_match` | 期待 lang=ja で英語出力 → rule="language_match" + ReAsk suffix |
| `test_strip_list_prefix` | "- foo" / "* bar" / "1. baz" → "foo" / "bar" / "baz" |
| `test_llm_timeout_falls_to_next_phase` | 30s timeout → gemini 即 next phase へ |
| `test_file_writer_counter` | year 跨ぎ → 2026, 2027 別 counter、最初=1 |
| `test_file_writer_path` | 出力先 `{agentWs}/episodes/{YYYY}/{MM}/` に置かれること (B 採用)、`episodes/2026/06/memory-that-ive-forgotten-1.md` 形式 |
| `test_file_writer_format` | 行フォーマット `"{stem} — {summary}"`、末尾 LF 1 個 |
| `test_e2e_full_sweep` | mock Go RPC + mock LLM で mark → list → LLM chain → writeFile まで通す、`memory-that-ive-forgotten-1.md` 1個作成 + 全 source 削除 |
| `test_e2e_zero_candidates` | scheduler 起動したが候補 0件 → no-op ログのみ、ファイル作らず、counter 進めない |
| `test_e2e_lock_prevents_reentry` | sweep 中に次の tick → 2個目 acquireLock 失敗、sweep は1回だけ実行 |
| `test_config_backward_compat` | `forgettingEpisodic.physicalDeleteTtlDays ?? tombstoneRetentionDays ?? 14` の優先順位を検証 |

### 23.7 Phase 5 配線プレビュー

Phase 3.2 完了後、Phase 5 で:

1. `src/index.ts` の `init` 内で `new SnapshotScheduler().start()` を呼ぶ
2. scheduler は `EPISODIC_SNAPSHOT_OUTPUT_DIR` 環境変数 (将来用) を尊重 (Phase 3.2 では `{agentWs}/episodes/{YYYY}/{MM}/` ハードコード)
3. 初回起動時: `lastRunAt` が無いので `daysSince = Infinity` → catch-up で即発火
4. KASOU で 1〜2 週間 dry-run soak して候補ログを眺める
5. default 化の判断は soak 結果次第

### 23.8 残課題 (Phase 3.2 → Phase 5 まで)

- `episode.listTombstonedEpisodes` Go 側実装 (Phase 3.2)
- `llm.generate` Go 側実装 — 既存 `internal/ai` の Gemini/Gemma 呼び出しを再利用、なければ新規 thin caller (Phase 3.2)
- scheduler の `sweepInProgress` フラグ: state.db 内の `meta:tombstone_sweep_in_progress:1` を acquire/release (Phase 3.2)
- KASOU dry-run: `EPISODIC_DISABLE_SNAPSHOT_WORKER=1` で disable した状態で `SimulateMarkUnusedAsTombstone` を 1〜2 週間 soak (Phase 4)
- 出力先の `EPISODIC_SNAPSHOT_OUTPUT_DIR` 環境変数オーバーライド (Phase 5 配線時)

## 24. Phase 4 結果 (2026-06-04 dry-run probe)

### 24.1 実行方法

v0.4.34a-pre.release.2 で追加した `episode.simulateMarkUnusedAsForgotten` RPC を KASOU で 1 回叩いた。`EpisodicCoreClient` を経由すると新規 Go sidecar を spawn してしまうため、共有 socket-address ファイル `/tmp/episodic-claw-socket.addr` を直接読んで既存 sidecar に接続するワンショット Node.js スクリプト `/tmp/episodic-dryrun-probe.mjs` を KASOU 上に配置して実行。プロトコルは newline-delimited JSON-RPC 2.0。`src/rpc-client.ts:343` の `readline` 実装と一致。

`forgettingEpisodic.enabled=true`, `retentionDays=30`, `physicalDeleteTtlDays=14` という KASOU の現 config そのまま + env var `EPISODIC_DISABLE_SNAPSHOT_WORKER=1` (scheduler 停止維持) で実行。

### 24.2 結果

RPC レスポンス: `count=18, retentionDays=30, limit=500, elapsedMs=82`, クライアント全体 109ms。Go 内部ログに 18 行の `dry-run: would forgotten id=... ageDays=... source=...` 構造化ログ。候補は ageDays 51〜65 に分布。`notes/` 配下ゼロ、`manual-save` ゼロ。`agent-*.md` `openclaw-*.md` `session-*.md` `model-*.md` `plugin-*.md` `episode-*.md` `pneuma-sync-status-check.md` `memory-recall-and-indexing.md` の 18 件。Episodic-Claw が長期保持していた reference 系ナレッジ。

### 24.3 解釈

KASOU 運用データ (~1年) では 365 日閾値だと候補ゼロ近辺、30 日閾値だと 18 件出る。`enabled=true` のままだと次の日曜 03:00 に weekly sweep 候補になることは確認済み。実 Phase 5 起動前に「30 日だと reference 系が消える」「60 日 / 90 日に伸ばしたい」等の判断が要る。あるいは `enabled=false` に戻して design 凍結することもできる。

### 24.4 Phase 5 起動の判断ポイント

- 「reference 系 18 件は消していい」と判断 → `retentionDays` を 30-90 で確定 → `enabled=true` 維持 + env var `=0` → 次の日曜 03:00 に Phase 5 sweep。
- 「reference 系は守りたい」 → `forgettingEpisodic.retentionDays` を 180 まで伸ばす or `physicalDeleteTtlDays=30` で絞る or ep-save で `notes/` 待避後に再 dry-run。
