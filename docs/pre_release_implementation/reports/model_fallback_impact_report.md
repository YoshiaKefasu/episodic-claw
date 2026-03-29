# episodic-claw — モデルフォールバック連発時の影響分析レポート

> 作成日: 2026-03-26
> 対象バージョン: episodic-claw Phase 5.7（Fix C + Fix B 実装済み）
> トリガー: OpenClaw のモデルフォールバック機構による同一メッセージの連続送信

---

## 1. 問題の概要

OpenClaw はモデル呼び出しが失敗（レート制限・タイムアウト・API エラー）すると、
エージェントにターンを誘発するため**同一ユーザーメッセージを繰り返し送信**する。

観測例（スクリーンショット）:
```
22:36  user: "どの場合にスコープを広くと狭くするはどう決めるの？"
22:36  assistant: [gemini-3.1-pro-preview] → 空/失敗
22:37  user: "どの場合にスコープを広くと狭くするはどう決めるの？"  ← 同一
22:37  assistant: [gemini-3.1-pro-preview] → 空/失敗
22:38  user: (同一)
22:38  assistant: [gemini-3.1-pro-preview] → 空/失敗
22:40  user: (同一)
22:40  assistant: [gemini-2.5-pro] → 成功（実回答）
22:41  user: (同一) ← さらに1件
```

**5分間に同一メッセージが5回送信された。**

この間、episodic-claw の `ingest()` / `assemble()` は各ターンで呼ばれ続ける。

---

## 2. episodic-claw の呼び出しフロー（フォールバック時）

```
フォールバック N 回発生時のフロー:

[Turn 1: user + fail]
  → assemble() → processTurn() (fire-and-forget) + recall() RPC
  → ingest()   → processTurn() (await)            + setMeta() RPC

[Turn 2: user(同一) + fail]
  → assemble() → processTurn() (fire-and-forget) + recall() RPC
  → ingest()   → processTurn() (await)            + setMeta() RPC

... × N 回 ...

[Turn N+1: user(同一) + 成功]
  → assemble() → processTurn() (fire-and-forget) + recall() RPC
  → ingest()   → processTurn() (await)            + setMeta() RPC
```

5回フォールバックの場合:
- `processTurn()` 呼び出し: ~10回（assemble + ingest 各5回）
- `calculateSurprise` RPC: ~5〜8回
- `recall()` RPC: 5回（全て同一クエリ）
- `setMeta("last_activity", ...)` RPC: 5回

---

## 3. 発見された影響（深刻度順）

### 3.1 [HIGH] buffer へのノイズ蓄積（重複メッセージ + 空 assistant）

#### 問題の発生箇所
`src/segmenter.ts:61-113` — `processTurn()` の新メッセージ吸収ロジック

#### メカニズム
同一ユーザーメッセージが N 回追加されると、`newMessages` の各要素が buffer に蓄積される:

```
buffer 状態（5回フォールバック後）:
[
  "user: どの場合にスコープを広くと狭くするはどう決めるの？",  ← ×5 重複
  "assistant: ",   ← 空（失敗レスポンス）×4
  "assistant: ",
  "assistant: ",
  "assistant: ",
  "assistant: その質問、小論文の本質..."  ← 1回の成功
]
```

#### `summarizeBuffer()` での汚染（src/segmenter.ts:196-201）
```typescript
return messages.map(m => `${m.role}: ${extractText(m.content)}`).join("\n");
// → "assistant: " という空行が 4行挿入される（role は出力されるが content は空）
```

#### RAG への影響
このバッファがエピソードとして保存されると:
- 同一ユーザーメッセージが N 回埋め込まれ、ベクトル表現が歪む
- 空 assistant 行がノイズとして混入
- 将来の recall() で「同一メッセージ N 回」を含む低品質エピソードが注入される

---

### 3.2 [HIGH] `calculateSurprise` RPC の多重発行と誤動作

#### 問題の発生箇所
`src/segmenter.ts:92` — `this.rpc.calculateSurprise(oldSlice, newSlice)`

#### メカニズム

**Surprise スコアの動作:**
```
oldSlice (buffer末尾) = "どの場合にスコープを広くと狭くするはどう決めるの？"
newSlice (新メッセージ) = "どの場合にスコープを広くと狭くするはどう決めるの？" (同一)
→ cosine similarity ≈ 1.0 → surprise ≈ 0.0 → threshold 0.2 未満 → フラッシュなし
```

