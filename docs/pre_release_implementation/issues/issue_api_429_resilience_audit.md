# API 429 (RESOURCE_EXHAUSTED) レジリエンス監査レポート

> 作成日: 2026-03-27  
> 改訂: 2026-03-27 (v2 — Circuit Breaker 方式に全面改訂)  
> **実装完了: 2026-03-27 — P0/P1/P2/P3 全項目実装済み + Round 2/3 監査収束、全テスト PASS**  
> トリガー: Phase 5.8 Day A TC-5.8-1 で indexer.rebuild 実行時、48 ファイル中 18 件が HTTP 429 で失敗  
> 対象: `episodic-core` Go サイドカーの全 Embedding API 呼び出しパス

---

## 1. 現状のアーキテクチャ分析

### 1.1 Rate Limiter 構成

```go
// main.go:37-39
gemmaLimiter     = rate.NewLimiter(rate.Limit(15.0/60.0), 1)  // 15 RPM
embedLimiter     = rate.NewLimiter(rate.Limit(100.0/60.0), 1) // 100 RPM
healEmbedLimiter = rate.NewLimiter(rate.Limit(10.0/60.0), 1)  // 10 RPM
```

| Limiter | 呼び出し元 | RPM | バースト | 用途 |
|---|---|---|---|---|
| `embedLimiter` | rebuild, ingest, batchIngest, recall, consolidation | 100 | 1 | メイン Embed 全パス |
| `gemmaLimiter` | HealingWorker Pass 2, consolidation | 15 | 1 | LLM (Gemma) |
| `healEmbedLimiter` | HealingWorker Pass 1 のみ | 10 | 1 | 治癒用 Embed |

### 1.2 Retry 層の現状

`ai/provider.go` に `RetryEmbedder` / `RetryLLM` が存在する:

- `MaxRetries: 3`, `BaseDelay: 2s`, exponential backoff (x2)
- `IsRetryable()` は `429 || >= 500` を true 判定
- `RetryAfter()` は常に `0` を返す（Gemini の `Retry-After` ヘッダーを未読）

### 1.3 各呼び出しパスのリトライ適用状況

| パス | RetryEmbedder 使用 | 429 時の挙動 |
|---|---|---|
| `runAutoRebuild` (indexer.rebuild) | 未使用 | **即座にスキップ、リトライなし** |
| `handleIngest` | 未使用 | 即座にスキップ |
| `handleBatchIngest` | 未使用 | 即座にスキップ、triggerHealing 発火 |
| `handleRecall` | 未使用 | 即座にエラー返却 |
| `RunConsolidation` | **使用** (`NewRetryPair`) | 正常にリトライ |
| `HealingWorker Pass 1` | 未使用 | スキップ（次のサイクルで再試行） |
| `ProcessBackgroundIndexing` | 未使用 | 即座にスキップ |

---

## 2. 根本原因

### 原因 1: rebuild パスのリトライ不在 — ただし RetryEmbedder は正解ではない

`runAutoRebuild` は `ai.NewGoogleStudioProvider()` を直接使い、429 で即 `failed++` になる。

**ただし、rebuild にリトライを入れるのは設計として誤り。** 理由は後述のセクション 3 で解説。

### 原因 2: 並行セマフォ (10) と Rate Limiter (burst=1) の不整合

```go
sem := make(chan struct{}, 10)  // 10 goroutine が同時にリクエスト
embedLimiter = rate.NewLimiter(rate.Limit(100.0/60.0), 1) // burst=1
```

10 goroutine が同時に `embedLimiter.Wait()` を通過すると、Rate Limiter のキューでは順序付けされるが、API 側のウィンドウ計算とずれることがある。

### 原因 3: Free Tier の RPD (日次制限)

RPM を完全に守っていても、Google AI Studio Free Tier には **RPD (Requests Per Day)** 制限がある。RPD を超過すると RPM の余裕に関わらず 429 が返る。Rate Limiter だけでは防げない。

### 原因 4: Retry-After ヘッダーの未活用

```go
// provider.go:41-46 — 常に 0 を返す
func (e *APIError) RetryAfter() time.Duration { return 0 }
```

`google_studio.go` がレスポンスヘッダーを破棄しているため、API が返す `Retry-After` 値を活用できていない。

---

## 3. 設計哲学の再検討: Retry vs Circuit Breaker

### 3.1 Markdown-First との整合性

episodic-claw の設計原則:

1. **Markdown-First**: `.md` ファイルが真実、DB は再構築可能なキャッシュ
2. **Survival First**: embed 失敗時は MD5 スラグで `.md` を保存し、データロストを防止
3. **HealingWorker**: 非同期でゴースト (DB 未登録) ファイルを回収・リネーム

この設計は分散システムにおける **Eventual Consistency（最終的整合性）** パターンそのもの。HealingWorker が「最終的にデータを回復する」責務を担っている。

### 3.2 Retry が rebuild に不適切な理由

rebuild パスに `RetryEmbedder` (MaxRetries: 5, exponential backoff) を適用した場合:

| 観点 | Retry あり | Retry なし（現状） |
|---|---|---|
| Free Tier RPD 超過時 | **93秒 × 18件 = 最大 28 分間無意味に待機** | 即 skip → HealingWorker に委譲 |
| rebuild の総所要時間 | 予測不能（API 回復タイミングに依存） | ほぼ一定（成功分のみ処理） |
| 設計の一貫性 | HealingWorker の存在意義を侵食 | Markdown-First + HealingWorker に忠実 |
| クォータ消費 | リトライ分の RPM/RPD を追加消費 | 消費しない |

**結論: rebuild にリトライを入れるのは Rate Limit と「戦う」設計。episodic-claw に必要なのは Rate Limit と「共存する」設計。**

### 3.3 業界のベストプラクティス: Circuit Breaker

Netflix (Hystrix), Spotify, Amazon 等では、バルク処理に対して Retry ではなく **Circuit Breaker パターン** を採用する。

> 「壊れた壁を何度も殴るな。一旦引いて、別の仕組みに任せろ。」

episodic-claw では HealingWorker が「別の仕組み」に該当する。rebuild が「もう無理」と判断した時点で即座に HealingWorker に委譲するのが正解。

---

## 4. パス別の最適戦略

| パス種別 | 性質 | 適切な対策 | 理由 |
|---|---|---|---|
| rebuild / batchIngest | バルク・バックグラウンド | **Circuit Breaker** → HealingWorker 委譲 | バルク処理でリトライは時間浪費 |
| ingest / recall | リアルタイム・1件 | **RetryEmbedder** (MaxRetries: 2) | ユーザーが応答を待っている。2-3 秒の遅延は許容 |
| HealingWorker | バックグラウンド・低レート | 現状維持 | healEmbedLimiter (10 RPM) + スキップで十分 |
| consolidation | バックグラウンド | 現状維持 | NewRetryPair 適用済み |

---

## 5. 対策案 (改訂版)

### 案 1: rebuild に Circuit Breaker 導入 [P0 — 即実行]

**影響範囲**: `runAutoRebuild()` のみ  
**工数**: 小（15行追加）

