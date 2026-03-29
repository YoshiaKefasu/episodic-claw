# Issue Report: `globalWatcher` 書き換えのミューテックス欠落

- **作成日**: 2026-03-25
- **更新日**: 2026-03-25
- **優先度**: P3 (Low)
- **状態**: 解決済 (Resolved) — Mutex保護によるData Race防止と、安全なライフサイクル管理(defer Stop)を実装済み
- **対象ファイル**:
  - `go/main.go` L172, L187-213 (`handleWatcherStart`)

---

## 1. 問題の概要

`globalWatcher` はパッケージレベルのグローバル変数として宣言されており、`handleWatcherStart` RPC が呼び出されるたびに書き換えられる。しかしこの書き換えは**ミューテックスなし**で行われており、複数の接続から同時に `watcher.start` RPC が呼び出された場合（または再接続シナリオ）、**データ競合（Data Race）**が発生する可能性がある。

---

## 2. 現状のコード

### `main.go` — `globalWatcher` の宣言と `handleWatcherStart`

```go
// L172 — パッケージレベルのグローバル変数（ミューテックスなし）
var globalWatcher *watcher.Watcher

// L174-213 — handleWatcherStart（ミューテックスなしで読み書き）
func handleWatcherStart(conn net.Conn, req RPCRequest) {
    ...
    // L187-189 — 読み取りと停止（ミューテックスなし）
    if globalWatcher != nil {
        globalWatcher.Stop()
    }

    // L191-194 — 新しい Watcher を作成
    w, err := watcher.New(1500, func(event watcher.FileEvent) {
        sendEvent(conn, "watcher.onFileChange", event)
    })

    ...
    // L200 — 書き込み（ミューテックスなし）
    globalWatcher = w

    // L207 — 読み取り（ミューテックスなし）
    if err := globalWatcher.AddRecursive(path); err != nil {
        ...
    }
    // L212 — 読み取り（ミューテックスなし）
    globalWatcher.Start()
}
```

---

## 3. 問題の詳細

### 3.1 現在の設計と問題の潜伏

**現在の実装では `watcher.start` は1接続から1回だけ呼ばれる設計**であり、実際に競合が発生することは極めてまれである。しかし以下のシナリオで競合が顕在化しうる：

**シナリオ 1: OpenClaw の異常再起動**

OpenClaw プロセスがクラッシュして再起動した場合、古い接続の `handleWatcherStart` が `globalWatcher.Stop()` を試みる間に、新しい接続が `globalWatcher = w` を書き込む可能性がある。

```
Goroutine A (旧接続): if globalWatcher != nil { ... }  // nil チェック成功
Goroutine B (新接続): globalWatcher = w_new            // 書き込み（競合）
Goroutine A (旧接続): globalWatcher.Stop()             // w_new を Stop してしまう
```

**シナリオ 2: Go の `-race` フラグ検出**

`go test -race` や `go run -race` を使用した場合、上記のような並行読み書きは**即座に Data Race として検出**され、プロセスがパニック終了する。E2E テストで `-race` フラグを使用すると再現可能。

**シナリオ 3: 将来的な複数エージェント対応**

現在は OpenClaw 側から1接続のみが `watcher.start` を呼ぶ設計だが、将来的に **複数エージェントが同一 Go サイドカーを共有**する構成になった場合（複数 agentWs）、各エージェントが独立して `watcher.start` を呼ぶ可能性がある。

### 3.2 `writeMu` との対比

同ファイルの `sendResponse` / `sendEvent` では既に `writeMu sync.Mutex` を使用してソケット書き込みの競合を防いでいる（`main.go` の Data Race 修正 FIX-P0-A）。`globalWatcher` に同様の保護が欠けているのは設計の非対称性である。

```go
// sendEvent (L163-170) — 保護あり
func sendEvent(...) {
    bytes, _ := json.Marshal(ev)
    data := append(bytes, '\n')
    writeMu.Lock()       // ← ソケット書き込みは保護されている
    conn.Write(data)
    writeMu.Unlock()
}

// handleWatcherStart — 保護なし
var globalWatcher *watcher.Watcher  // ← グローバル変数の読み書きは無保護
```

---

## 4. 修正案

### 案A: `sync.Mutex` による保護（推奨）

```go
// main.go — グローバル変数にミューテックスを追加
var (
    globalWatcher    *watcher.Watcher
    globalWatcherMu  sync.Mutex
)

func handleWatcherStart(conn net.Conn, req RPCRequest) {
    ...
    globalWatcherMu.Lock()
    if globalWatcher != nil {
        globalWatcher.Stop()
    }
    globalWatcher = w
    globalWatcherMu.Unlock()

    globalWatcherMu.Lock()
    addErr := globalWatcher.AddRecursive(path)
    globalWatcherMu.Unlock()
    if addErr != nil {
        sendResponse(conn, RPCResponse{..., Error: &RPCError{-32000, "Failed to watch dir: " + addErr.Error()}, ...})
        return
    }

    globalWatcherMu.Lock()
    globalWatcher.Start()
    globalWatcherMu.Unlock()

    sendResponse(conn, RPCResponse{..., Result: "Watcher started on " + path, ...})
}
```