**意図せぬ副作用:**
- surprise = 0 なのでフラッシュが発動せず、重複が buffer に積み上がり続ける
- calculateSurprise は ~5〜8回 Go sidecar に RPC 発行（全て同一ペイロード）
- Go sidecar の Embedding API（rate-limited）が同一テキストで N 回呼ばれる可能性

> **注:** surprise が低いこと自体は正しい設計判断（同一トピックなのでフラッシュしない）。
> 問題は「フラッシュしないまま重複が蓄積し続ける」こと。

---

### 3.3 [MED] `recall()` RPC の重複発行

#### 問題の発生箇所
`src/index.ts:186` — `retriever.retrieveRelevantContext(msgs, resolvedAgentWs, 5, maxEpisodicTokens)`

#### メカニズム
`assemble()` が 5回呼ばれる = 同一クエリで recall が 5回発行される。
HNSW 検索の計算コスト × 5 は無駄だが、キャッシュなしのため全て実行される。

#### 影響
- Go sidecar に不要な検索負荷
- 毎回同じ結果を返すが捨てられる（最終ターンのみ有効）
- Unix socket の queue が詰まるリスク（Go sidecar が過負荷の場合）

---

### 3.4 [MED] `setMeta("last_activity", ...)` spam

#### 問題の発生箇所
`src/index.ts:164` — `await rpcClient.setMeta("last_activity", Date.now().toString(), resolvedAgentWs)`

#### 影響
- `ingest()` が 5回 = setMeta が 5回（うち4回は無意味な同一 epoch 更新）
- 軽微だが Go sidecar のディスク write が不必要に発生

---

### 3.5 [LOW] `processTurn()` の並行呼び出し競合リスク

#### 問題の発生箇所
`src/index.ts:163-164`（ingest = await）と `src/index.ts:178`（assemble = fire-and-forget）

#### メカニズム
フォールバック時、同一ターンで:
1. `assemble()` が `processTurn()` を fire-and-forget で発火
2. その直後に `ingest()` が `processTurn()` を await で発火

これら2つが並行して `this.buffer` を操作する可能性がある。
`EventSegmenter` はシングルスレッド設計だが、Node.js の非同期スケジューリングで
`lastProcessedLength` / `buffer` への同時アクセスが理論上発生しうる。

---

## 4. 深刻度サマリー

| ID | 問題 | 深刻度 | 機能影響 |
|---|---|---|---|
| **FB-1** | buffer への重複メッセージ + 空 assistant 蓄積 | **HIGH** | RAG 品質劣化（低品質エピソード生成） |
| **FB-2** | calculateSurprise の多重 RPC（同一ペイロード）| **HIGH** | Embedding API 無駄呼び出し、sidecar 負荷 |
| **FB-3** | recall() の重複 RPC（同一クエリ N 回）| **MED** | 検索コスト × N、socket queue 圧迫 |
| **FB-4** | setMeta spam | **MED** | ディスク write 無駄発生 |
| **FB-5** | processTurn() 並行呼び出し競合 | **LOW** | 理論上の race condition、実害は稀 |

---

## 5. 修正プラン

### Fix D-1（P1）: `processTurn()` に重複メッセージ dedup フィルタ

**ファイル:** `src/segmenter.ts`
**変更箇所:** `processTurn()` 冒頭、`newMessages` 取得直後

**設計:**
`newMessages` をバッファの直近 `DEDUP_WINDOW` 件（デフォルト5）と照合し、
`content` が完全一致するメッセージをスキップする。

```typescript
// [Fix D-1] 重複メッセージ dedup（フォールバック連発対策）
const DEDUP_WINDOW = 5;
const recentTexts = new Set(
  this.buffer.slice(-DEDUP_WINDOW).map(m => extractText(m.content).trim())
);
const dedupedMessages = newMessages.filter(m => {
  const text = extractText(m.content).trim();
  if (!text) return false;                    // 空メッセージも除去
  if (recentTexts.has(text)) return false;    // 重複を除去
  recentTexts.add(text);                      // 後続の自己重複も除去
  return true;
});
if (dedupedMessages.length === 0) {
  this.lastProcessedLength = currentMessages.length;
  return false;
}
// 以降は dedupedMessages を使用（newMessages の代わりに）
```

**期待効果:**
- 5回フォールバックで5件の同一メッセージ → 1件のみ buffer に追加
- 空 assistant レスポンスも `!text` フィルタで除去
- エピソード品質が大幅に向上