```go
// runAutoRebuild 内
var consecutiveFails int
const circuitThreshold = 3

for _, frec := range files {
    wg.Add(1)
    go func(path string, modTime time.Time) {
        defer wg.Done()
        sem <- struct{}{}
        defer func() { <-sem }()

        // Circuit Breaker: 連続 N 回失敗で残りを全スキップ
        mu.Lock()
        if consecutiveFails >= circuitThreshold {
            mu.Unlock()
            return
        }
        mu.Unlock()

        // ... parse, embed ...
        emb, err := provider.EmbedContent(ctx, doc.Body)
        if err != nil {
            mu.Lock()
            failed++
            consecutiveFails++
            mu.Unlock()
            return
        }

        // 成功したらカウンタリセット
        mu.Lock()
        processed++
        consecutiveFails = 0
        mu.Unlock()
    }(frec.path, frec.modTime)
}

wg.Wait()

// Circuit が開いた場合は HealingWorker に通知
if consecutiveFails >= circuitThreshold {
    EmitLog("Rebuild: Circuit breaker tripped after %d consecutive failures. "+
        "Delegating remaining files to HealingWorker.", circuitThreshold)
    triggerHealing()
}
```

**動作フロー**:
```
rebuild 開始
  → ファイル 1: embed 成功 (consecutiveFails = 0)
  → ファイル 2: embed 成功
  → ...
  → ファイル N:   429 (consecutiveFails = 1)
  → ファイル N+1: 429 (consecutiveFails = 2)
  → ファイル N+2: 429 (consecutiveFails = 3) → Circuit OPEN
  → 残りファイル: 全スキップ
  → triggerHealing() → HealingWorker に委譲
  → return (成功 N-1 件 / スキップ 48-N+1 件)
```

**利点**:
- Free Tier で RPD 超過しても最大 3 回の無駄リクエストで済む
- rebuild 時間が予測可能
- HealingWorker の設計意図と完全に整合
- Paid Tier ではそもそも Circuit が発動しない

### 案 2: rebuild のセマフォ 10 → 1 [P0 — 即実行]

**影響範囲**: `runAutoRebuild()` 1行  
**工数**: 極小

```diff
- sem := make(chan struct{}, 10) // Limit concurrency to 10
+ sem := make(chan struct{}, 1)  // Sequential: embedLimiter と完全同期
```

**理由**: 48 ファイルを sequential で処理しても `embedLimiter` (100 RPM ≈ 0.6秒/req) で 48 × 0.6 ≈ 29 秒。十分に許容範囲。並行化はバルク処理で Rate Limit との不整合リスクを高めるだけ。

### 案 3: リアルタイムパスに RetryEmbedder 適用 [P1]

**影響範囲**: `handleIngest`, `handleRecall`  
**工数**: 小（各 5行変更）

```go
// handleIngest / handleRecall 内
rawProvider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
provider := &ai.RetryEmbedder{
    Inner:      rawProvider,
    Limiter:    embedLimiter,
    MaxRetries: 2,        // リアルタイムパスなので控えめ
    BaseDelay:  1 * time.Second,
}
```

**理由**: ユーザーが `ep-recall` で応答を待っている場合、429 で即エラーを返すのはUXが悪い。2 回リトライ (最大 3 秒追加) は許容範囲。

### 案 4: Retry-After ヘッダー伝播 [P1 — 案3と同時実装必須]

> ⚠️ **NEW-4 修正**: 旧ラベルは [P2] だったが、HIGH-3 / 9.5 の分析により P1 に昇格。
> 案3単体では RPM 60s+ 超過時に全リトライ失敗する。案3と案4は**必ずセットで実装**すること。

**影響範囲**: `google_studio.go` + `provider.go`  
**工数**: 中（15行変更）

```go
// google_studio.go: レスポンスヘッダーから Retry-After を抽出
if resp.StatusCode != http.StatusOK {
    bodyBytes, _ := io.ReadAll(resp.Body)
    apiErr := &APIError{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
    if ra := resp.Header.Get("Retry-After"); ra != "" {
        apiErr.retryAfterDur = ai.ParseRetryAfterHeader(ra)
    }
    return nil, apiErr
}

// provider.go: APIError に retryAfterDur フィールド追加
type APIError struct {
    StatusCode    int
    Body          string
    retryAfterDur time.Duration
}

func (e *APIError) RetryAfter() time.Duration {
    return e.retryAfterDur
}
```

**理由**: RetryEmbedder の exponential backoff が API 指示の待機時間に従えるようになる。案3単体では BaseDelay=1s × MaxRetries=2 の最大 3 秒待機では RPM/RPD 超過（通常 60s+ の待機が必要）に対処できない——案4で `Retry-After` ヘッダーを伝播することで初めて実効性を持つ（HIGH-3 参照）。

### 案 5: Batch Embedding API 移行 [P3 — 将来]

Gemini の `batchEmbedContents` を使い、48ファイルを 1 バッチで送信。RPM カウントは 1 回で済む。

**時期**: エピソード数が 100+ になった段階で検討。

---

## 6. 推奨実装順序

| 優先度 | 案 | 変更量 | 効果 |
|---|---|---|---|
| **P0 (即実行)** | 案 1 + 案 2 | 16 行 | rebuild の 429 耐性を根本改善。無料枠でも無駄なクォータ消費ゼロ |
| **P1 (次回)** | 案 3 | 10 行 | recall / ingest の UX 改善。一時的な 429 スパイクを自動吸収 |
| **P2 (検討)** | 案 4 | 15 行 | RetryEmbedder の backoff 精度向上 |
| **P3 (将来)** | 案 5 | 大 | ファイル数 100+ 向けの根本的スケーリング |

---

## 7. 没にした案とその理由

| 没案 | 理由 |
|---|---|
| rebuild に RetryEmbedder を適用 | バルク処理でリトライは時間浪費。RPD 超過時に最大 28 分間無意味に待機。HealingWorker の設計意図を侵食 |
| Adaptive Rate Limiter (429 で動的レート低減) | 実装の複雑さに対してリターンが薄い。Circuit Breaker + HealingWorker の方がシンプルで堅牢 |
| Limiter の RPM を下げる | 正常時のスループット低下。根本対策ではない |
| API Key ローテーション | 同一プロジェクトなら RPM/RPD 共有。効果なし |
| Embed 結果のキャッシュ | 入力テキストごとに異なるためキャッシュヒット率が低い |

---

## 8. 結論

episodic-claw のアーキテクチャは **Markdown-First + Survival First + HealingWorker** という3層防御で API 障害に対する耐性を既に持っている。不足しているのは「リトライの強化」ではなく、**rebuild パスが「もう限界」と判断して HealingWorker に委譲するメカニズム (Circuit Breaker)** である。

### P0 適用後の期待値

| 指標 | Before (現状) | After (P0 適用後) |
|---|---|---|
| 429 時の挙動 | 全件個別にスキップ (18 件すべて失敗扱い) | 連続 3 件で Circuit OPEN → 残りスキップ → triggerHealing |
| 無駄な API コール | 18 件 (全件 429 を食らう) | 最大 3 件 (Circuit 発動後は API を叩かない) |
| クォータ消費 | 48 req (全件試行) | 成功分 + 最大 3 req (Free Tier に優しい) |
| rebuild 後のデータ整合性 | HealingWorker が 30 分後に回収 | triggerHealing 即時発火 → 次の Tick で回収開始 |
| 並行リクエスト数 | 10 (Rate Limiter とずれあり) | 1 (sequential, 完全同期) |

---

## 🔍 Audit Report — Round 1
> IBM / Google Pro Engineer 視点からのレビュー
> Date: 2026-03-27
> Mode: Post-Implementation
> Prior audits: 0 | New findings this round: 7

### 📊 Convergence Status

初回レビューのため、先行ラウンドの既知問題なし。

---

### 🚨 Potential Problems & Risks

#### [BLOCKER-1] consecutiveFails の「最大3件」保証が案2との密結合に依存している

案1のコードは sem の値に依存して動作が大きく変わる。

