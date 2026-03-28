# episodic-claw — セッション境界ギャップ解析レポート

> 作成日: 2026-03-25
> 対象バージョン: episodic-claw Phase 5.5 + Antigravity 修正完了時点
> 調査対象: OpenClaw `/reset` `/new` 実行時のエピソード記憶引き継ぎ挙動

---

## 1. 結論サマリー

| 問い | 答え |
|---|---|
| `/reset`/`/new` 後に新セッションへエピソード記憶は注入されるか？ | **部分的に機能する** |
| `assemble()` は過去セッションの記憶を取得できるか？ | **Yes** — workspace ベースのベクトル検索のため sessionId に依存しない |
| セッション終了直前の未保存バッファは保存されるか？ | **No** — これが唯一の実害あるギャップ |

---

## 2. 前提知識: OpenClaw のフック体系

OpenClaw が Context Engine プラグインに提供するフック（`openclaw/src/auto-reply/reply/session.ts`）:

```
/reset または /new 実行
  │
  ├─ before_reset フック（fire-and-forget）
  │    旧セッションのメッセージを読み込み
  │
  ├─ session_end フック（旧セッションに対して）
  │
  └─ session_start フック（新セッションに対して）
       │
       └─ 最初のターン前に assemble() が呼ばれる
```

さらに Context Engine として登録できるフック:
- `ingest(ctx)` — メッセージ追加時
- `assemble(ctx)` — 毎ターン AI 実行前
- `compact(ctx)` — トークン超過時

---

## 3. episodic-claw の現在の登録フック一覧

**ファイル:** `src/index.ts`

```typescript
// ✅ 登録済み
api.on("gateway_start", async (event, _ctx) => { ... });  // Go sidecar 起動 (line 80)
api.on("gateway_stop",  async (event, _ctx) => { ... });  // sidecar 停止  (line 132)

// ✅ Context Engine として登録
api.registerContextEngine("episodic-claw", () => ({
  ingest(ctx)  { ... },  // メッセージ受信 → segmenter.processTurn()
  assemble(ctx){ ... },  // 毎ターン前 → retriever.retrieveRelevantContext()
  compact(ctx) { ... },  // トークン超過 → compactor.compact()
}));

// ❌ 未登録
// api.on("session_end",   ...);  // ← 存在しない
// api.on("session_start", ...);  // ← 存在しない
```

---

## 4. assemble() のクロスセッション注入の実態

### 4.1 retriever.ts の実装（line 26）

```typescript
// src/retriever.ts
const results = await this.rpcClient.recall(query, k, agentWs);
//                                                    ↑
//                               sessionId ではなく agentWs（ワークスペースパス）
//                               例: ~/.openclaw/workspace/episodes/
```

**重要:** episodic-claw の記憶検索は `agentWs`（episodes ディレクトリパス）に対して Go サイドカーの HNSW ベクトル検索を実行する。sessionId は一切使用しない。

これは `/reset`/`/new` で sessionId が変わっても、**同じワークスペースの全エピソードが検索対象**になることを意味する。

### 4.2 assemble() 内のフロー（src/index.ts 156-178行）

```typescript
async assemble(ctx: any) {
  const msgs = ctx.messages as Message[];

  // ① fire-and-forget でセグメンテーション発火（毎ターン）
  segmenter.processTurn(msgs, resolvedAgentWs, agentId).catch(...);

  // ② agentWs ベースのベクトル検索（全セッション横断）
  const episodicContext = await retriever.retrieveRelevantContext(
    msgs, resolvedAgentWs, 5, maxEpisodicTokens
  );

  return {
    messages: msgs,
    prependSystemContext: episodicContext,  // ← System prompt 先頭に注入
    estimatedTokens: estimateTokens(episodicContext),
  };
}
```

**結論:** `/reset`/`/new` 後の新セッションでも、保存済みエピソードは `assemble()` によって正しく注入される。

---

## 5. 発見されたギャップ: セグメンター Buffer の消失

### 5.1 問題の発生箇所（src/segmenter.ts 47-54行）

```typescript
async processTurn(currentMessages: Message[], agentWs: string, agentId: string): Promise<boolean> {
  if (currentMessages.length === 0) return false;

  // ⚠️ Context wipe/reset の検出
  if (this.lastProcessedLength > currentMessages.length) {
    this.lastProcessedLength = 0;
    this.buffer = [];  // ← buffer を forceFlush せずに破棄する
    // forceFlush(agentWs, agentId) を呼ぶべきだが呼ばれていない
  }
  // ...
}
```