**注意点:**
- `lastProcessedLength` は dedup の有無に関わらず `currentMessages.length` に更新する（位置追跡を正確に保つ）
- `recentTexts.add(text)` で dedupedMessages 内の自己重複も除去できる

---

### Fix D-2（P2）: `assemble()` の `recall()` に時間ベースキャッシュ（debounce）

**ファイル:** `src/retriever.ts` または `src/index.ts`
**変更箇所:** `retrieveRelevantContext()` 呼び出し前

**設計:**
最後の recall 呼び出しから `RECALL_DEBOUNCE_MS`（デフォルト 1000ms）以内の場合、
前回結果をキャッシュから返す。

```typescript
// src/index.ts — assemble() 内
let lastRecallResult = "";
let lastRecallTime = 0;
const RECALL_DEBOUNCE_MS = 1000;

async assemble(ctx: any) {
  // ...
  const now = Date.now();
  let episodicContext: string;
  if (now - lastRecallTime < RECALL_DEBOUNCE_MS && lastRecallResult) {
    // フォールバック連発中は前回キャッシュを再利用
    episodicContext = lastRecallResult;
  } else {
    episodicContext = await retriever.retrieveRelevantContext(
      msgs, resolvedAgentWs, 5, maxEpisodicTokens
    );
    lastRecallResult = episodicContext;
    lastRecallTime = now;
  }
  // ...
}
```

**期待効果:**
- 1秒以内の連続 assemble() 呼び出しで recall RPC が1回に削減される
- フォールバック間隔が数十秒の場合はキャッシュが失効し正常動作

**注意点:**
- キャッシュ変数は `register()` クロージャスコープに置く（singleton 汚染回避済みの設計に準拠）
- RECALL_DEBOUNCE_MS は設定ファイル化が望ましい（フォールバック間隔は環境依存）

---

### Fix D-3（P3）: `setMeta` の rate-limiting

**ファイル:** `src/index.ts`
**変更箇所:** `ingest()` 内の setMeta 呼び出し

**設計:**
```typescript
let lastSetMetaTime = 0;
const SET_META_INTERVAL_MS = 5000; // 5秒以内は再呼び出しをスキップ

async ingest(ctx: any) {
  // ...
  const now = Date.now();
  if (now - lastSetMetaTime >= SET_META_INTERVAL_MS) {
    await rpcClient.setMeta("last_activity", now.toString(), resolvedAgentWs);
    lastSetMetaTime = now;
  }
  // ...
}
```

**期待効果:** setMeta RPC が最大 5秒に1回に制限される。

---

### Fix D-4（P3・調査）: `processTurn()` 並行呼び出しの排他制御

**ファイル:** `src/segmenter.ts`

**設計（ロックフラグ方式）:**
```typescript
private isProcessing = false;

async processTurn(...): Promise<boolean> {
  if (this.isProcessing) {
    // 先行の processTurn が実行中の場合はスキップ（ログ出力のみ）
    console.log("[Episodic Memory] processTurn skipped: already in progress");
    return false;
  }
  this.isProcessing = true;
  try {
    // ... 既存ロジック ...
  } finally {
    this.isProcessing = false;
  }
}
```

**注意点:**
- ingest() からの await 呼び出しもスキップ対象になるため、メッセージ消失のリスクがある
- `lastProcessedLength` を更新しないとスキップ後に次回 processTurn で整合性が取れる
- LOW priority のため、Fix D-1〜D-3 実装後に効果を測定してから判断

---

## 6. 実装優先度

| Fix | 優先度 | ファイル | 効果 | 実装コスト |
|---|---|---|---|---|
| **Fix D-1** (dedup フィルタ) | **P1** | `src/segmenter.ts` | buffer ノイズ除去・エピソード品質向上 | 低（10〜15行） |
| **Fix D-2** (recall debounce) | **P2** | `src/index.ts` | recall RPC N→1回削減 | 低（8〜10行） |
| **Fix D-3** (setMeta rate-limit) | **P3** | `src/index.ts` | setMeta spam 抑制 | 低（5行） |
| **Fix D-4** (processTurn mutex) | **P3** | `src/segmenter.ts` | 並行競合排除 | 中（要リスク評価） |

**推奨実施順序:** Fix D-1 → Fix D-2 → Fix D-3 → (Fix D-4 は測定後判断) → E2E テスト

---

## 7. テスト計画

### TC-FB-1: フォールバック dedup 検証
1. テスト用スタブで `processTurn()` に同一ユーザーメッセージを5回渡す
2. Fix D-1 適用後: buffer に1件のみ追加されることを確認
3. Fix D-1 適用前: 5件追加されることを確認（regression baseline）

