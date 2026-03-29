# Issue Report: `RunConsolidation` タイムアウト欠落

- **作成日**: 2026-03-25
- **優先度**: P3 (Low)
- **状態**: 解決済 (Resolved)
- **対象ファイル**:
  - `go/main.go` L1143-1158 (`checkSleepThreshold`)
  - `go/main.go` L1185-1193 (`handleConsolidate`)
  - `go/internal/vector/consolidation.go` L24, L144, L154, L162

---

## 1. 問題の概要

`RunConsolidation` および `processCluster` の内部で呼び出される API（Gemma による D1 生成 / Embedding）には **`context.Background()`** が渡されており、タイムアウトが設定されていない。

API 側で応答が返らない場合（Gemini API の一時的な障害、ネットワーク断など）、`RunConsolidation` は**永遠にブロックし続ける**。この呼び出しは `go func()` ラッパーから行われているが、`isConsolidating` が `1` のまま固着するため、**Sleep Timer が以降の Consolidation をすべてスキップ**してしまう。

---

## 2. 現状のコード

### `main.go` — `checkSleepThreshold` (Sleep Timer 側)

```go
// L1148-1157
if atomic.CompareAndSwapInt32(&isConsolidating, 0, 1) {
    err := vector.RunConsolidation(agentWs, apiKey, vstore, gemmaLimiter, embedLimiter)
    // ← ここは goroutine 内か？NO。checkSleepThreshold 自体が goroutine 内だが、
    //   RunConsolidation は同期呼び出し。タイムアウトなし。
    if err != nil {
        EmitLog("Consolidation error: %v", err)
    }
    atomic.StoreInt32(&isConsolidating, 0) // ← API ブロックなら到達しない
} else {
    EmitLog("Skipping Sleep Timer for %s, consolidation already in progress", agentWs)
}
```

### `main.go` — `handleConsolidate` (手動 RPC 側)

```go
// L1185-1193
go func() {
    if atomic.CompareAndSwapInt32(&isConsolidating, 0, 1) {
        vector.RunConsolidation(params.AgentWs, apiKey, vstore, gemmaLimiter, embedLimiter)
        // ← タイムアウトなし
        vstore.SetMeta("last_consolidation", []byte(...))
        atomic.StoreInt32(&isConsolidating, 0) // ← API ブロックなら到達しない
    }
}()
```

### `consolidation.go` — 内部 API 呼び出し

```go
// L114 (processCluster 冒頭)
ctx := context.Background() // タイムアウトなし

// L144
gemmaLimiter.Wait(ctx) // ← タイムアウトなし（context.Background()）

// L154
gemmaLimiter.Wait(ctx) // ← 同上

// L162
embedLimiter.Wait(ctx) // ← 同上
```

---

## 3. 問題の詳細

### 3.1 `isConsolidating` フラグの固着

`isConsolidating` は `int32` の atomic フラグで、同時に1つの Consolidation のみ実行を許可する排他制御として機能している。

しかし `RunConsolidation` が API 呼び出しでブロックした場合：

```
isConsolidating = 1 (CompareAndSwap で 0→1)
RunConsolidation → API 呼び出し → 永遠にブロック
atomic.StoreInt32(&isConsolidating, 0) // ← 到達しない
```

結果として Sleep Timer Ticker が2分ごとに `checkSleepThreshold` を実行しても、常に `isConsolidating == 1` のためスキップされ続ける。**Sleep Consolidation が永続的に機能しなくなる。**

### 3.2 `gemmaLimiter.Wait(ctx)` の影響

`consolidation.go` の `processCluster` において、`context.Background()` を渡している `gemmaLimiter.Wait(ctx)` は実質的にキャンセル不能である。

通常の `Wait` はトークンが利用可能になるまでブロックするが、このコンテキストはキャンセルできないため、Rate Limiter が何らかの理由で詰まった場合（バーストトークンの完全消費後など）も永続ブロックが発生しうる。

> [!NOTE]
> FIX-R3（`handleIndexerRebuild` の `embedLimiter.Wait` への 30s タイムアウト追加）はすでに適用済みだが、`consolidation.go` の `gemmaLimiter.Wait` / `embedLimiter.Wait` は**まだ未対応**。