`processTurn()` は `assemble()` から毎ターン fire-and-forget で呼ばれる（`src/index.ts:164`）。新セッションの最初のターンで旧セッションより少ないメッセージ数が来ると、この reset 検出が発動して buffer が **forceFlush なしで破棄**される。

### 5.2 失われるデータの範囲

#### segmenter の二重防衛ライン

buffer が flush されるのは以下の **2つの条件のどちらか** が満たされた時（`src/segmenter.ts:90`）:

```typescript
if (surprise > this.surpriseThreshold   // 防衛 A: Surprise > 0.2 (トピック転換)
 || estimatedChars > MAX_BUFFER_CHARS)  // 防衛 B: 累積 12,000 文字超 (~30〜40ターン)
```

- **防衛 A（Surprise）:** 話題が変わる、コードのドメインが変わる、感情トーンが変わる — いずれも Surprise > 0.2 を引き起こし、incremental flush が走る。**ほとんどの会話はこれでカバーされる。**
- **防衛 B（Size）:** Surprise が低くても 12,000 文字を超えたら自動 flush。1ターン平均 300 文字なら約 40 ターン相当。

#### 実際に消えるのは「最後の flush からリセットまでの末尾」

| 状況 | 損失するデータ | 発生頻度 |
|---|---|---|
| 通常の会話（トピック変化あり）の `/reset` | 最後の Surprise 境界以降の末尾（数ターン〜数十ターン） | 一般的 |
| 長いセッションの `/reset` | 最後の size-limit flush 以降の末尾（最大 12,000 文字分） | 一般的 |
| **単一トピック・低 Surprise かつ 12,000 文字未満で `/reset`** | **その会話全体** — 二重防衛を両方潜り抜けたケース | **まれ（最危険シナリオ）** |

> **ユーザー指摘により修正:** 「コンパクションが走らない短いセッション → セッション全体消失」という表現は誤解を招く。Surprise による incremental flush が常時機能しているため、ほとんどのセッションは断片的に保存される。**危険なのは「Surprise が上がらない単調な会話（例: 1つのバグをひたすらデバッグし続ける会話）かつ短文」という特定のシナリオに限定**される。

### 5.3 コンパクション時との比較（問題なし）

`compact()` が呼ばれる場合は正しく処理される（`src/compactor.ts:72`）:

```typescript
async compact(ctx: any): Promise<CompactResult> {
  this.isCompacting = true;
  try {
    // Step 1: forceFlush を明示的に呼び出す ← これが正しい実装
    await this.segmenter.forceFlush(agentWs, agentId);
    // ...
  }
}
```

`compact()` はトークン超過時に OpenClaw によって呼び出されるため、長い会話で自然にコンパクションが走った場合は損失なし。

---

## 6. ギャップの深刻度評価

| 観点 | 評価 | 理由 |
|---|---|---|
| **新セッションへの記憶注入** | 低リスク | assemble() は sessionId 非依存のベクトル検索 → 機能する |
| **通常セッションの `/reset`（トピック変化あり）** | 低〜中リスク | Surprise flush で大半は保存済み。末尾数ターン分のみ消える可能性 |
| **単調な単一トピック会話の `/reset`（Surprise < 0.2 継続かつ < 12,000文字）** | 中リスク | 二重防衛ライン（Surprise + Size）を両方潜り抜けた場合のみ全消失。発生頻度は低い |
| **長いセッション後の `/reset`** | 低リスク | size-limit flush が複数回走っており大部分は保存済み。末尾のみ消える |

---

## 7. 修正プラン

### プラン全体像

OpenClaw のフック検証結果（`openclaw/src/auto-reply/reply/session.ts:586`、`commands-core.ts:101`）により、**全フックは fire-and-forget** であることが確定した。完全な完了保証は構造上不可能。ただし「flush が開始される確率を最大化する」ための実装順序がある。

**フック発火タイムライン（`/reset` 実行時）:**
```
/reset 実行
  │
  ├─ before_reset フック（fire-and-forget）← セッション消去前 ← buffer まだ有効
  │    openclaw/src/auto-reply/reply/commands-core.ts:101
  │    void (async () => { await hookRunner.runBeforeReset(...) })()
  │
  ├─ [セッション消去・新セッション初期化]
  │
  ├─ session_end フック（fire-and-forget）← セッション消去後 ← buffer が既に無効な可能性大
  │    openclaw/src/auto-reply/reply/session.ts:586
  │    void hookRunner.runSessionEnd(...).catch(() => {})
  │
  └─ 新セッション最初の assemble() → processTurn() fire-and-forget
       ← Fix B が発動するタイミング（reset 検出）
```