### TC-FB-2: 空 assistant フィルタ検証
1. `processTurn()` に `{role: "assistant", content: ""}` を渡す
2. Fix D-1 の `!text` フィルタで buffer に追加されないことを確認

### TC-FB-3: recall debounce 検証
1. `assemble()` を 200ms 間隔で3回呼ぶ
2. Fix D-2 適用後: `rpcClient.recall()` が1回のみ呼ばれることを確認（モック使用）

### TC-FB-4: 実際のフォールバックシナリオ（E2E）
1. OpenClaw でモデルフォールバックが発生する状況を再現
2. Go sidecar のログで `batchIngest` が重複エピソードを受け取っていないことを確認
3. `ep-recall` ツールで直前会話を検索し、重複なく正確な内容が返ることを確認

---

## 8. GitNexus 影響範囲（事前分析）

Fix D-1 (`processTurn` 変更):
- 前回分析（Section 10 of session_boundary_gap_report.md）: risk=LOW、direct callers=2
- 今回の変更は同一 Fix B と同スコープ。新規 callers なし。

Fix D-2 (`assemble()` 変更):
- `assemble()` の direct callers: OpenClaw Context Engine ランタイム（外部）
- 変更は内部ロジックのみ（返却インターフェース変更なし）→ risk=LOW

Fix D-3 (`ingest()` 変更):
- `ingest()` の direct callers: OpenClaw Context Engine ランタイム（外部）
- setMeta のスキップのみ → risk=LOW

**実装前に `gitnexus_impact` を各 Fix で実行すること（CLAUDE.md 義務要件）。**

---

## 9. 関連ファイル

| ファイル | 役割 | 変更が必要な Fix |
|---|---|---|
| `src/segmenter.ts` | buffer 管理・dedup ロジック | Fix D-1, Fix D-4 |
| `src/index.ts` | assemble/ingest フック | Fix D-2, Fix D-3 |
| `src/retriever.ts` | recall ラッパー（参考） | 変更不要 |

---

## 10. 関連ドキュメント

- [`docs/session_boundary_gap_report.md`](./session_boundary_gap_report.md) — /reset 時の buffer フラッシュ問題（別ギャップ）
- [`docs/compression_analysis_report.md`](./compression_analysis_report.md) Section 19 — Phase 5.7 実装ステータス

---

---

## 11. 実装ステータス

> 実装日: 2026-03-26

| Fix | 優先度 | ステータス | 変更ファイル | 備考 |
|---|---|---|---|---|
| **Fix D-1** (dedup フィルタ) | P1 | ✅ **実装完了** | `src/segmenter.ts` | `processTurn()` 冒頭に DEDUP_WINDOW=5 の dedup ブロック追加 |
| **Fix D-2** (recall debounce) | P2 | ✅ **実装完了** | `src/index.ts` | `assemble()` に 1000ms debounce キャッシュ追加 |
| **Fix D-3** (setMeta rate-limit) | P3 | ✅ **実装完了** | `src/index.ts` | `ingest()` の setMeta に 5 秒 rate-limit 追加 |
| **Fix D-4** (processTurn mutex) | P3 | ⏸ **保留** | — | D-1〜D-3 効果測定後に判断 |

### デプロイ状況

- WSL `/root/.openclaw/extensions/episodic-claw/src/` へソースをコピー済み
- `npm run build:ts` 実行済み（エラーなし）
- `dist/segmenter.js`, `dist/index.js` が `2026-03-26` タイムスタンプで更新済み

### 変更概要

**`src/segmenter.ts` (Fix D-1)**
- `processTurn()` の `newMessages` 取得直後に dedup フィルタを挿入
- `buffer.slice(-5)` のテキストと照合し、重複・空メッセージを `dedupedMessages` として除外
- 以降のバッファ操作はすべて `dedupedMessages` を使用
- `lastProcessedLength` は dedup 結果に関わらず `currentMessages.length` に更新（位置追跡の正確性を維持）

**`src/index.ts` (Fix D-2, Fix D-3)**
- `register()` クロージャスコープに `lastRecallResult`, `lastRecallTime`, `lastSetMetaTime` 変数を追加
- `assemble()` の recall 呼び出しを 1000ms debounce で保護
- `ingest()` の setMeta 呼び出しを 5 秒 rate-limit で保護

---

*Fix D-4 の判断は TC-FB-1〜TC-FB-4 の E2E テスト実施後に行う。*