```
sem=10 の場合:
  - 10 goroutine が同時に mu.Lock() → consecutiveFails チェック → パス (まだ0)
  - 全員が EmbedContent を呼び出す（ロック外）
  - 全員が429を受け取り、consecutiveFails が一気に10加算される
  - 結果: 「最大3件の無駄なAPIコール」は嘘で、最大10件（sem幅）が1ラウンドで消費される
```

文書は P0 として「案1 + 案2 を同時実行」と記述しているが、実装コードの安全性が案2の完了を前提にしている点が明文化されていない。案1が単独でコミットされた場合、またはコードレビューで案2との関係を見落とした場合に本来の保証が崩れる。

**根本問題:** 案1のコードブロック内に `assert sem == 1` に相当するガードまたはコメントがない。実装上の前提条件がドキュメントにしか書かれていない。

**推奨:** 案1のコードに `// SAFETY: sem=1 (案2) との同時適用が必須。sem > 1 の場合はしきい値以上の無駄なAPIコールが発生する` のコメントを追加するか、関数冒頭でセマフォ容量をランタイム検証するアサーションを入れる。

---

#### [BLOCKER-2] Circuit Breaker が非429エラーを区別せずカウントする

```go
emb, err := provider.EmbedContent(ctx, doc.Body)
if err != nil {
    mu.Lock()
    failed++
    consecutiveFails++  // ← 429 も、タイムアウトも、パースエラーも全部同じ扱い
    mu.Unlock()
    return
}
```

案1の実装はすべての `err != nil` を `consecutiveFails` にカウントする。つまり以下が全て「429相当」として扱われる:

- ファイルパースエラー（`.md` フォーマット不正）
- ネットワークタイムアウト（APIとは無関係）
- コンテキストキャンセル
- 空ボディエラー

コーパスに不正な `.md` ファイルが3件連続して並んでいた場合、APIが完全正常でも Circuit Breaker が誤トリップし、残りのファイルを全スキップして `triggerHealing()` を呼ぶ。これはHealingWorkerへの誤委譲であり、次サイクルで同じパースエラーを繰り返す無限ループの温床になる。

**修正案:**
```go
if err != nil {
    mu.Lock()
    failed++
    if isRateLimitError(err) {  // 429 / RESOURCE_EXHAUSTED のみカウント
        consecutiveFails++
    } else {
        consecutiveFails = 0    // 非429エラーはリセット（API は生きている）
    }
    mu.Unlock()
    return
}
```

---

#### [HIGH-1] HealingWorker への委譲先も同じ RPD 壁に当たる

文書の想定フロー:
```
rebuild → 429 → Circuit OPEN → triggerHealing() → HealingWorker が回収
```

しかし表1.3 に明記されている通り、HealingWorker Pass 1 は `healEmbedLimiter` を使いリトライなし。RPD 超過（日次上限）が原因の429の場合、healEmbedLimiter のレートに関わらず Pass 1 も429を受け「スキップ（次サイクルで再試行）」する。

RPD が回復するのは翌日のリセットまで。その間、Ghost ファイルは毎 Tick でスキップされ続け、24時間解決しない。文書はこのシナリオを根本原因 §2.3 で認識しているが、委譲先が同じ壁に当たることへの対処が提案されていない。

**欠落している設計:** RPD 超過検出時に HealingWorker を抑制（バックオフ）する仕組み、またはユーザーへの明示的な警告ログ（「RPD 超過中。Ghost ファイル N 件は翌日 UTC 00:00 以降に自動回復予定」）が必要。

---

#### [HIGH-2] embedLimiter を共有するパスの並行実行が案2の「完全同期」保証を崩す

案2の主張: `sem=1` にすることで rebuild が「sequential, 完全同期」になる。

しかし `embedLimiter` は以下で共有される（表1.1）:

| パス | 同時走行の可能性 |
|---|---|
| `runAutoRebuild` | rebuild 中 |
| `RunConsolidation` | バックグラウンドで独立して走る |
| `handleIngest` | HTTP リクエストで随時起動 |
| `handleBatchIngest` | HTTP リクエストで随時起動 |

rebuild の sem=1 は rebuild goroutine 内の並行度を制限するが、consolidation や ingest の goroutine が同じ `embedLimiter.Wait()` を競合して取得することを防がない。Rate Limiter の `burst=1` により順序は保証されるが、burst を消費するのは rebuild 以外のパスかもしれない。

結果として rebuild の「0.6秒/req」という計算は保証値ではなく期待値になり、consolidation が積極的に動いている環境では rebuild スループットが予測不能に低下する。

---

### ⚠️ Impact on Related Features

#### [HIGH-3] 案3と案4の間に隠れた必須依存関係がある

文書は案4を「案3の精度向上」（P2）と位置付けているが、これは実際には**案3の動作保証が案4の実装に依存している**ことを隠蔽している。

```
案3単体の挙動:
  BaseDelay=1s, MaxRetries=2, exponential(x2)
  → 失敗時: 1秒待機 → 再失敗 → 2秒待機 → 再失敗 → エラー返却
  → 最大待機: 3秒

Gemini API の実際の Retry-After:
  RPD 超過: 数時間〜翌日リセットまで（秒単位では不可能）
  RPM 超過: 通常 60秒以上

つまり案4なしでは、案3は429が来ると3秒後に確実に全リトライ失敗し、
ユーザーに429エラーを返す。リアルタイム UX 改善として機能しない。
```

案3が実際に機能するのは「一時的な短いバースト（数秒以内に回復するケース）」のみ。RPD/RPM 超過には案4がないと全く効果がない。

**推奨:** 案4の優先度を P2 → P1 に引き上げ、案3と同時実装とする。あるいは案3の説明に「案4なしでは RPM/RPD 超過に対して効果なし」と明記する。

---

### 📋 Missing Steps & Considerations

#### [MED-1] consecutiveFails の成功時リセットが「散発的失敗」でCircuit Breakerを永遠に無効化する

現在の設計:
```go
// 成功
consecutiveFails = 0  // リセット

// 失敗
consecutiveFails++
```

RPM 超過（短期バースト）のシナリオで、rate limiter が適切に動作してリクエストが「成功・失敗・成功・失敗」と交互になる場合、`consecutiveFails` は常に 0 か 1 に留まり Circuit Breaker は永遠に発動しない。

RPD 超過（根本原因 §2.3）では連続失敗になるので問題ないが、RPM 超過という別のシナリオでは Circuit Breaker が機能しない。文書は RPM と RPD を区別して論じているのに、Circuit Breaker の設計は RPD 超過のみに有効。

**代替案:** 累積失敗率（直近 N 件の失敗比率）または総失敗数（successにリセットしない）での判定も検討する。

#### [LOW-1] APIError.retryAfterDur フィールドが unexported で一貫性が崩れている

案4のコードスニペット:
```go
type APIError struct {
    StatusCode    int     // exported
    Body          string  // exported
    retryAfterDur time.Duration  // ← unexported（小文字）
}
```

`StatusCode` と `Body` が exported なのに `retryAfterDur` だけ unexported。`RetryAfter()` メソッドで値は取得できるが、テストで直接フィールドを検証できず、他パッケージから構造体リテラルで初期化する際に混乱を招く。命名を `RetryAfterDur` に統一するか、設計意図（外部から直接セットさせない）をコメントで明示する。

---

### ✅ Recommended Actions