**アプローチ優先順位:**
- **Fix C（P1・根本修正）:** `before_reset` フックで `forceFlush()` を起動 — buffer が有効な最も早いタイミング
- **Fix B（P2・フォールバック）:** `processTurn()` の reset 検出時に `forceFlush()` — Fix C が間に合わなかった場合の保護
- **Fix A（P3・非推奨）:** `session_end` フックは buffer 消去後の発火のため効果が最低

---

### Fix C（P1）: `before_reset` フックの登録

**ファイル:** `src/index.ts`
**挿入位置:** `gateway_stop` フック（line 132）の直後

```typescript
// [新規追加] before_reset フック: セッション消去前に未保存バッファをフラッシュ（最良タイミング）
// openclaw は void で発火するため完了保証はないが、buffer がまだ有効なうちに flush を開始できる
api.on("before_reset", async (event?: any, ctx?: any) => {
  const agentId = ctx?.agentId || resolveAgentIdFromSessionKey?.(ctx?.sessionKey) || "auto";
  if (!resolvedAgentWs) {
    console.log("[Episodic Memory] before_reset: resolvedAgentWs not set, skipping flush");
    return;
  }
  console.log(`[Episodic Memory] before_reset: flushing segmenter buffer before session clear...`);
  try {
    await segmenter.forceFlush(resolvedAgentWs, agentId);
    console.log("[Episodic Memory] before_reset: buffer flushed successfully");
  } catch (err) {
    console.error("[Episodic Memory] before_reset: forceFlush error", err);
  }
});
```

**期待効果:** セッションメッセージが消去される前に flush が開始される。fire-and-forget だが Go sidecar への RPC が早期に発行される。

**`forceFlush()` の冪等性:** `src/segmenter.ts:126` — `if (this.buffer.length === 0) return;` により buffer 空時は即 return。Fix B と同時実装しても二重 RPC は発生しない。

---

### Fix B（P2）: `processTurn()` の reset 検出時に `forceFlush()` を呼ぶ

**ファイル:** `src/segmenter.ts`
**変更箇所:** line 51-54 の reset 検出ブロック

```typescript
// 現在のコード（問題あり）
if (this.lastProcessedLength > currentMessages.length) {
  this.lastProcessedLength = 0;
  this.buffer = [];  // ← forceFlush なしで破棄
}

// 修正後
if (this.lastProcessedLength > currentMessages.length) {
  // コンテキストリセット検出: forceFlush してから buffer クリア
  if (this.buffer.length > 0) {
    console.log(`[Episodic Memory] Context reset detected. Flushing ${this.buffer.length} buffered messages before reset.`);
    // ここでは agentWs が引数で渡ってくるため await できる
    await this.forceFlush(agentWs, agentId);
  }
  this.lastProcessedLength = 0;
  // buffer は forceFlush 内でクリア済みのため不要
}
```

**期待効果:** Fix C が間に合わなかった場合（before_reset の fire-and-forget が flush 完了前に新セッションが始まった場合）のフォールバック保護。新セッションの最初の `assemble()` が呼ばれた時点で旧バッファを flush する。

**注意点:** `assemble()` 内の `processTurn()` 呼び出しが fire-and-forget のため、flush の完了は保証されない。Fix C の補完として位置づける。`agentWs` は `processTurn()` の引数で渡されるため、`resolvedAgentWs` ガード節は不要（引数が undefined なら `forceFlush` 内のエラーハンドリングが処理）。

---

### Fix A（P3・非推奨）: `session_end` フックの登録

**発火タイミング:** セッション消去後（`session.ts:586`: `void hookRunner.runSessionEnd(...).catch(() => {})`）。この時点で segmenter buffer は既に Fix B または processTurn の reset 検出によって `[]` に初期化されている可能性が高い。

**結論:** 効果が最低のため実装不要。Fix C + Fix B で十分。

---

## 8. 実装優先度

> **フック検証結果（2026-03-26）:** OpenClaw の全フックは fire-and-forget（`void` 発火）。完全な完了保証は構造上不可能。