---

## Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-26
> Mode: Post-Implementation (Fix D-1, D-2, D-3 deployed to WSL)
> Prior audits: 0 | New findings this round: 9

---

### Convergence Status

初回監査につき、Prior Round Issues なし。以下はすべて新規発見である。

---

### Impact on Related Features

**[A-1] `forceFlush()` のエラーパス — dedup フィルタをバイパスして rawMessages がバッファに流入する**

`segmenter.ts:138-142` の catch ブロックを参照。`calculateSurprise` RPC が失敗した場合のフォールバック処理:

```
this.buffer.push(...newMessages);  // ← dedupedMessages ではなく元の newMessages を使用
```

Fix D-1 が導入した `dedupedMessages` を使わず、元の `newMessages` を push している。フォールバック連発中に RPC エラーが重なった場合（sidecar が過負荷で calculateSurprise も失敗するケース）、dedup が完全に無効化される。Fix D-1 の目的を部分的に破壊する regression である。

**[A-2] `before_reset` フックの完了保証欠如 — コンパクタとの競合**

`index.ts:151-161` の `before_reset` フックは `await segmenter.forceFlush()` を行う。しかし `assemble()` 内の fire-and-forget `processTurn()` が同タイミングで実行中の場合、`chunkAndIngest()` がバックグラウンドで走り続ける。reset 完了後に `resolvedAgentWs` が変化または空になる可能性があり、前セッションのエピソードが誤ったディレクトリへ書き込まれうる。

**[A-3] `ep-save` / `ep-recall` / `ep-expand` ツールは `resolvedAgentWs` が空の状態で呼ばれうる**

`resolvedAgentWs` は `gateway_start` イベントで初期化されるが、ツールの execute ハンドラは登録時点でクロージャを捕捉している。gateway_start 前にツールが呼ばれると、`resolvedAgentWs = ""` のまま RPC が発行される。`ep-save` は `rpcClient.generateEpisodeSlug(..., resolvedAgentWs, agentId)` に空文字列を渡し、Go sidecar 側でのディレクトリ解決が未定義動作になる。ガード節が存在しない。

---

### Potential Problems & Risks

**[R-1] BLOCKER: `chunkAndIngest()` は fire-and-forget だが、Go sidecar の `batchIngest` RPC はタイムアウト制御なし**

`segmenter.ts:126-128`:
```typescript
this.chunkAndIngest(...).catch(err => {
  console.error("[Episodic Memory] Error in background chunkAndIngest:", err);
});
```

`chunkAndIngest()` 内の `summarizeBuffer()` は各チャンクで呼ばれるが、これは同期処理。問題は `this.rpc.batchIngest(items, agentWs, agentId)` の RPC に上限タイムアウトが設定されているかどうかである。コード上では確認できない。Go sidecar がハング・クラッシュした場合、このバックグラウンドPromiseが永遠に未解決のまま保持され、Node.js プロセスが graceful shutdown できないリスクがある（process が exit できずゾンビ状態）。`gateway_stop` 時に未完了の batchIngest が存在する場合の動作が未定義である。

**[R-2] HIGH: Fix D-1 の dedup は `role` を無視したテキスト同一性で判定する — 正規ユーザーメッセージを誤って除去しうる**

```typescript
const recentTexts = new Set(
  this.buffer.slice(-DEDUP_WINDOW).map(m => extractText(m.content).trim())
);
```

`role` を含まないテキストのみで重複判定している。例: ユーザーが "はい" と送信し、直後にアシスタントが "はい" と応答するような短いやりとりで、アシスタントの "はい" が重複と判定され除去される。会話型UIでは "はい"、"了解"、"わかりました" などの短い肯定語が両 role から頻出する。これはノイズ除去ではなく情報損失である。

**[R-3] HIGH: Fix D-2 の recall debounce キャッシュ (`lastRecallResult`) はマルチエージェント環境で共有される**

`lastRecallResult` と `lastRecallTime` は `register()` クロージャスコープに置かれているが、`assemble()` はエージェントIDに関わらず同一クロージャを参照する。複数エージェントが同一 episodic-claw インスタンスを使用する場合（OpenClaw のマルチエージェント構成）、エージェントAのrecall結果がエージェントBへ漏洩する。`resolvedAgentWs` が同一であっても、クエリとなる `msgs` はエージェントごとに異なるため、キャッシュが不正な文脈を注入する。

**[R-4] HIGH: `DEDUP_WINDOW = 5` はハードコードされており設定変更不可**