| Priority | Action | Reason | Is New? |
|----------|--------|---------|---------|
| P0 (即実行) | 案1コードに `sem=1 が必須前提` のコメントまたはランタイムアサーションを追加 | BLOCKER-1: sem>1 で「最大3件」保証が崩れる | Yes |
| P0 (即実行) | consecutiveFails カウントを `isRateLimitError(err)` でフィルタリング | BLOCKER-2: 非429エラーで Circuit Breaker が誤トリップ | Yes |
| P1 (次回) | 案4を案3と同時実装に格上げ | HIGH-3: 案3単体では RPM/RPD 超過に効果なし | Yes |
| P1 (次回) | RPD 超過時の HealingWorker バックオフまたは警告ログ追加 | HIGH-1: 委譲先も同じ壁にぶつかり Ghost ファイルが24時間未解決 | Yes |
| P2 (検討) | embedLimiter 共有パスの並行走行を考慮したスループット保証の文書化 | HIGH-2: consolidation 並行時に rebuild の 0.6秒/req が崩れる | Yes |
| P2 (検討) | consecutiveFails の成功時リセット設計を RPM 超過シナリオで評価 | MED-1: 散発的失敗では Circuit Breaker が永遠に発動しない | Yes |
| P0 (即実行) | 案1コードに `sem=1 が必須前提` のコメントまたはランタイムアサーションを追加 | BLOCKER-1: sem>1 で「最大3件」保証が崩れる | Yes |
| P0 (即実行) | consecutiveFails カウントを `isRateLimitError(err)` でフィルタリング | BLOCKER-2: 非429エラーで Circuit Breaker が誤トリップ | Yes |
| P1 (次回) | 案4を案3と同時実装に格上げ | HIGH-3: 案3単体では RPM/RPD 超過に効果なし | Yes |
| P1 (次回) | RPD 超過時の HealingWorker バックオフまたは警告ログ追加 | HIGH-1: 委譲先も同じ壁にぶつかり Ghost ファイルが24時間未解決 | Yes |
| P2 (検討) | embedLimiter 共有パスの並行走行を考慮したスループット保証の文書化 | HIGH-2: consolidation 並行時に rebuild の 0.6秒/req が崩れる | Yes |
| P2 (検討) | consecutiveFails の成功時リセット設計を RPM 超過シナリオで評価 | MED-1: 散発的失敗では Circuit Breaker が永遠に発動しない | Yes |
| P3 (後回し) | APIError.retryAfterDur を exported フィールドに統一 | LOW-1: 命名の一貫性 | Yes |

---

## 9. 監査発見事項への詳細実装ガイド (2026-03-27)

> Round 1 監査の各 BLOCKER / HIGH に対する具体的な修正コード・ファイル位置・実装手順。

---

### 9.1 BLOCKER-1 修正: 案1と案2の依存関係を明文化

**対象ファイル**: `go/main.go` — `runAutoRebuild()` 関数冒頭

```go
// runAutoRebuild performs background reconstruction of the HNSW index.
//
// ⚠️  SAFETY CONTRACT: This function MUST be called with sem capacity = 1.
//     (See Circuit Breaker logic below: "max 3 wasted API calls" guarantee
//      holds ONLY when goroutines are strictly sequential.)
//     案2 (sem=1) との同時適用が必須。sem > 1 の場合、circuitThreshold × sem 幅
//     のAPIコールがトリップ前に消費される。
func runAutoRebuild(targetDir string, apiKey string, vstore *vector.Store) (int, int) {
    // ... 既存コード ...
    sem := make(chan struct{}, 1) // Sequential: MUST stay 1. See SAFETY CONTRACT above.
```

**効果**: コードレビューで見落とされない・後から sem=10 に戻された際に意図を即時伝達。

---

### 9.2 BLOCKER-2 修正: `isRateLimitError()` ヘルパーと Circuit Breaker 精密化

**対象ファイル**: `go/internal/ai/provider.go` にヘルパー追加、`go/main.go` の Circuit Breaker に適用

#### Step 1 — provider.go にヘルパー追加

```go
// IsRateLimitError returns true if the error is an API rate limit / quota error (HTTP 429).
// Used by Circuit Breaker in runAutoRebuild to distinguish quota exhaustion
// from unrelated errors (parse failures, timeouts, network errors).
func IsRateLimitError(err error) bool {
    var apiErr *APIError
    if errors.As(err, &apiErr) {
        return apiErr.StatusCode == http.StatusTooManyRequests // 429
    }
    return false
}
```

> `errors.As` を使うことで、`fmt.Errorf("... %w", apiErr)` でラップされたエラーにも対応できる。

#### Step 2 — main.go の Circuit Breaker に適用

```go
emb, err := provider.EmbedContent(ctx, doc.Body)
if err != nil {
    mu.Lock()
    failed++
    if ai.IsRateLimitError(err) {
        // 429 / RESOURCE_EXHAUSTED のみ Circuit Breaker カウント
        consecutiveFails++
        EmitLog("Rebuild: 429 received for %s (consecutiveFails=%d)", path, consecutiveFails)
    } else {
        // パースエラー・タイムアウト等: API は生きているのでカウントリセット
        consecutiveFails = 0
        EmitLog("Rebuild: Non-429 error for %s: %v (circuit reset)", path, err)
    }
    mu.Unlock()
    return
}
// 成功時
mu.Lock()
processed++
consecutiveFails = 0
mu.Unlock()
```

**効果**: 壊れた `.md` ファイル群が連続しても Circuit Breaker が誤トリップしない。`EmitLog` でトリップ理由が追跡可能。

---

### 9.3 HIGH-1 修正: RPD 超過時の HealingWorker バックオフ（TTL 付き自動リセット）

**問題**: RPD (日次制限) 超過の 429 は翌日 UTC 00:00 まで回復しない。HealingWorker が 30 分 Tick ごとに同じ Ghost ファイルに 429 を受け続ける。

**対象ファイル**: `go/main.go` — `RunAsyncHealingWorker()`

#### 初期設計の欠陥（廃案）

当初は単純なカウンタ方式（`heal_consecutive_429` に整数を保存）を検討したが、**誤検知時に恒久停止するリスク**があるため廃案とした。

```
問題の構造:
  429 が 3 回連続 → バックオフ → Pass 1 が return → embed が実行されない
  → 成功によるリセット機会が永遠に来ない
  → heal_consecutive_429 が Pebble DB に "3" のまま永続化
  → Ghost ファイルが恒久的に放置される（手動 DB 操作でしか回復不可）
```

誤検知ケース（一時的なネットワーク障害・短期 RPM スパイク・サービス一時障害）でも同じ状態に陥るため、シンプルなカウンタは不適切。

#### 採用方針: タイムスタンプ付き状態 + TTL 自動リセット

カウントではなく「**いつから**連続しているか」を記録し、TTL（2 時間）で自動リセットする。

**TTL を 2 時間にした根拠:**

| シナリオ | 実際の回復時間 | TTL 後の挙動 |
|---|---|---|
| 一時 RPM スパイク（誤検知） | 数十秒〜1 分 | 2h 後に再試行 → 即成功 → カウントリセット |
| 短期サービス障害（誤検知） | 数分〜1 時間 | 2h 後に再試行 → 成功 → カウントリセット |
| 本物の RPD 超過 | 〜24h (UTC reset) | 2h ごとに再試行 → 3 連続 429 → バックオフ再設定 → 繰り返し |

RPD 超過の場合は TTL リセット後も 3 回で再バックオフするため、誤検知による恒久停止を防ぎつつ実質的な保護を維持できる。唯一のコストは「RPD 超過中に 2 時間ごとに最大 3 API コールが消費される」点のみ。

#### 実装コード