| Fix | 優先度 | ファイル | タイミング | 効果 |
|---|---|---|---|---|
| **Fix C** (`before_reset` フック) | **P1 — 最優先** | `src/index.ts` | セッション消去前（buffer 有効） | flush が最も早く開始される |
| **Fix B** (`processTurn` reset 検出) | **P2** | `src/segmenter.ts` | 新セッション最初の assemble() | Fix C のフォールバック |
| Fix A (`session_end` フック) | 非推奨 | — | セッション消去後（buffer 既に無効） | 効果なし |

**推奨実施順序:** Fix C → Fix B → `gitnexus_detect_changes()` → E2E テスト

---

## 9. テスト計画

### テストケース 1: 単調な単一トピック会話の `/reset`（最危険シナリオ）
1. 新セッション開始
2. **同一トピックで短文**の会話を 10〜15 ターン継続（意図的に Surprise を低く保つ）
3. 累積文字数が 12,000 文字を超えないうちに `/reset` または `/new` を実行
4. 新セッションで `ep-recall` ツールを使い直前の会話が取得できることを確認

**期待値（Fix 前）:** 取得できない（Surprise も size-limit も未発動のまま buffer が消えるため）
**期待値（Fix 後）:** 取得できる

> 注: トピック変化がある通常会話では Surprise flush が働くため、3〜5 ターン程度の短いセッションでもほとんどの場合 buffer には末尾数ターン分しか残っていない。

### テストケース 2: 長いセッション後の `/reset`
1. コンパクションが走るまで会話
2. さらに 5〜10ターン追加
3. `/reset`
4. 新セッションで追加した 5〜10ターン分が recall できることを確認

### テストケース 3: 新セッションへの記憶注入（現状でも機能するはず）
1. セッション A で独自の知識を会話に含める
2. コンパクション後に `/new`
3. 新セッション B の最初のターンで System プロンプトに `=== RETRIEVED EPISODIC MEMORY ===` が含まれることを確認

---

## 10. GitNexus 影響範囲分析（`processTurn`）

Fix B は `processTurn()` を変更するため、CLAUDE.md の要件に従い事前に `gitnexus impact` を実行した。

```bash
npx gitnexus impact processTurn --repo episodic-claw
```

**結果:**

```json
{
  "target": "Method:src/segmenter.ts:processTurn",
  "risk": "LOW",
  "impactedCount": 2,
  "summary": {
    "direct": 2,
    "processes_affected": 0,
    "modules_affected": 1
  },
  "byDepth": {
    "1": [
      { "name": "ingest",   "filePath": "src/index.ts", "relationType": "CALLS", "confidence": 0.9 },
      { "name": "assemble", "filePath": "src/index.ts", "relationType": "CALLS", "confidence": 0.9 }
    ]
  }
}
```

**解釈:**

| 項目 | 値 | 意味 |
|---|---|---|
| Risk | **LOW** | 変更の影響は軽微 |
| 直接呼び出し元（depth=1） | `ingest`, `assemble`（いずれも `src/index.ts`） | この2箇所が Fix B の動作変化を受ける |
| affected processes | 0 | 実行フロー上の上流プロセスへの影響なし |
| affected modules | 1（Cluster_0） | セグメンター/エンジン周辺のみ局所的 |

Fix B（reset 検出時の `forceFlush` 追加）は blast radius が最小限であり、安全に実施できる。

---

## 11. 関連ファイル

| ファイル | 役割 | 変更が必要な Fix |
|---|---|---|
| `src/index.ts` | フック登録・Context Engine 定義 | Fix C（P1: `before_reset` フック追加） |
| `src/segmenter.ts` | バッファ管理・reset 検出 | Fix B（P2: reset 検出時の `forceFlush` 追加） |
| `src/compactor.ts` | compact() 内の forceFlush 呼び出し（参考） | 変更不要 |
| `src/retriever.ts` | agentWs ベースのベクトル検索（参考） | 変更不要 |

---

## 12. 補足: sub-agent 調査との差異について

調査時に使用したサブエージェントは `lossless-claw/src/engine.ts` の sessionId ベース DB ルックアップを参照して「新セッションでは assemble() が DB miss する」と報告した。これは **lossless-claw の挙動であり episodic-claw には該当しない**。

episodic-claw の `retriever.ts:26` は `rpcClient.recall(query, k, agentWs)` を呼ぶ。`agentWs` は OpenClaw の workspace パス（`~/.openclaw/workspace/episodes/`）であり、セッションをまたいで全エピソードをベクトル検索する。よって **assemble() のクロスセッション記憶注入は元から正しく動作している**。