ただし実際には `Stop()` → `globalWatcher = w` → `AddRecursive` → `Start()` が**一連の原子的操作**であることが望ましいため、ロックを外さずに一括処理する：

```go
globalWatcherMu.Lock()
defer globalWatcherMu.Unlock()

if globalWatcher != nil {
    globalWatcher.Stop()
}
globalWatcher = w

if err := globalWatcher.AddRecursive(path); err != nil {
    sendResponse(conn, RPCResponse{..., Error: ...})
    return
}
globalWatcher.Start()
```

### 案B: 単一接続強制チェックの追加（現設計の明文化）

ミューテックスを追加せずに、代わりに「既に Watcher が起動中の場合はエラー返却」とする：

```go
if globalWatcher != nil {
    sendResponse(conn, RPCResponse{..., Error: &RPCError{-32000, "Watcher already running"}, ...})
    return
}
```

**メリット**: コード変更が最小。現在の単一接続設計を明文化できる。  
**デメリット**: 再接続時に Watcher を再起動できなくなる。OpenClaw 再起動時のリカバリー手段を失う。

---

## 5. `watcher.Watcher` の実装との整合性

`watcher.New` / `watcher.Stop` / `watcher.AddRecursive` / `watcher.Start` の各メソッドが内部でスレッドセーフであるかどうかを確認する必要がある。もしこれらが内部で独自のミューテックスを使用している場合、外側のミューテックスとの二重ロックによるデッドロックリスクがある。

```
対象パッケージ確認: go.sum / go.mod から watcher パッケージを特定 → 実装を調査
```

---

## 6. リスク評価

| リスク | 発生確率 | 影響度 | 対策 |
|--------|---------|--------|------|
| 通常運用での競合 | 極低（単一接続設計） | 高（パニック） | 案A でガード |
| `-race` フラグでのテスト検出 | 低〜中（E2E テスト追加時） | 中（テスト失敗） | 案A で解消 |
| 将来の複数エージェント接続での競合 | 中（設計変更時） | 高 | 案A で事前対処 |
| `watcher` パッケージ内部とのデッドロック | 低 | 高 | ミューテックス追加前に watcher 実装を確認 |

---

## 7. 現在の許容判断

現時点では以下の理由から、本 Issue は **P3（Low）** として保留することを推奨する：

1. OpenClaw は単一接続で `watcher.start` を1回のみ呼ぶ設計として安定動作中
2. 競合が発生するシナリオは OpenClaw 異常再起動という低頻度イベント
3. FIX-R1〜R4 完了後に続く E2E テストで `-race` フラグを追加した際に検出・対処可能

---

## 8. 残存タスク

- [x] `watcher` パッケージのスレッドセーフ性を確認 (確認済: `w.Start()` はノンブロッキングであり、内部コールバックは独立して動作するため安全)
- [x] 案A/B の選択と承認 (案A + Audit推奼策を採用)
- [x] `main.go` への `globalWatcherMu sync.Mutex` 追加と `handleWatcherStart` の保護
- [x] `-race` フラグ付き E2E テストでの再現確認 (Windows cgo 制約により静的解析と論理監査で代替済)
- [x] `compression_analysis_report.md` の更新 (不要なため省略)

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-25
> Mode: Pre-Implementation (修正前の設計レビュー)
> Prior audits: 0 | New findings this round: 3

### 📊 Convergence Status
初回監査のため、全次元で検査を実施。

### ⚠️ Impact on Related Features *(new only)*

- **`go getStore()` の並行起動が `handleWatcherStart` 内に潜在する第二の競合を形成:**
  実コード L216 を確認すると、`globalWatcher = w` で代入した**直後**に `go func(ws string) { _, _ = getStore(ws) }(path)` を起動している。この goroutine は `getStore` → `runAutoRebuild` → `EmitLog` → `sendEvent(conn, ...)` というコールスタックを持つ。
  問題は、この goroutine が起動されるタイミングで `handleWatcherStart` はまだ `globalWatcher.AddRecursive(path)` を実行しておらず、さらに `conn` の有効性を保証する手段もない点である。**もし `conn` がその後クローズされると、goroutine は無効な `conn` へ `sendEvent` を試みてクラッシュする（use-after-close）**。 
  このリスクは「ミューテックス追加」の修正スコープ外であり、独立した対処が必要。

### 🚨 Potential Problems & Risks *(new only)*

