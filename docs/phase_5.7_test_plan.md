# Phase 5.7 Sleep Consolidation テストプラン

> 作成日: 2026-03-27
> 前提: Phase 5.5 / 5.6 / 5.9 E2E 全テスト PASS 済み
> 実行環境: WSL (archlinux) + OpenClaw Gateway + Node.js RPC スクリプト
> ボット: `@keruvim_bot` (Telegram Web)

---

## 概要

Phase 5.7 は「Sleep Consolidation」機能の E2E 検証。エージェントが一定時間非活動状態になると自動的に D0 エピソードを D1 セマンティックサマリーに昇格させる機能を確認する。

### 検証対象コンポーネント

| コンポーネント | ファイル | 役割 |
|---|---|---|
| Sleep Timer | `go/watcher/watcher.go` | `last_activity` 監視 → 3h 超過で `RunConsolidation` 発火 |
| RunConsolidation | `go/internal/vector/consolidation.go` | D0 クラスタリング → Gemma LLM で D1 生成 → D0 archived |
| RefineSemanticEdges | `go/internal/vector/consolidation.go` | D1 間コサイン類似度 ≥ 0.85 で `semantic` エッジ追加 |
| GoogleStudioProvider | `go/internal/ai/google_studio.go` | Gemma / Gemini API 呼び出し（リトライロジック付き） |
| ep-expand | `go/indexer/indexer.go` | D1 スラグ → archived D0 children の body を連結返却 |
| ai.setMeta RPC | TypeScript → Go bridge | `meta:last_activity` を Pebble DB に永続化 |

### Sleep Consolidation フロー

```
[2分 ticker]
  └─ checkSleepThreshold()
       ├─ last_activity 読み込み（Pebble DB: meta:last_activity）
       ├─ now - last_activity > 3h AND last_consolidation < last_activity → true
       └─ RunConsolidation() goroutine 発火
            ├─ 1. unarchived D0 全件スキャン（Pebble: ep: プレフィックス）
            ├─ 2. 時系列ソート → chunkSize=10 でクラスタリング
            ├─ 3. Gemma-3-27B: D0 群 → D1 body 生成
            ├─ 4. Gemma-3-27B: D1 body → slug 生成
            ├─ 5. Gemini Embedding: D1 body ベクトル化
            ├─ 6. D1 .md ファイル書き込み（d1-summary タグ）
            ├─ 7. D0 に archived タグ + parent エッジ追加
            └─ 8. RefineSemanticEdges()（D1 間の semantic リンク）
```

---

## 前提条件チェック

```bash
# ゲートウェイ起動確認
ps aux | grep 'openclaw.*gateway' | grep -v grep

# サイドカー起動確認
ps aux | grep episodic-core | grep -v grep

# socket addr ファイル確認
cat /tmp/episodic-claw-socket.addr

# Pebble DB 確認（episodes ディレクトリ）
ls /root/.openclaw/workspace-keruvim/episodes/vector.db/ | head -5
```

---

## TC-5.7-1: Sleep Timer トリガー確認

**目的**: `ai.setMeta` で `last_activity` を過去 (now-4h) に設定し、2分以内に `checkSleepThreshold` が発火することを確認

### 実行スクリプト

```javascript
// Node.js RPC スクリプト（/tmp/setmeta_test.js）
const net = require('net');
const fs  = require('fs');

const socketPath = fs.readFileSync('/tmp/episodic-claw-socket.addr', 'utf8').trim();
const past4h     = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

const payload = JSON.stringify({
  jsonrpc: '2.0', id: 1,
  method: 'ai.setMeta',
  params: { key: 'last_activity', value: past4h }
}) + '\n';

const client = net.createConnection(socketPath, () => {
  client.write(payload);
});
client.on('data', d => { console.log('Response:', d.toString()); client.destroy(); });
```

```bash
# WSL 実行
node /tmp/setmeta_test.js
# Expected: Response: {"jsonrpc":"2.0","id":1,"result":true}

# Sleep Timer 発火を 2〜3 分待機してログ確認
sleep 130 && grep "Sleep Timer triggered" /tmp/episodic-core.log
```

### 合否基準

- [x] `ai.setMeta` が `true` を返す（Pebble DB 書き込み成功）
- [x] 2〜3 分以内に `[Episodic-Core] Sleep Timer triggered` ログが出力される
- [x] ログに `Idle for >3h` の記述がある

### 実績 (2026-03-27 02:19)

```
[WSL] ai.setMeta {key:"last_activity", value:"<now-4h>"} → response: true
[Episodic-Core] Sleep Timer triggered for /root/.openclaw/workspace-keruvim/episodes (Idle for >3h)
  タイムスタンプ: 02:19:57 (setMeta 送信から正確に2分後)
```

**判定: ✅ PASS** — Sleep Timer が `last_activity` 更新を検知し、2分以内に `checkSleepThreshold` 発火

---

## TC-5.7-2: Sleep Consolidation 動作確認

**目的**: D0 エピソードが D1 サマリーに昇格し、`archived` タグが付与され、`RefineSemanticEdges` がセマンティックリンクを追加することを確認

### 実行方法