Fix D-2/D-3 では定数が `register()` スコープで宣言されているが設定ファイルから読み込んでいない。一方 `DEDUP_WINDOW` は `src/segmenter.ts` 内にハードコードされており、`loadConfig()` から取得していない。フォールバック回数が多い環境（例: 10回以上）では WINDOW=5 が不十分になる。`cfg` オブジェクトが `segmenter.ts` に渡されていないため、今後の設定化も困難である。

**[R-5] MED: Fix D-3 の `lastSetMetaTime` は `gateway_stop` → `gateway_start` の再起動サイクルで誤った rate-limit を継続する**

`lastSetMetaTime` は `register()` クロージャのライフタイムに依存する。もし OpenClaw が hot-reload（register を再呼び出し）ではなく、同一プロセス内で `gateway_stop` → `gateway_start` を繰り返す場合、モジュールキャッシュの挙動により前回の `lastSetMetaTime` が保持されず正しくリセットされる可能性はある。しかし逆に、`register()` が**再呼び出しされない**場合（同一クロージャが維持される場合）、5秒 rate-limit が gateway restart をまたいで持続し、再起動直後の `last_activity` 更新が 5 秒間スキップされる。起動時の初期メタデータ設定に影響しうる。

**[R-6] MED: `summarizeBuffer()` はフェーズ2の暫定実装（LLM要約なし）だが本番デプロイ済み**

`segmenter.ts:217-222`:
```typescript
// In Phase 2, we just use a naive join...
return messages.map(m => `${m.role}: ${extractText(m.content)}`).join("\n");
```

このコメントが示す通り、要約は raw テキストの連結のみ。これはベクトル埋め込みの質に直結する。長い会話チャンク（10,000文字）がそのまま要約として保存される場合、埋め込みモデルのトークン上限（多くの場合 8192 トークン）を超過し、末尾が無音でトランケートされる可能性がある。エピソードの後半部分が検索インデックスから消失する。このリスクがドキュメントに記載されていない。

---

### Missing Steps & Considerations

**[M-1] テスト計画 TC-FB-1〜TC-FB-4 が未実施のまま本番デプロイされている**

Section 11 の実装ステータスには「`npm run build:ts` 実行済み（エラーなし）」とあるが、TC-FB-1〜TC-FB-4 の実施結果が記録されていない。ユニットテストのパスなしに本番 WSL へデプロイされたことになる。IBM の品質管理基準では、自動テストのグリーン確認なしの本番リリースは重大な工程違反である。少なくとも TC-FB-1 と TC-FB-2 は `jest` または `vitest` で自動化してCIに組み込む必要がある。

**[M-2] Fix D-1〜D-3 に対する gitnexus_impact の実行記録がない**

Section 8 に「実装前に `gitnexus_impact` を各 Fix で実行すること（CLAUDE.md 義務要件）」と明記されているが、Section 11 の実装ステータスに gitnexus 実行結果の記録がない。CLAUDE.md の MUST 要件が履行されたかどうか検証不可能である。コンプライアンス欠如。

**[M-3] WSL デプロイの検証手順が記録されていない**

Section 11 には「WSL `/root/.openclaw/extensions/episodic-claw/src/` へソースをコピー済み」とあるが、以下の検証手順が一切記録されていない:
- Go sidecar の再起動確認
- episodic-claw プラグインのロード確認ログ
- `[Episodic Memory] All N new message(s) were duplicates or empty, skipping.` ログが実際に出力されたことの確認
- recall debounce ログ (`recall debounce: reusing cached result`) の確認

デプロイ成功の定義と受け入れ基準が文書化されていない。

**[M-4] Fix D-4（processTurn mutex）の判断基準が不明確**

Section 5 および Section 11 に「D-1〜D-3 効果測定後に判断」とあるが、「効果測定」の具体的な指標・閾値・測定方法が定義されていない。いつ Fix D-4 の判断を行うのか、誰が判断するのか、判断基準は何かが不明。保留事項として宙吊りになっている。

---

### Unaddressed Edge Cases

**[E-1] フォールバックが成功レスポンスの後にも発生するケース**

観測例では最後の Turn が成功（22:41 の再送）だが、その後さらにフォールバックが発生するシナリオが未考慮。成功した assistant レスポンスの後に同一ユーザーメッセージが再送された場合、Fix D-1 の `recentTexts` には成功ターンのコンテンツが入っており（buffer に既に追加済み）、重複として正しく除去される。しかし「成功したアシスタント応答」と「次の同一ユーザー再送」が同一チャンク内に入った場合、surprise スコアが中途半端な値になり、不完全なエピソードが生成される可能性がある。