```go
// go/main.go — RunAsyncHealingWorker() の冒頭（IsRefining チェックの直後）に追加

// heal429State は 429 連続発生の状態を TTL 付きで管理する。
// カウンタのみでは誤検知時に恒久停止するため、タイムスタンプで自動リセットする。
type heal429State struct {
    Count int       `json:"count"`
    Since time.Time `json:"since"`
}

// --- Pass 1 ループの前に状態を読み込む ---
var h429 heal429State
if raw, metaErr := vstore.GetMeta("heal_429_state"); metaErr == nil {
    json.Unmarshal(raw, &h429)
}

// TTL チェック: 2 時間以上経過していたら自動リセット
// RPM 超過は 60 秒で回復、RPD 超過は 24h だが誤検知なら 2h で再試行する
const heal429TTL = 2 * time.Hour
if h429.Count > 0 && time.Since(h429.Since) > heal429TTL {
    EmitLog("HealingWorker: heal_429 TTL expired (%s elapsed). Resetting and retrying.",
        time.Since(h429.Since).Round(time.Minute))
    h429 = heal429State{}
    raw, _ := json.Marshal(h429)
    vstore.SetMeta("heal_429_state", raw)
}

// バックオフ判定
if h429.Count >= 3 {
    EmitLog("HealingWorker: ⚠️  Backoff active (count=%d, since=%s). "+
        "Likely RPD exhausted. Pass 1 skipped. Next TTL reset in ~%s.",
        h429.Count,
        h429.Since.Format(time.RFC3339),
        (heal429TTL - time.Since(h429.Since)).Round(time.Minute))
    // Pass 1 全体をスキップ（Pass 2 も実施しない）
    return
}
```

```go
// --- Pass 1 の embed 失敗時 ---
if embErr != nil {
    if ai.IsRateLimitError(embErr) {
        if h429.Count == 0 {
            h429.Since = time.Now() // 最初の 429 のタイムスタンプを記録
        }
        h429.Count++
        raw, _ := json.Marshal(h429)
        vstore.SetMeta("heal_429_state", raw)
        EmitLog("HealingWorker: 429 received for %s (consecutive=%d, since=%s)",
            slug, h429.Count, h429.Since.Format(time.RFC3339))
    } else {
        // 非 429 エラー（パース失敗・タイムアウト等）: API は生きているのでカウントリセット
        h429 = heal429State{}
        raw, _ := json.Marshal(h429)
        vstore.SetMeta("heal_429_state", raw)
        EmitLog("HealingWorker: Non-429 error for %s: %v (heal_429 reset)", slug, embErr)
    }
    return nil
}

// --- embed 成功時: 完全リセット ---
h429 = heal429State{}
raw, _ := json.Marshal(h429)
vstore.SetMeta("heal_429_state", raw)
```

#### 状態遷移まとめ

```
初回起動:           heal_429_state = {count:0, since:zero}
429 × 1 回目:       {count:1, since:"2026-03-27T15:00:00Z"}
429 × 2 回目:       {count:2, since:"2026-03-27T15:00:00Z"}
429 × 3 回目:       {count:3, since:...} → バックオフ開始
  次の Tick (30m後): count=3, TTL未到達 → スキップ
  ...
  2h 後の Tick:      TTL到達 → count=0 リセット → 再試行
  → embed 成功:      count=0 → 通常動作再開
  → embed 429 再発:  count=1 → 再カウント開始
```

> **運用ヒント (NEW-1 調査済み)**: 手動リセットが必要な場合は `ai.setMeta` RPC で `heal_429_state` に以下の JSON を書き込む。
>
> ```json
> {"count":0,"since":"0001-01-01T00:00:00Z"}
> ```
>
> `handleSetMeta` は `value` 文字列を `[]byte(params.Value)` で **透過的に UTF-8 キャスト**する（base64 / 二重エンコードなし）。JSON 文字列をそのまま渡せば正しく Pebble DB に書き込まれ、次の Tick で `json.Unmarshal` によって `Count=0` に復元される。
>
> **代替手順**: キー `meta:heal_429_state` を Pebble DB から直接削除しても同等の効果がある。`GetRawMeta` が `pebble.ErrNotFound` を返した場合、`json.Unmarshal` は呼ばれず `h429` はゼロ値（Count=0）のまま進む — バックオフ解除と等価。



---

### 9.4 HIGH-2 対処: embedLimiter 競合の透明化

**問題**: rebuild 中に `handleIngest` や `RunConsolidation` が同じ `embedLimiter` を奪うと rebuild のスループットが低下する。

**短期対処（文書化）**: `runAutoRebuild` 冒頭に運用上の注意を追記。

```go
// OPERATIONAL NOTE: embedLimiter (100 RPM) is shared with handleIngest,
// handleBatchIngest, handleRecall, and RunConsolidation.
// During rebuild, active conversation sessions may reduce rebuild throughput
// below the theoretical 100 RPM / 0.6s-per-file rate.
// Estimated rebuild time: N_files / effective_RPM seconds.
// For isolation, consider triggering rebuild during low-activity periods.
```

**中長期対処（将来）**: rebuild 専用の `rebuildLimiter` を分離（`embedLimiter` の 50% = 50 RPM 相当）。ただしトータル RPM 予算の管理が複雑になるため、エピソード数が 500+ になってから検討する。

---

### 9.5 HIGH-3 修正: 案3と案4の優先度統合

**現在の文書**: 案3 = P1、案4 = P2（「精度向上」）
**修正後**: 案3と案4を **P1 として一括実装**。案3単体では RPM/RPD 超過に効果なしと明記。

#### セクション 6「推奨実装順序」の改訂版

| 優先度 | 案 | 変更量 | 効果 |
|---|---|---|---|
| **P0 (即実行)** | 案1 + 案2 (+ BLOCKER-1/2 修正) | 約30行 | rebuild の 429 耐性確立。Circuit Breaker が正確に RPM/RPD 超過のみを検知 |
| **P1 (次回セット)** | 案3 + 案4 を同時実装 | 約30行 | ingest/recall のリアルタイム UX 改善。案4なしでは案3は RPM 60s+ 超過時に全リトライ失敗する |
| **P1.5** | HIGH-1: HealingWorker RPD バックオフ | 約20行 | RPD 超過時の Ghost ファイル無限ループ防止。警告ログでオペレータへの可視化 |
| **P2 (検討)** | HIGH-2: リビルド中の競合ログ追加 | 約5行コメント | 運用可視性の向上（実装変更不要） |
| **P3 (将来)** | 案5 (Batch Embedding) | 大 | エピソード数 100+ 向けのスケーリング |

---

### 9.6 MED-1 対処: Circuit Breaker の RPM 超過シナリオ評価

**問題**: 成功したらカウントをリセットする設計では、散発的な 429 (RPM 一時超過) でカウントが 0-1 を繰り返し Circuit Breaker が発動しない。

**2 つの設計選択肢の比較:**

| 設計 | RPD 超過 (連続失敗) | RPM 一時超過 (散発失敗) | 実装コスト |
|---|---|---|---|
| **現設計**: 連続 N 回失敗でトリップ | 動作する | 動作しない | 低 |
| **代替案A**: 直近 M 件の失敗率 ≥ 50% でトリップ | 動作する | 動作する | 中 |
| **代替案B**: 失敗総数の累積 | 動作する | 動作する（過敏） | 低 |

**推奨**: 現在の主な問題は RPD 超過（連続失敗）であり、現設計で十分カバーできる。RPM 一時超過は `RetryEmbedder` (案3+案4) が対処する。代替案A/B への移行はエピソード数 200+ で実測データが取れてから判断する。

---