TC-5.7-1 の Sleep Timer 発火後に自動実行される。または `ai.consolidate` RPC で直接トリガー可能。

```javascript
// 直接トリガー（テスト用）
const payload = JSON.stringify({
  jsonrpc: '2.0', id: 2,
  method: 'ai.consolidate',
  params: {}
}) + '\n';
```

### 確認コマンド

```bash
# D1 ノード生成確認
ls /root/.openclaw/workspace-keruvim/episodes/2026/03/27/*d1*.md 2>/dev/null

# D1 frontmatter 確認
head -20 $(ls /root/.openclaw/workspace-keruvim/episodes/2026/03/27/*d1*.md | head -1)

# D0 archived 確認
grep -l "archived" /root/.openclaw/workspace-keruvim/episodes/2026/03/26/*.md | wc -l

# RefineSemanticEdges ログ確認
grep "RefineSemantic\|Linked" /tmp/episodic-core.log | tail -10

# Consolidation ログ確認
grep "SleepConsolidation\|D1\|archived" /tmp/episodic-core.log | tail -20
```

### 合否基準

- [x] `[SleepConsolidation] Generated D1: <slug>` が 1件以上ログに出力される
- [x] D1 .md ファイルが `episodes/YYYY/MM/DD/` に生成される
- [x] D1 frontmatter に `d1-summary` タグと `related_to: [{type: child}]` エッジが存在する
- [x] D0 ファイルに `archived` タグが追加される（10件以上）
- [x] `[RefineSemantic] Linked X <-> Y` ログが出力される（D1 が 2件以上ある場合）
- [x] `[SleepConsolidation] Consolidation Job Completed.` でエラーなく終了する

### 実績 (2026-03-27 02:31)

```
[SleepConsolidation] Found 20 unarchived D0 nodes to process.
[SleepConsolidation] Generated D1: keruvim-memory-d1-1774554436706
[SleepConsolidation] Generated D1: sem-mem-d1-1774554472327
[SleepConsolidation] Generated D1: keruvim-ethos-1774554496646
[RefineSemantic] Linked keruvim-memory-d1-1774554436706 <-> sem-mem-d1-1774554472327
[RefineSemantic] Linked sem-mem-d1-1774554472327 <-> keruvim-memory-d1-1774554436706
[SleepConsolidation] Consolidation Job Completed.
```

D1 frontmatter 確認 (`keruvim-memory-d1-1774554436706.md`):

```yaml
id: keruvim-memory-d1-1774554436706
title: 'Semantic Consolidation: keruvim memory d1 1774554436706'
tags:
  - d1-summary
saved_by: auto
related_to:
  - id: agent-identity-setup
    type: child
  - id: episodic-memory-failures
    type: child
  - id: ep-save-test-refactor
    type: child
  - id: agent-name-testing
    type: child
  - id: agent-name-issue
    type: child
  - id: openclaw-agent-name-testing
    type: child
  - id: openclaw-ui-resolved
    type: child
  - id: keruvim-memory-d1-1774554472327
    type: semantic
    weight: 0.927
```

- D0 archived 件数: 10件 (2026/03/26) + 1件 (2026/03/27) = 11件
- D1 ファイル: `/root/.openclaw/workspace-keruvim/episodes/2026/03/27/` に 3件

**判定: ✅ PASS** — D0→D1 昇格・archived タグ付与・semantic エッジ追加すべて確認

---

## TC-5.6-3 (完全版): ep-expand で D1 展開確認

**目的**: TC-5.7-2 で生成した D1 スラグを `ep-expand` に渡し、archived D0 children の body が正常に取得できることを確認

> 注意: D1 ノードが存在しない場合は TC-5.7-2 を先に実行すること

### 確認コマンド（WSL Node.js RPC）

```javascript
// /tmp/ep_expand_test.js
const net = require('net');
const fs  = require('fs');

const socketPath = fs.readFileSync('/tmp/episodic-claw-socket.addr', 'utf8').trim();
const D1_SLUG    = 'keruvim-memory-d1-1774554436706'; // TC-5.7-2 で生成されたスラグに変更

const payload = JSON.stringify({
  jsonrpc: '2.0', id: 3,
  method: 'ai.expand',
  params: { slug: D1_SLUG }
}) + '\n';

const client = net.createConnection(socketPath, () => { client.write(payload); });
let buf = '';
client.on('data', d => { buf += d.toString(); });
client.on('end', () => {
  const res = JSON.parse(buf);
  console.log('children:', res.result.children.length, 'body_len:', res.result.body.length);
  client.destroy();
});
```

### 合否基準

- [x] `ai.expand` が `children` 配列（1件以上）と `body` 文字列を返す
- [x] `body` に D0 エピソードの内容（`Episode ID:` プレフィックス）が含まれる
- [x] エラーなし（`D1 not found` / `socket not connected` が出ないこと）
- [x] `[Episodic-Core] Method: ai.expand` がログに記録される

### Telegram 経由での確認

```
「ep-expandツールでスラグ <D1_SLUG> を展開してください」
```

期待レスポンス: 8件の子エピソード内容（agent-identity-setup 等）が表示される