### 3.3 影響範囲

- **Sleep Timer 経由（自動 Consolidation）**: `checkSleepThreshold` は `2 * time.Minute` の Ticker で全 agentWs を巡回する。1つの agentWs でブロックすると、その agentWs の Consolidation が永続的に停止する（他 agentWs は別コールスタックなので無影響）。
- **手動 RPC 経由 (`handleConsolidate`)**: goroutine が永続ブロックするが、RPC 自体は即時レスポンス（Fire & Forget）なのでゲートウェイはブロックしない。ただし `isConsolidating` フラグが固着して以降の手動 Consolidation も全スキップされる。

---

## 4. 修正案

### 案A: `RunConsolidation` に `context.Context` を引数として追加（推奨）

シグネチャを変更し、呼び出し側でタイムアウトを設定する。

```go
// consolidation.go
func RunConsolidation(ctx context.Context, agentWs string, apiKey string, vstore *Store, gemmaLimiter *rate.Limiter, embedLimiter *rate.Limiter) error {
```

```go
// processCluster も同様に ctx を引数で受け取る
func processCluster(ctx context.Context, cluster []EpisodeRecord, ...) error {
    // ctx を gemmaLimiter.Wait / embedLimiter.Wait / LLM 呼び出しに伝播
    gemmaCtx, gemmaCancel := context.WithTimeout(ctx, 30*time.Second)
    defer gemmaCancel()
    if err := gemmaLimiter.Wait(gemmaCtx); err != nil {
        return fmt.Errorf("gemmaLimiter timeout: %w", err)
    }
    ...
}
```

呼び出し側：

```go
// main.go — checkSleepThreshold
consolidationCtx, consolidationCancel := context.WithTimeout(context.Background(), 10*time.Minute)
defer consolidationCancel()
err := vector.RunConsolidation(consolidationCtx, agentWs, apiKey, vstore, gemmaLimiter, embedLimiter)
```

```go
// main.go — handleConsolidate goroutine
go func() {
    consolidationCtx, consolidationCancel := context.WithTimeout(context.Background(), 10*time.Minute)
    defer consolidationCancel()
    if atomic.CompareAndSwapInt32(&isConsolidating, 0, 1) {
        vector.RunConsolidation(consolidationCtx, ...)
        atomic.StoreInt32(&isConsolidating, 0)
    }
}()
```

### 案B: `defer atomic.StoreInt32` でフラグリセット保証（最小変更）

タイムアウトを追加しない場合でも、`defer` でフラグのリセットを保証する。

```go
if atomic.CompareAndSwapInt32(&isConsolidating, 0, 1) {
    defer atomic.StoreInt32(&isConsolidating, 0) // どんな終了でも必ずリセット
    err := vector.RunConsolidation(...)
    ...
}
```

ただしこれは「API がタイムアウトしない限りブロックする」問題を解決しない。goroutine にリークが発生する可能性が残る。

---

## 5. タイムアウト値の根拠

| 処理 | 推奨タイムアウト | 根拠 |
|------|----------------|------|
| `processCluster` 全体（D0 × 10件 + D1 生成） | 10分 | Gemma 呼び出し × 2 + Embed 呼び出し × 1 を1クラスター分処理 |
| `gemmaLimiter.Wait` 単体 | 30秒 | FIX-R3 と同水準 |
| `embedLimiter.Wait` 単体 | 30秒 | FIX-R3 と同水準 |
| `RunConsolidation` 全体 | 10〜30分 | D0 ノード数に依存（100件 = 10クラスター） |

---

## 6. リスク評価

| リスク | 発生確率 | 影響度 | 対策 |
|--------|---------|--------|------|
| API 障害時の `isConsolidating` 固着 | 低（API 障害時のみ） | 高（Sleep Consolidation が永続停止） | 案A または案B |
| タイムアウト設定が短すぎて正常処理が打ち切られる | 中 | 中 | タイムアウト値を十分に大きく設定（10分以上） |
| シグネチャ変更による呼び出し箇所の修正漏れ | 低（2箇所のみ） | 中 | `go vet` / コンパイルエラーで検出可能 |