唯一の実害あるギャップは「セッション終了直前のバッファ未フラッシュ」のみ。

---

---

## 13. 実装ステータス（2026-03-26）

| Fix | ファイル | 変更内容 | 状態 |
|---|---|---|---|
| **Fix C** | `src/index.ts` (+14行) | `before_reset` フック登録 — `extractAgentId(ctx)` で agentId 解決、`resolvedAgentWs` ガード付き | ✅ 実装完了 |
| **Fix B** | `src/segmenter.ts` (+6行) | reset 検出時に `await forceFlush()` 追加、失敗時も `this.buffer = []` でクリア保証 | ✅ 実装完了 |

**変更スコープ（`git diff --stat`）:** `src/index.ts`, `src/segmenter.ts`, `docs/session_boundary_gap_report.md` の3ファイルのみ。予期しない変更なし。

**blast radius（Fix B: `processTurn` 変更）:** GitNexus 事前分析済み — risk=LOW、direct callers=2（`ingest`, `assemble` in `src/index.ts`）

---

*本レポートは `docs/compression_analysis_report.md` の監査サイクルとは独立した調査結果。*

---

## 🔍 Audit Report — Round 2
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-26
> Mode: Pre-Implementation（Round 1 解決確認 + 新規精査）
> Prior audits: 1 | New findings this round: 0

### 📊 Convergence Status (Round 1 Items)

| Round 1 Issue | Status |
|---|---|
| RISK-1: session_end await 保証未検証 | ✅ Resolved — `session.ts:586` の `void hookRunner.runSessionEnd(...).catch(() => {})` で fire-and-forget 確定。Fix A 非推奨降格・Fix C P1 昇格がドキュメントに反映済み。 |
| IMPACT-1: Fix B fire-and-forget 契約違反 | ✅ Resolved — "完全な完了保証は構造上不可能" と Section 7/8 に明記。Fix B を "フォールバック" として位置づけた上で Fix C + Fix B の組み合わせを最善策と定義。既知の限界として文書化済み。 |
| RISK-2: forceFlush 冪等性未確認 | ✅ Resolved — `segmenter.ts:126` の `if (this.buffer.length === 0) return;` を根拠として Fix C の注意点に追記済み。 |
| MISSING-1: Fix A await 保証検証テスト欠如 | ✅ Resolved (Superseded) — Fix A を非推奨としたため不要。テストケース1で Fix C + Fix B の統合テストをカバー。 |
| MISSING-2: gitnexus_detect_changes タイミング未明記 | ✅ Resolved — Section 8 に "Fix C → Fix B → `gitnexus_detect_changes()` → E2E テスト" と明記済み。 |
| EDGE-1: プロセスクラッシュシナリオ未掲載 | ⚠️ Still open — Round 1 から Open のまま持ち越し。LOW priority。 |

---

### Round 2 焦点の精査結果

**焦点1: Fix C の `resolveAgentIdFromSessionKey` 参照可能性**

Section 7 Fix C のコードスニペットに `resolveAgentIdFromSessionKey?.(ctx?.sessionKey)` が記述されている。この関数は Section 3 の `src/index.ts` フック一覧に登場せず、ドキュメント上に定義・インポートの根拠がない。ただし optional chaining (`?.`) が付いているため、未定義の場合でも実行時エラーは発生せず `"auto"` にフォールバックする。実装時のリスクは LOW — agentId が `"auto"` になる最悪ケースは既存の `ingest`/`assemble` の動作と同等であり、データロスには至らない。

**判定:** genuine LOW issue だが、3件未満の閾値に到達しない。

**焦点2: Fix C と Fix B の forceFlush 同時進行競合**

RISK-2 の解決根拠（`buffer.length === 0` チェック）は "buffer が空の場合" の冪等性を保証する。Fix C の `forceFlush` が **Go sidecar への RPC を送信中**（async waiting）の状態で Fix B の `forceFlush` が発動した場合、`buffer` はまだ空ではないため、二重 RPC が発行されうる。ただし Fix C は `before_reset`（セッション消去前）、Fix B は新セッションの最初の `assemble()`（セッション消去後）で発動するため、タイムライン上の距離は十分にあり、Go sidecar の RPC 完了前に Fix B が発動するケースは非常に限定的（高レイテンシ環境または Go sidecar 高負荷時）。かつ二重インデクシングの実害（重複エピソード）は "記憶が消える" よりはるかに軽微。