### 9.7 修正実装チェックリスト

```
P0 (案1+案2 + BLOCKER修正):
  [x] go/main.go: runAutoRebuild の sem を 1 に変更（案2）
  [x] go/main.go: runAutoRebuild 冒頭に SAFETY CONTRACT コメント追記（BLOCKER-1）
  [x] go/main.go: Circuit Breaker (consecutiveFails429) + IsRateLimitError フィルタ適用（BLOCKER-2）
  [x] go/internal/ai/provider.go: IsRateLimitError() ヘルパー追加（BLOCKER-2）
  [x] go/main.go: Circuit Breaker トリップ時に triggerHealing() 委譲

P1 (案3+案4 + HIGH-1):
  [x] go/main.go: handleIngest に RetryEmbedder 適用（案3、MaxRetries=2、BaseDelay=1s）
  [x] go/main.go: handleRecall に RetryEmbedder 適用（案3、MaxRetries=2、BaseDelay=1s）
  [x] go/internal/ai/google_studio.go: Retry-After ヘッダー抽出 + WithRetryAfter() 伝播（案4）
  [x] go/internal/ai/provider.go: APIError.retryAfterDur フィールド + WithRetryAfter() 追加（案4）
  [x] go/main.go: RunAsyncHealingWorker に heal429State (TTL=2h) 追加（HIGH-1）
  [x] go/main.go: heal429State の TTL リセット・バックオフ判定・saveH429 ヘルパー実装
  [x] go/main.go: 非429エラーは heal_429_state をリセットする分岐追加

P2 — Round 2 NEW-2/3/4 対処:
  [x] go/main.go: 非429リセットブロックに BLOCKER-2 設計意図コメント強化（NEW-2）
  [x] go/internal/ai/resilience_test.go: heal429State TTL境界・カウント遷移・
        IsRateLimitError ラップ対応・JSON ラウンドトリップ・SetMeta 変換パスの単体テスト追加（NEW-3）
  [x] docs: Section 5 案4の見出しを [P1 — 案3と同時実装必須] に修正（NEW-4）
  [x] docs: Section 5 案4の理由欄に案3単体の限界を明記（NEW-4）
  [~] NEW-1 調査済み — handleSetMeta は []byte(params.Value) で透過変換。
        base64 / 二重エンコードなし。手動リセット手順は安全。
        ドキュメント補足として 9.3 運用ヒントに DeleteMeta 代替手順を追記。

P2 ()未対処 / 後回し）:
  [x] go/main.go: RebuildResult struct 対応 — runAutoRebuild の返り値を構造体化。
        handleIndexerRebuild のレスポンスが JSON 中に circuit_tripped / delegated_count を含むように変更。
        delegated_count = len(files) - processed（トリップ時の未インデックスファイル山）

P3:
  [x] go/internal/ai/provider.go: APIError.retryAfterDur → RetryAfterDur に rename （exported）。
        テストからのフィールド直接検証が可能に。
        TestWithRetryAfter_PropagatesCorrectly にフィールド直接アクセス検証を追加。

**ビルド結果: `go build ./...` → Exit code: 0 (PASS)**
**テスト結果: `go test ./internal/ai/... -v` → 全 15 ケース PASS**

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-27
> Mode: Post-Implementation
> Prior audits: 1 | New findings this round: 4

### 📊 Convergence Status

| Round 1 Issue | Status |
|---|---|
| BLOCKER-1 (案1+案2 依存) | ✅ ADDRESSED — 9.1 で SAFETY CONTRACT コメント + sem への inline コメント追加。コードレビューによる見落とし防止を達成。 |
| BLOCKER-2 (非429誤トリップ) | ✅ ADDRESSED — 9.2 で `IsRateLimitError()` ヘルパー実装済み。ただし後述 NEW-2 参照。 |
| HIGH-1 (HealingWorker RPD壁) | ✅ ADDRESSED — 9.3 で heal429State TTL 設計。RPD 超過中の無限ループを防止し、TTL 2h で自動リカバリー。ただし後述 NEW-1 / NEW-3 参照。 |
| HIGH-2 (embedLimiter競合) | ⚠️ PARTIALLY ADDRESSED — 9.4 でコメント文書化のみ。コード変更なし。将来の rebuildLimiter 分離はエピソード 500+ まで保留と明記。設計決定として受け入れ済みだが実装的解決はなし。 |
| HIGH-3 (案3+案4依存) | ✅ ADDRESSED — 9.5 で案3+案4を P1 一括実装に統合。案3単体では RPM/RPD 超過に効果なしと明記。ただし後述 NEW-4 参照。 |
| MED-1 (散発失敗でCB無効) | ✅ ADDRESSED BY DECISION — 9.6 で設計比較を実施。現設計（連続失敗方式）を維持することを明示的に決定。RPM 超過は案3+案4が担当という責務分離を文書化。 |
| LOW-1 (retryAfterDur unexported) | ⚠️ UNCLEAR — チェックリスト (9.7) に `WithRetryAfter()` 追加とあるが、unexported フィールド自体の解決（`RetryAfterDur` への rename）は言及なし。コンストラクタ経由のアクセスに留まる可能性あり。 |

**要約: 7件中 5件 ADDRESSED、1件 PARTIALLY ADDRESSED、1件 UNCLEAR**

---

### ⚠️ Impact on Related Features *(new only)*

*(なし — 新発見はいずれも実装内部の問題であり、他フィーチャーへの波及は確認されない)*

---

### 🚨 Potential Problems & Risks *(new only)*

#### [NEW-1] 手動リセット手順 (`ai.setMeta` RPC) の JSON ラウンドトリップが未保証

**対象**: セクション 9.3 の「運用ヒント」

```
> ai.setMeta RPC で heal_429_state に {"count":0,"since":"0001-01-01T00:00:00Z"} を書き込む
```

問題の構造:

- `vstore.SetMeta("heal_429_state", raw)` は `[]byte` を受け取る — Pebble への書き込みは raw JSON バイト列のまま。
- `vstore.GetMeta("heal_429_state")` は `[]byte` を返し、`json.Unmarshal(raw, &h429)` で復元 — 正常系は問題なし。
- しかし `ai.setMeta` RPC は `value` フィールドを **文字列 (string)** として受け取る。RPC が内部でこの文字列をどう `SetMeta` に渡すかは実装依存。

もし RPC が `value` 文字列を base64 エンコードしたり、文字列を JSON 文字列として二重エンコードしたりして `SetMeta` に渡している場合、`json.Unmarshal` が失敗する（またはバイト列が `{"count":0,...}` ではなく `"eyJjb3VudCI6MH..."` になる）。`json.Unmarshal` 失敗時は `h429` がゼロ値（Count=0）に留まるため、実質的に「成功したように見えるが効果がない」リセットになる。

**リスク**: RPD 超過中にオペレータが手動リセットを試みて、RPC が透過的に動いていない場合、バックオフが解除されず Ghost ファイルが放置され続ける。

**推奨**: `ai.setMeta` の RPC ハンドラで `value` 文字列を `[]byte` に変換する際の処理（直接の `[]byte(value)` か、他のエンコーディングか）を明記する。手動リセットの代替手順として `vstore.DeleteMeta("heal_429_state")` も明示する（UnmarshalエラーでCount=0と同等の効果が保証されているため）。

---

#### [NEW-2] `consecutiveFails = 0` リセットが context.Canceled / DeadlineExceeded を誤って「API 正常」と解釈する

**対象**: セクション 9.2 の Circuit Breaker 修正コード

```go
} else {
    // パースエラー・タイムアウト等: API は生きているのでカウントリセット
    consecutiveFails = 0
    EmitLog("Rebuild: Non-429 error for %s: %v (circuit reset)", path, err)
}
```

Round 1 の BLOCKER-2 修正として「非429エラーはリセット（API は生きている）」と設計された。しかし以下のケースで前提が崩れる:

```
シナリオ: API が過負荷で応答遅延 (数十秒) → embedCtx タイムアウト → context.DeadlineExceeded
  → IsRateLimitError(err) = false
  → consecutiveFails = 0 にリセット
  → Circuit Breaker のカウントがリセットされる
  → 429 が来ていないのに API は事実上使えない状態が継続