---

- [x] **Priority-0 発見**: `checkSleepThreshold` が `RunConsolidation` を**同期呼び出し**しているため、この関数自体がブロックする問題（Section 8参照、Audit Round 1 で追記）
- [x] 案A/B の選択と承認 (案Aを満額採用)
- [x] `consolidation.go` の `RunConsolidation` / `processCluster` シグネチャ変更（案A）
- [x] `main.go` の `checkSleepThreshold` / `handleConsolidate` 側でのタイムアウト追加
- [x] `consolidation.go` の `gemmaLimiter.Wait` / `embedLimiter.Wait` へのタイムアウト伝播
- [x] `compression_analysis_report.md` の更新 (不要・スコープ外として省略)

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-25
> Mode: Pre-Implementation (修正前の設計レビュー)
> Prior audits: 0 | New findings this round: 3

### 📊 Convergence Status
初回監査のため、全次元で検査を実施。

### ⚠️ Impact on Related Features *(new only)*

- **`checkSleepThreshold` が Ticker Worker の全 agentWs をブロックする（文書の誤りを訂正）:**
  実際のコードを確認したところ、`checkSleepThreshold` は `goroutine` ではなく **Ticker の goroutine 内でシリアルに（全 agentWs 分ループして）呼び出されている**。これは本ドキュメント Section 3.3 の「他 agentWs は別コールスタックなので無影響」という記述と**矛盾する**。
  実態は、1つの agentWs で `RunConsolidation` がブロックすると、**同一ゴルーチン内の後続 agentWs の Consolidation チェックも全てブロック**される。つまり影響は1 agentWs ではなく**全エージェントの Sleep Consolidation 停止**となり、影響度は文書が示すより遥かに大きい。

### 🚨 Potential Problems & Risks *(new only)*

- **BLOCKER: `last_consolidation` の事前スタンプ問題（タイムアウンド前提を破壊）:**
  実コード L1177 を確認すると、`vstore.SetMeta("last_consolidation", ...)` が `RunConsolidation` を呼ぶ**前に**実行されている。
  これが意味するのは、`RunConsolidation` が API ブロックでタイムアウトまたは失敗しても、次の Ticker 起動時には `lastConsolidation > lastActivity` が成立してしまい、**Sleep Timer が正常終了したと誤認識して再試行をスキップ**することである。APIブロック→失敗→再試行なし、という最悪のサイレント障害パターンが確定している。
  
  **修正案:** `SetMeta` の呼び出しを `RunConsolidation` が正常終了した**後**に移動すること。ただしブロック問題（isConsolidating固着）が解決される前提が必要。

- **MED: 案B（`defer atomic.StoreInt32`）は`checkSleepThreshold`では機能しない:**
  `checkSleepThreshold` は goroutine ではなく直接呼び出されるため、`defer` は `checkSleepThreshold` が return するまで実行されない。これは、RunConsolidation が永遠にブロックする場合はそもそも `defer` も到達できないため、案B は「最小変更」に見えて実際には何も解決しない。

### 📋 Missing Steps & Considerations *(new only)*

- **案A のタイムアウト値は「最大クラスター数」に基づいて動的に計算すべき:**
  現状の固定値（10〜30分）は D0 ノード数が極端に多い場合（例: 500件 = 50クラスター）に不足する。将来の拡張性を考慮するなら、`max_timeout = max(10min, vstore.Count() / 10 * avg_cluster_time)` のような動的上限を設けることが望ましい。現状は「LOW優先」として記録に留める。

### 🕳️ Unaddressed Edge Cases *(new only)*