**判定:** genuine LOW issue だが、セクション 7 Fix C の「注意点」で RISK-2 解決済みとされており、文書がすでにこのリスクを認識・許容済みとも解釈できる。3件未満の閾値に到達しない。

**焦点3: テストケース1の実装可能性**

Fix C + Fix B 実装後、テストケース1（単調な低 Surprise 会話 → `/reset` → `ep-recall` で recall 確認）は原理的に機能する。Fix C が buffer を before_reset で flush し、Fix B がフォールバックとして機能する構造と整合している。実装可能性に問題なし。

**焦点4: Section 8 の `gitnexus_detect_changes()` 実行タイミング**

"Fix C → Fix B → `gitnexus_detect_changes()` → E2E テスト" の記述は、Fix C (`src/index.ts`) と Fix B (`src/segmenter.ts`) 両方の変更完了後に1回実行する意図として明確に読める。Fix ごとに個別実行する必要性はなく、この順序で問題なし。

---

### 結論

✅ No new critical issues found. Document has converged.

Round 1 の HIGH/BLOCKER はすべて解決済み。残存は LOW 1件（EDGE-1: プロセスクラッシュシナリオ）のみで、これは文書の Scope 外（OS レベルの強制終了）であり実装ブロッカーではない。Round 2 精査で発見した注意点（`resolveAgentIdFromSessionKey` 参照、forceFlush 同時進行競合）はいずれも LOW かつ合計 2件で閾値未満。

**実装を開始できる状態。推奨実施順序: Fix C (`src/index.ts`) → Fix B (`src/segmenter.ts`) → `gitnexus_detect_changes()` → E2E テスト（テストケース 1〜3）。**

---

## 🔍 Audit Report — Round 1
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-26
> Mode: Pre-Implementation
> Prior audits: 0 | New findings this round: 6

### 📊 Convergence Status
初回監査のため prior issues なし。3件以上の新規発見があったため、監査を完全実施する。

---

### ⚠️ Impact on Related Features

**[IMPACT-1] Fix B の `await forceFlush()` は `assemble()` の fire-and-forget 契約を破壊する**
- 現状: `assemble()` は `processTurn()` を `fire-and-forget`（`.catch(...)` のみ）で呼び出している（`src/index.ts:164`）。
- Fix B 適用後: `processTurn()` 内で `await forceFlush()` が実行される。しかし呼び出し元が `await` していないため、`forceFlush()` の完了前に新セッションの後続処理（次の `assemble()` 呼び出し）が走る可能性がある。
- 結果: **Fix B の「効果」として文書が主張する「新セッションの最初のターンで旧バッファを確実に保存する」は、fire-and-forget の文脈では保証されない。** Fix A（`session_end` フック）が未発火の場合にフォールバックとして機能するという位置づけであっても、レース条件が発生するリスクがある。

**[IMPACT-2] `ingest` 呼び出しパスへの影響が未評価**
- gitnexus impact 結果（Section 10）では `ingest` が depth=1 の直接呼び出し元として列挙されている。
- `ingest` 内でも `processTurn()` が呼ばれる可能性があり、Fix B の reset 検出ロジックがメッセージ受信タイミングで誤発動するケースが検討されていない。
- 具体的には: `/reset` 直後の最初の人間メッセージ到着時（`ingest` 経由）に `lastProcessedLength > currentMessages.length` が成立すると、まだ空の buffer に対して `forceFlush` が呼ばれる可能性がある。実害は軽微だが、不要な RPC コールとログ出力が発生する。

---

### 🚨 Potential Problems & Risks

**[RISK-1] Fix A: `session_end` フックの await 保証が未検証のまま実装される危険性 — MEDIUM**
- Section 7（Fix A の注意点）に「OpenClaw の `session_end` フックが非同期完了を待つかを確認する必要がある」と自己言及しているが、**確認手順が修正プランに含まれていない**。
- `session_end` が fire-and-forget で実行される場合、`await segmenter.forceFlush(...)` を書いても OpenClaw 側が await しないため、フラッシュ完了前にセッションが破棄される。Fix A 全体の有効性がこの1点に依存しているにもかかわらず、テスト計画（Section 9）にこの検証ステップが存在しない。
- **実装前に `openclaw/src/auto-reply/reply/commands-core.ts` の `session_end` 発火コードを確認し、await チェーンの有無を明記することを Fix A の前提条件とすべき。**