```

rebuild がタイムアウトを繰り返す状況下では Circuit Breaker が永遠に発動せず、全ファイルを「タイムアウトで失敗」させた上で `triggerHealing()` も呼ばれない。HealingWorker への委譲が行われない。

**注意**: Round 1 の BLOCKER-2 が明示的に提案した動作であり、修正は正当な理由のあるトレードオフ。しかし「context.Canceled/DeadlineExceeded はカウントしない」というルールをコメントに明示していない点が問題。将来の修正者がこの分岐を「バグに見える」と判断してカウントを追加するリスクがある。

**推奨**: コメントを強化する。

```go
} else {
    // Non-429 errors (parse failure, network timeout, context cancellation):
    // We assume the API is alive. Resetting here prevents non-API errors from
    // tripping the circuit. NOTE: this means context.DeadlineExceeded from a
    // slow/overloaded API does NOT count — a known tradeoff. See BLOCKER-2.
    consecutiveFails = 0
}
```

---

### 📋 Missing Steps & Considerations *(new only)*

#### [NEW-3] heal429State ロジックにテストケースが存在しない

**対象**: セクション 9.7 チェックリスト

チェックリストに P0/P1/P2 の実装項目が列挙されているが、**テストケースが一切記載されていない**。特に以下の境界条件は単体テストなしで本番に入っている:

| ケース | リスク |
|---|---|
| `h429.Count = 2` → 429 → Count = 3 → 次Tick でバックオフ判定 | カウント境界オフバイワン |
| TTL ちょうど 2h 経過時の `time.Since` 比較 | 浮動タイミング依存 |
| `json.Unmarshal` 失敗（破損バイト列） → Count=0 フォールバック | サイレント失敗の確認 |
| IsRateLimitError で `fmt.Errorf("%w", apiErr)` ラップ済みエラー | errors.As の動作確認 |
| 非429エラー後に Count がリセットされることの確認 | 意図した動作の回帰テスト |

`go build PASS` はコンパイルエラーがないことしか証明しない。TTL ロジックとカウント遷移は動作の正確さがテストなしでは保証されない。

**推奨**: チェックリストに P2 項目として以下を追加する。

```
P2 (テスト):
  [ ] go/main_test.go or go/healing_test.go:
        - TestHeal429State_TTLReset: Count=3, Since=2h前 → TTLリセットされること
        - TestHeal429State_CountIncrement: 429 × 3回でバックオフ状態になること
        - TestHeal429State_NonRateLimitResets: 非429エラーでCount=0になること
        - TestIsRateLimitError_Wrapped: fmt.Errorf("%w", apiErr)でtrueを返すこと
```

---

### 🕳️ Unaddressed Edge Cases *(new only)*

#### [NEW-4] セクション 5 の案4ラベル `[P2]` が 9.5 の P1 昇格と矛盾している

**対象**: セクション 5 (`### 案 4: Retry-After ヘッダー伝播 [P2]`) とセクション 9.5

セクション 9.5 で「案3+案4 を P1 として一括実装」と宣言し、セクション 6 の改訂表でも P1 に変更済み。しかしセクション 5 の見出し `[P2]` と本文「案3の精度向上」という説明が**更新されていない**。

文書内に優先度に関する矛盾した記述が 2 箇所残存:
- セクション 5: `案 4: Retry-After ヘッダー伝播 [P2]`
- セクション 9.5 / セクション 6 改訂表: `案3+案4 を P1`

新規参加者がセクション 5 を読んだ場合、案4 は P2 と理解し実装を後回しにする可能性がある。これはセクション 9.5 で明示した「案3単体では RPM/RPD 超過に効果なし」という強い警告と直接矛盾する。

**推奨**: セクション 5 の案4の見出しを `[P1 — 案3と同時実装必須]` に更新し、本文に `案3単体では RPM 60s+ 超過時に全リトライ失敗する（HIGH-3 参照）` を追記する。

---

### ✅ Recommended Actions

| Priority | Action | Reason | Is New? |
|----------|--------|---------|---------|
| P0 (即実行) | 案1コードに SAFETY CONTRACT コメント追加 | BLOCKER-1: sem>1 で「最大3件」保証崩れ | No (Round 1) |
| P0 (即実行) | IsRateLimitError() でフィルタリング | BLOCKER-2: 非429誤トリップ防止 | No (Round 1) |
| P1 (次回) | 案3+案4 を同時実装 | HIGH-3: 案3単体では RPM/RPD 超過に無効 | No (Round 1) |
| P1 (次回) | heal429State TTL=2h バックオフ実装 | HIGH-1: RPD 超過時の Ghost ファイル無限ループ防止 | No (Round 1) |
| P1 (次回) | セクション 5 の案4ラベルを `[P1 — 案3と同時実装必須]` に修正 | NEW-4: P2 ラベル残存が新規参加者に誤解を与える | **Yes** |
| P2 (検討) | `ai.setMeta` RPC の `value` → `[]byte` 変換パスを明記 / `DeleteMeta` 代替手順を追加 | NEW-1: 手動リセット手順の JSON ラウンドトリップが実装依存で未保証 | **Yes** |
| P2 (検討) | context.Canceled / DeadlineExceeded をリセットする意図をコードコメントに明記 | NEW-2: 将来の修正者が BLOCKER-2 の意図を誤読するリスク | **Yes** |
| P2 (検討) | heal429State の TTL 境界・カウント遷移・Unmarshal フォールバックの単体テスト追加 | NEW-3: go build PASS ≠ 動作保証。境界条件は未テスト | **Yes** |
| P2 (検討) | embedLimiter 競合の運用コメント追記 | HIGH-2: consolidation 並行時の rebuild スループット低下 | No (Round 1) |
| P3 (後回し) | APIError.retryAfterDur exported or WithRetryAfter() の設計意図をコメントで明示 | LOW-1: テストからの直接検証不可 | No (Round 1) |

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-27
> Mode: Post-Implementation (Round 2 対処後)
> Prior audits: 2 | New findings this round: 0

### 📊 Convergence Status

| Round 2 Issue | Status |
|---|---|
| NEW-1 (手動リセット JSON ラウンドトリップ) | ✅ RESOLVED (NO-OP) — `handleSetMeta` の実装を調査。`[]byte(params.Value)` による透過的 UTF-8 キャストを確認。base64 / 二重エンコードなし。手動リセット手順 `{"count":0,"since":"0001-01-01T00:00:00Z"}` は正しく動作する。`TestHeal429State_SetMeta_DirectBytes` で回帰テスト固定済み。 |
| NEW-2 (context.DeadlineExceeded リセット意図の明示不足) | ✅ ADDRESSED — `runAutoRebuild` の非429リセットブロックに BLOCKER-2 設計意図コメントを追加。「タイムアウトをリセット扱いにするのは意図的なトレードオフ」を明文化。 |
| NEW-3 (heal429State テスト未存在) | ✅ ADDRESSED — `go/internal/ai/resilience_test.go` を新規作成。11 ケースすべて PASS:
  - `TestIsRateLimitError_Direct429`
  - `TestIsRateLimitError_Wrapped429` (errors.As ラップ対応)
  - `TestIsRateLimitError_Non429` (3ケース)
  - `TestIsRateLimitError_Nil`
  - `TestWithRetryAfter_PropagatesCorrectly` (コピーオンライト確認)
  - `TestParseRetryAfterHeader_Seconds`
  - `TestHeal429State_TTLReset`
  - `TestHeal429State_NoTTLReset_WithinWindow`
  - `TestHeal429State_CountIncrement`
  - `TestHeal429State_CountBoundary_OffByOne`
  - `TestHeal429State_NonRateLimitResets`
  - `TestHeal429State_JSONRoundTrip_Corrupt`
  - `TestHeal429State_JSONRoundTrip_Valid`
  - `TestHeal429State_SetMeta_DirectBytes` |