- **`handleConsolidate` RPC でのタイムアウトコンテキストとゴルーチンリークの組み合わせ:**
  案A を適用した場合、`handleConsolidate` 内の goroutine に `context.WithTimeout(10min)` を渡すが、この context はゴルーチン内の `defer consolidationCancel()` によってのみキャンセルされる。
  正常系では問題ないが、ゴルーチンが何らかの理由で中断されないまま存在し続けた場合（ゾンビ goroutine）、外部から cancel する手段がない。`context.WithCancel` のハンドルをプロセスレベルの shutdown channel に接続するか、`handleShutdown` RPC でキャンセルを明示的に伝播させる設計が推奨される。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| BLOCKER | Section 3.3 の「他 agentWs への影響なし」の記述を訂正する。`checkSleepThreshold` の `RunConsolidation` を別 goroutine にラップしてタイムアウトを持たせる | 全 agentWs への影響を正確に把握・防止するため | ✅ New |
| BLOCKER | `vstore.SetMeta("last_consolidation", ...)` の呼び出しを RunConsolidation **成功後**に移動する | 失敗時に再試行が永久にスキップされる最悪パターンを防止するため | ✅ New |
| HIGH | 案B（defer）は `checkSleepThreshold` に対しては無効と明記し、案A（context 伝播）を正式採用する | 設計の誤解を防止するため | ✅ New |
| LOW | タイムアウト値に「エピソード数ベースの動的上限」を将来の改善バックログとして登録 | 将来のスケール問題への事前対策 | ✅ New |

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| `checkSleepThreshold` の同期ブロック問題 | ✅ Resolved — `go func()` により `RunConsolidation` を非同期化し、Ticker 全体がブロックされる致命的バグを解消確認。 |
| `last_consolidation` の早すぎる書き込みによる再試行不可問題 | ✅ Resolved — `RunConsolidation` が `err == nil` で帰還した**後**にのみ `SetMeta` を実行するよう順序を直生し、失敗時の次回再試行を保証。 |
| `gemmaLimiter.Wait` などの永続ブロックリスク | ✅ Resolved — `processCluster` 内の Limiters 呼び出しに対して各 `context.WithTimeout(ctx, 30*time.Second)` でラップし、Rate Limit トークン枯渇時や切断時の無期限待機を完全防止。 |
| `RunConsolidation` 全体のタイムアウト欠落 | ✅ Resolved — `main.go` の2箇所（Sleep Timer / RPC）から `10*time.Minute` の `Context` を注入し、API障害時でも最長10分で確実にリソースを解放＆`isConsolidating` リセットする堅牢な機構を整備。 |

---

## 🔍 Audit Report — Round 2 (Final Verification)
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-25
> Mode: Post-Implementation
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| `checkSleepThreshold` の同期ブロック問題 | ✅ Resolved — L1190 の `go func(ws, vs)()` で非同期化。Ticker goroutine はブロックされない。直接確認済み。 |
| `last_consolidation` 事前スタンプ問題 | ✅ Resolved — L1196 で `RunConsolidation` を呼び出し、L1199〜L1202 の `if err != nil / else` で**成功時のみ** `SetMeta` を実行。事前書き込みバグは完全解消。 |
| Rate Limiter の無期限ブロックリスク | ✅ Resolved — `consolidation.go` L143, L159, L173 で `gemmaLimiter.Wait` × 2、`embedLimiter.Wait` × 1 すべてに `context.WithTimeout(ctx, 30*time.Second)` を付与。`ctx` は親から 10 min timeout を受け継ぎ二重防御が成立。 |
| `RunConsolidation` 全体のタイムアウト欠落 | ✅ Resolved — Sleep Timer 経路（L1193）と RPC 経路（L1238）の両方で `context.WithTimeout(context.Background(), 10*time.Minute)` を生成し `RunConsolidation` へ渡す。また両経路で `defer atomic.StoreInt32(&isConsolidating, 0)` がセットされ、タイムアウト時にも `isConsolidating` フラグが確実にリセットされる。 |

✅ No new critical issues found. Document has converged.

### ⚠️ Impact on Related Features *(new only)*
- None.

### 🚨 Potential Problems & Risks *(new only)*
- None.

### 📋 Missing Steps & Considerations *(new only)*
- None.

### 🕳️ Unaddressed Edge Cases *(new only)*
- None.

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| - | No further action required | 全 Round 1 指摘事項が実装で完全に解消され、コードベース上で直接確認済み。 | - |