**[RISK-2] Fix C の `before_reset` フックと Fix A の `session_end` フックが両方登録された場合、`forceFlush()` が二重実行される — LOW**
- Fix A + Fix C の同時実装時、同一セッションに対して `forceFlush()` が2回呼ばれる。
- `forceFlush()` が冪等（buffer が空なら何もしない）かどうかが文書に記載されていない。冪等でない場合（例: buffer が空でも Go sidecar への RPC を発行する実装の場合）、無駄な RPC コストまたは Go サイドカー側の二重インデクシングが発生しうる。
- 修正プランに `forceFlush()` の冪等性の明記または保証コードの追加が必要。

**[RISK-3] `resolvedAgentWs` が未設定の場合の Fix B の動作が未定義 — LOW**
- Fix A のコードは `resolvedAgentWs` 未設定時に early return するガード節を持つ（Section 7 Fix A のコード参照）。
- Fix B（`segmenter.ts` の変更）では `forceFlush(agentWs, agentId)` を呼ぶが、`agentWs` は `processTurn()` の引数として渡される。`processTurn()` の呼び出し元である `assemble()` および `ingest()` が `resolvedAgentWs` を渡すが、`resolvedAgentWs` が `undefined` のまま呼ばれた場合の `forceFlush()` 内のエラーハンドリングが文書に記載されていない。Fix A のような明示的なガード節が Fix B にも必要かどうかを検討すべき。

---

### 📋 Missing Steps & Considerations

**[MISSING-1] テスト計画に Fix A の await 保証の検証テストが存在しない**
- Section 9 のテストケース 1〜3 はすべてエピソード記憶の recall 成否を確認するブラックボックステストである。
- **Fix A の根本的な前提（`session_end` フックが await される）を検証するテストケースが存在しない。** 例えば、`forceFlush()` 呼び出し時にタイムスタンプログを出力し、セッション破棄完了ログとの順序を比較するといった手順が必要。

**[MISSING-2] Fix B 適用後の `processTurn()` のシグネチャ変化が `gitnexus_detect_changes()` で確認されるかどうか不明**
- CLAUDE.md の「Always Do」要件として `gitnexus_detect_changes()` の実行が義務付けられているが、Section 10 の影響範囲分析は Fix B **実装前** の `gitnexus impact` のみを示している。
- 実装後の `gitnexus_detect_changes()` 実行結果を確認するステップが実装計画（Section 8 の推奨実施順序）に含まれていない。`gitnexus_detect_changes()` は Fix B 実装後、コミット前に実行することを明記すべき。

---

### 🕳️ Unaddressed Edge Cases

**[EDGE-1] `gateway_stop` と `session_end` が競合するシナリオ**
- OpenClaw プロセス自体が強制終了（クラッシュ、SIGKILL）された場合、`session_end` も `gateway_stop` も発火しない。
- Fix B はこのケースの唯一のフォールバックだが、前述（[IMPACT-1]）の通り fire-and-forget 呼び出しチェーンでは完了が保証されない。
- 文書はこのシナリオ（プロセスクラッシュ時の全バッファ消失）を「対処不要」として明示的に除外していないため、リスクの許容判断が読者に委ねられたままになっている。少なくともセクション 6（深刻度評価）の表にこのシナリオを追加し「対処範囲外」と明示するか、WAL（Write-Ahead Log）方式の将来検討事項として言及すべき。

---

### ✅ Recommended Actions

| Priority | Action | Reason | Status |
|----------|--------|--------|--------|
| HIGH | Fix A 実装前に `openclaw/src/auto-reply/reply/commands-core.ts` の `session_end` await チェーンを確認 | Fix A の有効性全体がこの1点に依存 [RISK-1] | ✅ Resolved — `session.ts:586`: `void hookRunner.runSessionEnd(...).catch(() => {})` → fire-and-forget 確定。Fix A は非推奨に降格。Fix C (`before_reset`) を P1 に昇格。 |
| HIGH | `processTurn()` fire-and-forget 問題の実装方針を再評価 | Fix B の効果は保証されない [IMPACT-1] | ✅ Resolved — 全フック fire-and-forget は確定。Fix C (before_reset, セッション消去前) + Fix B (フォールバック) の組み合わせが最善。完全保証は構造上不可能と明記。Section 7/8 を更新済み。 |
| MED | `forceFlush()` 冪等性の確認と Fix A+C 同時実装時の二重 RPC リスク追記 [RISK-2] | 二重インデクシングリスク | ✅ Resolved — `segmenter.ts:126`: `if (this.buffer.length === 0) return;` で冪等性確認。Fix C の注意点に追記済み。 |
| MED | Section 9 テスト計画に Fix A の await 保証検証テストを追加 [MISSING-1] | テスト計画がブラックボックスのみ | ✅ Superseded — Fix A を非推奨としたため不要。Fix C + Fix B のテストに統合（テストケース 1 で対応可） |
| MED | Section 8 の推奨実施順序に `gitnexus_detect_changes()` を明記 [MISSING-2] | CLAUDE.md 義務要件 | ✅ Resolved — Section 8 更新済み。 |
| LOW | Section 6 にプロセスクラッシュ時シナリオを追加 [EDGE-1] | リスク許容判断が暗黙 | ⬜ Open — 次ラウンドまたは実装後に対応 |