### 実績 (2026-03-27 03:05 / 03:42)

```javascript
// 直接 RPC 実行結果
{
  body: "Episode ID: agent-identity-setup\n..." // 142,309 chars
  children: ["agent-identity-setup","episodic-memory-failures","ep-save-test-refactor",
             "agent-name-testing","agent-name-issue","openclaw-agent-name-testing",
             "openclaw-ui-resolved", ...] // 8 children
}

// Telegram 経由 (03:42): ai.expand ログ確認
// {"level":"info","message":"[Episodic-Core] Method: ai.expand","timestamp":"2026-03-27T03:42:22+07:00"}
```

**判定: ✅ PASS** — D1 スラグ指定で archived D0 children 8件・本文 142KB を正常取得

---

## 発見・修正バグ

### BUG-3: consolidation.go LLM モデル quota 枯渇

**現象**: `[SleepConsolidation] Error processing cluster: LLM generation failed: API error (status 429)`

**根本原因**: `gemma-3-27b-it` が Google AI Studio の別 quota pool を持ち、TPM 15K/分の制限を超過

**修正経緯**:
1. 2026-03-27 02:xx: 429 エラー発生 → 一時対処として `gemini-2.5-flash` + `gemini-embedding-001` に変更
2. 2026-03-27 03:2x: TPM 制限は一時的と判明 → `gemma-3-27b-it` + `gemini-embedding-2-preview` に復元
3. 2026-03-27 03:3x: Provider 層へのリトライ実装はアーキテクチャ問題（Rate Limiter と非協調）と判明 → **Decorator パターンに変更**

**最終修正 (2026-03-27)**: `provider.go` に Decorator パターンを実装。Rate Limiter と完全協調したリトライ。

```go
// go/internal/ai/provider.go
// RetryLLM / RetryEmbedder:
//   各リトライ前に Limiter.Wait() → Inner 呼び出し → 429/5xx → backoff → Limiter.Wait() → …
type RetryLLM struct {
    Inner      LLMProvider
    Limiter    *rate.Limiter  // consolidation.go の gemmaLimiter と同一インスタンス
    MaxRetries int            // 3
    BaseDelay  time.Duration  // 2s → 4s → 8s
}

// consolidation.go での使用（processCluster はインターフェース受け取り）
llm, embed := ai.NewRetryPair(llmRaw, embedRaw, gemmaLimiter, embedLimiter)
```

**対象ファイル**:
- `go/internal/ai/provider.go` — `RetryLLM`, `RetryEmbedder`, `APIError`, `NewRetryPair()` 追加
- `go/internal/ai/google_studio.go` — `withRetry()` 除去、`*APIError` 返却に変更
- `go/internal/vector/consolidation.go` — `processCluster` 引数をインターフェース化、手動 `limiter.Wait()` 3箇所削除

---

## テスト結果サマリー

| テストケース | 結果 | 実行日時 | 証拠 |
|---|---|---|---|
| TC-5.7-1: Sleep Timer 発火 | ✅ PASS | 2026-03-27 02:19 | `Sleep Timer triggered` ログ（setMeta から 2分後） |
| TC-5.7-2: D1 生成 + archived + RefineSemanticEdges | ✅ PASS | 2026-03-27 02:31 | D1 ×3 生成、D0 archived ×11、semantic リンク ×2 確認 |
| TC-5.6-3 (完全版): ep-expand D1 展開 | ✅ PASS | 2026-03-27 03:05 + 03:42 | children 8件・body 142KB 正常取得 |

---

## WSL ログ監視コマンド（テスト中は別ターミナルで実行）

```bash
# サイドカーログをリアルタイム監視
tail -f /tmp/episodic-core.log | grep -E "SleepConsolidation|RefineSemantic|D1|archived|ai.expand|ai.consolidate|429"

# Consolidation 完了確認
grep "Consolidation Job Completed" /tmp/episodic-core.log

# D1 ファイル一覧
ls -lt /root/.openclaw/workspace-keruvim/episodes/$(date +%Y)/$(date +%m)/$(date +%d)/*d1*.md 2>/dev/null
```

---

## 参照ドキュメント

- `docs/phase_5.6_test_plan.md` — TC-5.6-3 / TC-5.9 実行ログ
- `docs/phase_5_integration_test_report.md` — Phase 5.5〜5.9 統合テストプラン & 最終レポート（旧 phase_5_integration_test_plan.md を統合済み）
- `docs/phase_5_integration_test_report.md` — Phase 5.5〜5.9 最終統合テストレポート
- `go/internal/vector/consolidation.go` — Sleep Consolidation 実装
- `go/internal/ai/provider.go` — Decorator パターン（`RetryLLM` / `RetryEmbedder` / `NewRetryPair`）
- `go/internal/ai/google_studio.go` — Gemini API プロバイダー（純粋 HTTP クライアント、`*APIError` 返却）
- `docs/phase_6_topics_plan.md` — Phase 5.7 テスト中に発見した `tags` vs `topics` 設計課題への対応プラン。D1 frontmatter に `topics:` フィールドを追加し CJK 多言語コンテンツタグを `tags`（システム管理）から分離する方針を定義。