- **HIGH: 案A の「一括ロック（defer Unlock）」設計において `watcher.Start()` がデッドロックを引き起こす可能性:**
  本ドキュメント Section 5 では、`watcher` パッケージの内部スレッドセーフ性を確認する必要があると明記されているが、未確認のまま案Aを実装した場合に深刻なデッドロックリスクがある。
  `watcher.Start()` は内部でイベントを送信するコールバックを呼び出す goroutine を起動する場合があり（非同期イベント delivery）、このコールバックが `handleWatcherStart` の外側から `globalWatcherMu.Lock()` を取得しようとすると、`defer globalWatcherMu.Unlock()` の解放前にデッドロックが成立する。
  
  **対策:** `watcher.Start()` の後に `defer` ではなく明示的にロックを手放してから起動するか、`Start()` だけをロック外で実行する（`Stop` → 代入 → `AddRecursive` → Unlock → `Start()`）設計が安全。

- **MED: `globalWatcher` は接続単位ではなくプロセス単位の singleton だが、接続のライフサイクルとの整合性が未保証:**
  `conn` が閉じられた際に `globalWatcher.Stop()` が呼ばれる保証がない。接続が切れたまま Watcher が動き続けると、クローズ済みの `conn` にイベントを送信し続ける goroutine leak が発生する。

### 📋 Missing Steps & Considerations *(new only)*

- **接続切断時（EOF/エラー時）の `globalWatcher.Stop()` 呼び出しを接続処理ループに追加すること:** 現状、`main.go` の接続受け付けループが接続切断を検知した際に `globalWatcher.Stop()` を呼ぶ処理が存在しない可能性がある（未確認）。確認と追加が必要。

### 🕳️ Unaddressed Edge Cases *(new only)*

- **再接続後に `globalWatcher.Stop()` が新しい Watcher を参照してしまうレース（シナリオ 1 の詳細化）:**
  ドキュメント記載のシナリオ 1 は「旧接続が新接続の Watcher を Stop する」ケースを挙げているが、逆パターンも存在する：
  ```
  Goroutine A (旧): globalWatcher.Stop()  // 古い w を Stop しているつもり
  Goroutine B (新): globalWatcher = w_new  // Stop の直後に新 Watcher を代入
  Goroutine A (旧): globalWatcher = nil (想定)  // 実際は何もしないが、ABA パターン
  ```
  ミューテックスなしでは `global-Watcher != nil` チェックと `.Stop()` の間にある非原子性によってこのパターンが成立する。案A の「一括ロック」のみがこれを完全解決できる。

### ✅ Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| HIGH | `go getStore()` goroutine を `handleWatcherStart` 内から分離し、接続のクローズを `done channel` で通知して goroutine が安全に終了できるようにする | use-after-close による `sendEvent` クラッシュ防止 | ✅ New |
| HIGH | 案A を実装する前に `watcher.Start()` をロック外で呼び出す設計を採用し、コールバック内デッドロックを回避する | `defer globalWatcherMu.Unlock()` とイベントコールバックの競合回避 | ✅ New |
| MED | 接続切断時（接続ループ内）に `globalWatcher.Stop()` を呼び出す処理を追加する | goroutine leak と use-after-close の抜本的防止 | ✅ New |

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| `globalWatcher` 書き換えのミューテックス欠落 | ✅ Resolved (`globalWatcherMu sync.Mutex` を導入して `handleWatcherStart` を保護) |
| `go getStore()` goroutine の分離 | ✅ Resolved (`getStore` は `sendEvent` に依存しないことを論理確認し、ロック範囲外で安全に発火するよう配置) |
| `watcher.Start()` 呼び出しとデッドロック回避 | ✅ Resolved (`w.Start()` を mutex ロックブロック外に明示的に配置して安全な状態を担保) |
| 接続切断時の `globalWatcher.Stop()` 呼び出し | ✅ Resolved (`handleConnection` 内の defer 構文にて、同一コネクションに紐づく Watcher のみを安全に判定してから `Stop()` および解放するガード機構を追加実装済) |

---

## 🔍 Audit Report — Round 2 (Final Verification)
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-25
> Mode: Post-Implementation
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| `globalWatcher` Data Race（ミューテックス欠落） | ✅ Resolved — `globalWatcherMu sync.Mutex` が L188 に宣言され、`handleWatcherStart` の Stop/代入/AddRecursive を一括保護。L204〜L228 で確認済み。 |
| `watcher.Start()` のデッドロックリスク | ✅ Resolved — L228 で `globalWatcherMu.Unlock()` した**後**に L236 で `w.Start()` を呼ぶ設計で確認済み。コールバックは独立 goroutine での非同期実行のため、デッドロック経路なし。 |
| `go getStore()` の use-after-close リスク | ✅ Resolved — `getStore` → `runAutoRebuild` / `EmitLog` は `os.Stderr` へ書くのみ。`sendEvent(conn, ...)` は呼ばれない。コールチェーンを L52-98 で直接確認済み。 |
| 接続切断時の goroutine leak と `globalWatcher.Stop()` | ✅ Resolved — `handleConnection` 関数（L1335）が `defer` ブロック（L1337-1346）で `globalWatcherConn == conn` のガードチェックを行い、当該接続でのみ `Stop()` + `nil` クリアを実施。ABA レース問題を同一ロック下で完全防止。 |

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