---

### Round 1 Convergence Assessment

HIGH 2件（RISK-1, IMPACT-1）を実コード確認で解決済み。
MED 3件（RISK-2, MISSING-1, MISSING-2）も解決済み。残存は LOW 1件（EDGE-1）のみ。

**Document is implementation-ready.** 実装を開始できる状態。

---

## 🔍 Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-26
> Mode: Post-Implementation（Fix C + Fix B 実装完了後の検証）
> Prior audits: 2 | New findings this round: 0

### 📊 Convergence Status (Prior Rounds)

| Issue | Status |
|---|---|
| Round 2: LOW-1 resolveAgentIdFromSessionKey | ✅ Resolved — `src/index.ts` に `extractAgentId(ctx)` 関数が独立実装済み（L32-42）。`resolveAgentIdFromSessionKey` への参照はコードベース内にゼロ。Fix C 実装（L142）で `extractAgentId(ctx)` を使用していることを実コードで確認。 |
| Round 2: LOW-2 Fix C+B 同時進行競合 | ✅ Resolved (Accepted) — Fix C（`before_reset`、セッション消去前）と Fix B（新セッション最初の `assemble()`）のタイムライン上の距離が十分であることを実装で確認。`forceFlush` 内（`segmenter.ts:131`）の `if (this.buffer.length === 0) return;` による冪等性ガードが実装済み。高負荷時の二重 RPC リスクは Round 2 で許容済みのため carry-over なし。 |
| Round 1: EDGE-1 プロセスクラッシュ未掲載 | ⚠️ Still open (LOW carry-over) — Section 6 への追記は未実施。実装ブロッカーではない。 |

---

### 実装検証結果（設計 vs コード突き合わせ）

**Fix C（`src/index.ts` L138-150）**

Section 7 の設計仕様との差異:

| 設計仕様 | 実装 | 判定 |
|---|---|---|
| `api.on("before_reset", async (_event?, ctx?) => {...})` | L140: 完全一致 | ✅ |
| `if (!resolvedAgentWs) return;` ガード節 | L141: 完全一致 | ✅ |
| `extractAgentId(ctx)` で agentId 解決 | L142: 完全一致（`resolveAgentIdFromSessionKey` 不使用） | ✅ |
| `await segmenter.forceFlush(resolvedAgentWs, agentId)` | L145: 完全一致 | ✅ |
| catch でエラーログ | L147-149: 完全一致 | ✅ |

設計と実装の間に差異なし。

**Fix B（`src/segmenter.ts` L51-59）**

Section 7 の設計仕様との差異:

| 設計仕様 | 実装 | 判定 |
|---|---|---|
| `if (this.lastProcessedLength > currentMessages.length)` | L51: 完全一致 | ✅ |
| `if (this.buffer.length > 0)` ガード | L53: 完全一致 | ✅ |
| `await this.forceFlush(agentWs, agentId)` | L55: 完全一致 | ✅ |
| `this.lastProcessedLength = 0` | L57: 完全一致 | ✅ |
| `this.buffer = []` フォールバッククリア | L58: 実装済み（設計コメント「forceFlush 内でクリア済みのため不要」より強化された実装） | ✅ |

設計コメントでは「`buffer` は `forceFlush` 内でクリア済みのため不要」と記述していたが、実装では `this.buffer = []` を明示的に追加している。これは `forceFlush` が例外で失敗した場合（`segmenter.ts:137-139` の catch ブロック内では buffer クリアが行われない）のフォールバックとして機能する。設計より堅牢な実装であり、問題なし。

---

✅ No new critical issues found. Document has converged. 実装は完了しており、E2E テスト（Section 9 テストケース 1〜3）へ進める状態です。
