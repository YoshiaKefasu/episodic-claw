# Go Sidecar API Retry & Deferred Queue 改善

## 背景

`ai.ingest` が発火すると、Goサイドカーが Gemma API (`gemma-3-27b-it`) を使ってスラッグを生成するが、レート制限 (429) により即時3回すべて失敗する問題がある。

現状のリトライは **sleepなし** で即座に3回連続 → 全部429で失敗。

## 変更方針

### 1. リトライ間の1分sleep（全API呼び出し関数）

対象箇所：[handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-472) と [handleBatchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#510-640) のリトライループ

```go
// Before（現状）
for attempt := 0; attempt < 3; attempt++ {
    slug, genErr = provider.GenerateText(ctx, prompt)
    if genErr != nil {
        EmitLog("...attempt %d error: %v", attempt+1, genErr)
        continue  // ← sleepなしで即リトライ
    }
    ...
}

// After（修正後）
for attempt := 0; attempt < 3; attempt++ {
    if attempt > 0 {
        EmitLog("Retrying in 60s (attempt %d/3)...", attempt+1)
        time.Sleep(60 * time.Second)
    }
    slug, genErr = provider.GenerateText(ctx, prompt)
    ...
}
```

### 2. 全3回失敗時のDeferred Queueへの退避

3回失敗した場合、エピソードをインメモリのdeferred queueに積む。次に `ai.surprise` が発火したとき（＝次のメッセージ時）にqueueをdrainして再試行する。

**設計：**

```go
// グローバルなdeferred queue
type DeferredIngest struct {
    Params handleIngestParams
    At     time.Time
}
var deferredQueue []DeferredIngest
var deferredMu    sync.Mutex
```

- [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-472) で3回全失敗した場合、MD5スラッグfallbackではなく、deferredQueueに追加してログに記録
- [handleSurprise](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#323-356) の最後（値を返す前）でdeferredQueueをdrainして再試行
- drainは最大5件まで（無限蓄積を防ぐ）

> [!NOTE]
> MD5スラッグfallback（`episode-xxxx`）は維持しつつ、deferred queueでの再試行を**追加**する形にする。つまり429時は①queueに積む→②次のメッセージで再試行→③それでも失敗ならMD5fallbackで確実に保存する。

## Proposed Changes

### Go Sidecar

#### [MODIFY] [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go)

1. **グローバルなdeferred queue構造体と変数を追加**（ファイル冒頭）
2. **[handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-472) のリトライループにsleepを追加**（L384-398）
3. **[handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-472) の3回全失敗時にdeferredQueueへpush**（L400付近）
4. **[handleSurprise](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#323-356) の末尾にdeferredQueue drainロジックを追加**（L354付近）

## Verification Plan

### Manual Verification

1. WSLでゲートウェイを起動: `openclaw gateway --verbose`
2. チャット画面で1通送る（初回バッファ吸収）
3. 全然違う話題で2通目を送り、ログで以下を確認:
   - `[Episodic-Core] Method: ai.surprise` が出る
   - `Calculated surprise: 0.XX` が **0.2超** の値で出る
   - `Surprise threshold exceeded` が出る
   - `[Episodic-Core] Method: ai.ingest` が出る
   - もし429が出ても→ `Retrying in 60s (attempt 2/3)` が出る（sleepあり）
   - 3回全失敗なら→ `Deferred ingest queued` が出る
4. さらに3通目を送り、ログで `Draining X deferred ingest(s)...` が出ることを確認
5. `ls /root/.openclaw/workspace-keruvim/episodes/2026/03/21/` でMDファイルが生成されていることを確認