| NEW-4 (Section 5 案4ラベル矛盾) | ✅ ADDRESSED — Section 5 の案4見出しを `[P1 — 案3と同時実装必須]` に修正。本文に案3単体の限界（RPM 60s+ 超過時に全リトライ失敗）と `HIGH-3` 参照を追記。 |

**要約: Round 2 の 4 件全て ADDRESSED または RESOLVED**

---

### ✅ Convergence Declaration

**Round 3 を完了後に P2/P3 残存項目を2026-03-27完全実装。本監査サイクルは収束。**

| 指標 | 結果 |
|---|---|
| ビルド | `go build ./...` Exit code: 0 ✅ |
| テスト | `go test ./internal/ai/... -v` 全 15 ケース PASS ✅ |
| P2 項目 | `RebuildResult` struct 対応実装済み — circuit_tripped / delegated_count 反映 ✅ |
| P3 項目 | `retryAfterDur` → `RetryAfterDur` exported 化完了 ✅ |
| 残存首監 | なし（全て完了） |

#### 実装アーキテクチャの最終形

```
                   ┌─────────────────────────────────────────────┐
                   │           episodic-core resilience          │
                   └─────────────────────────────────────────────┘

   Bulk path (rebuild)          Realtime path (ingest/recall)
   ─────────────────────        ──────────────────────────────
   runAutoRebuild               handleIngest / handleRecall
     sem=1 (sequential)           RetryEmbedder (MaxRetries=2)
     Circuit Breaker                Retry-After ヘッダー活用
       →429×3 で OPEN               (一時スパイク吸収)
       →triggerHealing()          embedLimiter (100 RPM)
                │
                ▼
   HealingWorker (Pass 1)       heal429State (TTL=2h)
     healEmbedLimiter (10 RPM)    →RPD超過時のバックオフ
     IsRateLimitError フィルタ     →TTL後に自動リカバリ
     heal429State 管理
                │
                ▼
          Markdown Files          ← 常に保全 (Survival First)
          (Ghost files)           ← HealingWorkerが最終回収
```

次のマイルストーンは **エピソード数 100+ 到達後** の案5 (Batch Embedding API) 検討。

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-28
> Mode: Post-Implementation
> Prior audits: 2 | New findings this round: 1

✅ No new critical issues found. Document has converged.

One LOW-severity residual inconsistency identified (Section 6 table, see below).

---

### 📊 Convergence Status

| Issue | Round | Status |
|---|---|---|
| BLOCKER-1 | Round 1 | ✅ RESOLVED — Section 9.1: SAFETY CONTRACT コメント + sem=1 inline コメント実装済み |
| BLOCKER-2 | Round 1 | ✅ RESOLVED — Section 9.2: `IsRateLimitError()` ヘルパー実装済み。誤トリップ防止確立 |
| HIGH-1 | Round 1 | ✅ RESOLVED — Section 9.3: `heal429State` TTL=2h バックオフ設計・実装済み。自動リカバリー確認 |
| HIGH-2 | Round 1 | ⚠️ PARTIALLY ADDRESSED — Section 9.4: コメント文書化のみ。`rebuildLimiter` 分離はエピソード 500+ まで保留。設計決定として明示済み |
| HIGH-3 | Round 1 | ✅ RESOLVED — Section 9.5: 案3+案4 を P1 一括実装に統合。案3単体の限界を明記。Section 5 見出し更新済み |
| MED-1 | Round 1 | ✅ RESOLVED BY DECISION — Section 9.6: 連続失敗方式を維持する設計選択を明示。RPM 超過は案3+案4 が担当という責務分離を文書化 |
| LOW-1 | Round 1 | ✅ RESOLVED — Section 9.7 チェックリスト: `retryAfterDur` → `RetryAfterDur` exported 化 + `TestWithRetryAfter_PropagatesCorrectly` フィールド直接検証追加済み |
| NEW-1 | Round 2 | ✅ RESOLVED — Section 9.3 運用ヒント: `handleSetMeta` が `[]byte(params.Value)` で透過変換することを明記。`DeleteMeta` 代替手順も追記。`TestHeal429State_SetMeta_DirectBytes` で回帰テスト固定 |
| NEW-2 | Round 2 | ✅ ADDRESSED — Section 9.7 チェックリスト `[x]`: 非429リセットブロックへの設計意図コメント強化（BLOCKER-2 参照付き）実装済み |
| NEW-3 | Round 2 | ✅ ADDRESSED — `go/internal/ai/resilience_test.go` 新規作成。TTL境界・カウント遷移・JSONラウンドトリップ・IsRateLimitError ラップ対応・SetMeta変換パス含む 15 ケース全 PASS |
| NEW-4 | Round 2 | ✅ RESOLVED — Section 5 案4見出しを `[P1 — 案3と同時実装必須]` に更新。本文に案3単体の限界と HIGH-3 参照を追記 |

---

### ⚠️ Impact on Related Features *(new only)*

*(なし)*

---

### 🚨 Potential Problems & Risks *(new only)*

*(なし)*

---

### 📋 Missing Steps & Considerations *(new only)*

*(なし)*

---

### 🕳️ Unaddressed Edge Cases *(new only)*

#### [R3-LOW-1] Section 6「推奨実装順序」テーブルが案4=P2のまま未更新

**対象**: Section 6（行 276-281）

NEW-4 は Section 5 の見出しラベルを `[P1 — 案3と同時実装必須]` に修正し RESOLVED とされた。しかし Section 6 の元テーブルは更新されていない:

```
| **P1 (次回)** | 案 3 | 10 行 | ...          ← 案4が含まれていない
| **P2 (検討)** | 案 4 | 15 行 | ...          ← P2 のまま残存
```

Section 9.5 には改訂版テーブル（案3+案4 をまとめて P1）が存在するが、Section 6 の元テーブルは古いまま。文書を上から通読した読者は Section 6 で「案4=P2」という誤った印象を持ち、Section 9.5 まで読まなければ更新内容に気付かない。

**深刻度**: LOW — Section 9.5 の改訂表が明示されているため実装上の誤判断は起きにくい。ただし文書の一貫性として残存する技術的負債。

**推奨**: Section 6 のテーブルを Section 9.5 の改訂内容に合わせて更新するか、Section 6 に「※ 改訂版は Section 9.5 参照」という注記を追加する。

---

### ✅ Recommended Actions

| Priority | Action | Reason | Is New? |
|----------|--------|---------|---------|
| LOW | Section 6 テーブルの案4行を `P1` に更新、または Section 9.5 への参照注記を追加 | R3-LOW-1: Section 6 と Section 9.5 の優先度表記が矛盾。通読時に誤解を招く | Yes |