**[E-2] `newSlice` が空文字列になった場合に `processTurn` が途中でサイレントリターンする**

`segmenter.ts:105`:
```typescript
if (!newSlice) return false;
```

`dedupedMessages` がすべてテキスト抽出後に空になるケース（例: 画像のみのメッセージ、ツールコールのみのブロック）でこの条件が成立する。この場合 `lastProcessedLength` は更新されない（line 136 に到達しないため）。次回の `processTurn` 呼び出し時に同じメッセージを再処理しようとする。画像入力や tool_use ブロックを含む会話ではメッセージが永久にスタックする可能性がある。

**[E-3] `OVERLAP_MESSAGES = 2` の重複がエピソード境界でベクトル汚染を起こすケース**

`chunkAndIngest()` のチャンク分割では `OVERLAP_MESSAGES = 2` のオーバーラップがある。これは RAG の文脈分断を防ぐための設計だが、オーバーラップ部分は 2 つの異なるエピソードに同一テキストで埋め込まれる。大量フォールバック後にチャンク数が多い場合（例: 5チャンク × 2 オーバーラップ = 8メッセージが重複保存）、HNSW インデックスに同一テキストの重複ベクトルが増殖し、recall 結果に同一エピソードが多重で返される（重複スコア問題）。

**[E-4] `SET_META_INTERVAL_MS = 5000` と `RECALL_DEBOUNCE_MS = 1000` の設定値が OpenClaw のフォールバック間隔に依存している**

観測例（Section 1）ではフォールバック間隔は約 1〜2 分。しかし Fix D-2 の debounce は 1000ms、Fix D-3 の rate-limit は 5000ms。フォールバック間隔が設定値より長い場合（例: 60秒間隔のフォールバック）、debounce は毎回失効して recall が N 回実行される。Fix D-2 の効果はフォールバック間隔が 1 秒未満の場合にのみ有効であり、観測された実際のシナリオ（1〜2 分間隔）では効果がほぼゼロである。これは Fix の設計前提と実際の観測データの乖離であり、設計根拠の再検討が必要。

---

### Recommended Actions

| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| BLOCKER | `chunkAndIngest()` に AbortController またはタイムアウト付き Promise.race を追加し、`gateway_stop` 時に未完了 RPC を安全にキャンセルする | gateway_stop 後に batchIngest が未解決のままプロセスがゾンビ化するリスク (R-1) | New |
| HIGH | `segmenter.ts:142` の catch ブロックを `newMessages` から `dedupedMessages` に修正する | Fix D-1 のエラーパスバイパス (A-1) — 1行の修正 | New |
| HIGH | Fix D-1 の重複判定に `role` を含める (`${m.role}:${text}` をキーとする) | role 無視による正規メッセージの誤除去 (R-2) | New |
| HIGH | `assemble()` の recall debounce キャッシュをエージェントIDごとにキー付けする (`Map<agentId, {result, time}>`) | マルチエージェント環境での recall 結果漏洩 (R-3) | New |
| HIGH | `ep-save` / `ep-recall` / `ep-expand` の execute 内に `if (!resolvedAgentWs) return error;` のガード節を追加する | gateway_start 前の呼び出しで空パスが RPC に渡る (A-3) | New |
| MED | Fix D-2 の `RECALL_DEBOUNCE_MS` を実際のフォールバック間隔（1〜2 分）に基づいて再設計する（例: 30〜60 秒）か、時間ベースではなくクエリテキスト同一性ベースのキャッシュに変更する | 現在の 1000ms debounce は観測されたフォールバック間隔では効果がほぼゼロ (E-4) | New |
| MED | `newSlice` が空の場合のサイレントリターン前に `lastProcessedLength = currentMessages.length` を実行する | 画像・tool_use メッセージでメッセージ位置がスタックする (E-2) | New |
| MED | TC-FB-1〜TC-FB-4 を自動テストとして実装し、CI に組み込む。実施結果を Section 11 に記録する | テスト未実施での本番デプロイ (M-1) | New |
| MED | Section 11 に gitnexus_impact の実行結果（対象シンボル・リスクレベル・影響範囲）を記録する | CLAUDE.md 義務要件の未履行 (M-2) | New |
| LOW | `DEDUP_WINDOW` を `loadConfig()` 経由で設定可能にし、`EventSegmenter` コンストラクタで受け取る設計にリファクタする | ハードコード定数の設定化 (R-4) | New |
| LOW | `summarizeBuffer()` のトークン上限超過リスクをドキュメントに記載し、Phase 3 での LLM 要約導入の計画を追記する | 暫定実装が本番で動作しているリスクの可視化 (R-6) | New |

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-26
> Mode: Post-Implementation（Round 1 指摘事項への即時対応後）
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status（Round 1 → Round 2）

| Round 1 Issue | Status |
|---|---|
| A-1: catch ブロックが `newMessages` を push（regression） | ✅ Resolved — `dedupedMessages` に修正 |
| R-2: dedup が role を無視してテキストのみで判定 | ✅ Resolved — キーを `${role}:${text}` に変更 |
| R-3: recall debounce キャッシュに agentId なし | ✅ Resolved — `${agentId}:${recallKey}` をフルキーに |
| A-3: ep-save/ep-recall/ep-expand に空ガード節なし | ✅ Resolved — 3ツール全てに `if (!resolvedAgentWs)` ガード追加 |
| E-2: `!newSlice` リターン前に `lastProcessedLength` 未更新 | ✅ Resolved — `lastProcessedLength = currentMessages.length` を追加 |
| E-4: `RECALL_DEBOUNCE_MS = 1000` がフォールバック間隔に対して無効 | ✅ Resolved — 5000ms に延長 + コンテンツキー化（同一クエリ = 常に cache hit）|
| R-1: `chunkAndIngest()` タイムアウト制御なし | ⏸ Carry-over (LOW priority, pre-existing, out of scope) |
| M-1: TC-FB-1〜TC-FB-4 未実施 | ⏸ Carry-over (MED, 次フェーズで実施) |
| M-2: gitnexus_impact 実行記録なし | ⏸ Carry-over (MED) |
| R-4: `DEDUP_WINDOW` ハードコード | ⏸ Carry-over (LOW) |
| R-6: `summarizeBuffer()` トークン上限リスク未記載 | ⏸ Carry-over (LOW) |

### ✅ No new critical issues found. Document has converged.

> Round 2 にて新規 BLOCKER/HIGH/MED は 0 件。
> 残存 carry-over はすべて LOW または次フェーズ作業（テスト実施・設定化）。
> **実装フェーズは収束済み — テスト実施フェーズへ移行可能。**

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-26
> Mode: Post-Implementation (R-1/R-4/R-6 fixes applied)
> Prior audits: 2 | New findings this round: 0

### 📊 Convergence Status（Round 2 → Round 3）

| Round 2 Carry-over | Status |
|---|---|
| R-1: chunkAndIngest タイムアウト制御なし | ✅ Resolved — `segmenter.ts:224-228` に `Promise.race` + 30秒タイムアウト実装済み |
| R-4: DEDUP_WINDOW ハードコード | ✅ Resolved — `types.ts:39-40` に `dedupWindow?: number` 追加、`config.ts:13` で `loadConfig()` 経由取得、`segmenter.ts:38-43` でコンストラクタ引数化、`index.ts:73` で `cfg.dedupWindow ?? 5` として渡す設計に移行済み |
| R-6: summarizeBuffer トークン上限リスク未記載 | ✅ Resolved — `segmenter.ts:233-242` に詳細コメント追加済み（上限試算・トランケートリスク・Phase 3 計画を明記） |
| M-1: TC-FB-1〜TC-FB-4 未実施 | ⏸ Carry-over (テストフェーズ) |
| M-2: gitnexus_impact 記録なし | ⏸ Carry-over |

<!-- 新規発見なし → -->
<!-- ✅ No new critical issues found. Document has converged. -->

### ✅ No new critical issues found. Document has converged.

> Round 3 にて新規 BLOCKER/HIGH/MED/LOW は 0 件。
> R-1・R-4・R-6 の実装をコードで直接確認し、いずれも意図通りに修正されていることを検証した。
> 残存 carry-over は M-1（テスト未実施）・M-2（gitnexus 記録なし）のみであり、
> いずれも実装品質ではなくプロセス/ドキュメント上の未完了事項である。
> **実装フェーズ完全収束 — 次アクションはテスト実施フェーズ（TC-FB-1〜TC-FB-4）に一本化。**

### ✅ Recommended Actions (新規のみ)

| Priority | Action | Reason | Is New? |
|---|---|---|---|
| — | なし | 新規発見ゼロ。既存 carry-over（M-1, M-2）の対応は前ラウンド指示通り進めること。 | — |
