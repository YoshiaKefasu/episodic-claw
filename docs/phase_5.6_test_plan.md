# Phase 5.6〜5.9 テストプラン

> 作成日: 2026-03-26
> 前提: Phase 5.5 E2E 全テスト PASS 済み（TC-5.5-1/2/3）
> 実行環境: WSL + Edge ブラウザー (Telegram Web @keruvim_bot)
> 接続: chrome-cdp target `663C7FF6`

---

## TC-5.6-3: ep-expand テスト（Lazy Loading）

**目的**: `ep-recall` で取得したスラグに対し `ep-expand` で詳細展開（archived D0 取得）を確認

### 注意

Sleep Consolidation（TC-5.7）が未実行のため D1 ノードは存在しない可能性がある。
その場合は D0 スラグで `ep-expand` を実行し、API 疎通とレスポンス形式を確認する。

### 実行スクリプト

```
Turn 1: 「ep-recallツールでgoroutineについて検索してください」
Turn 2: （recall 結果を受けて）「最初のエピソードのスラグを ep-expand で展開してください」
```

### 合否基準

- [x] `ep-recall` が 1 件以上の結果を返す（`goroutine-vs-threads` 等 3件ヒット）
- [x] `ep-expand` が呼ばれ、レスポンスが返る（D0スラグのため「D1 not found」 — RPC 疎通確認）
- [x] エラーなし（`RPC timeout` / `socket not connected` が出ないこと）
- [x] ログに `[Episodic-Core] Method: ai.expand` が記録される（01:20:06 確認）

### WSL 確認コマンド

```bash
grep -i "expand\|ai.expand" /tmp/openclaw-gw3.log | tail -10
grep "ai.expand" /root/.openclaw/ep-save-trace.log 2>/dev/null | tail -5
```

---

## TC-5.9: CJK 実環境テスト（日本語）

**目的**: 日本語会話でエピソードが生成され、`ep-recall` で検索できることを確認

### 実行スクリプト

```
Turn 1: 「HNSWアルゴリズムについて詳しく教えてください」
Turn 2: 「ベクトルデータベースとはどういうものですか？」
Turn 3: 「埋め込みベクトルを使った意味検索の仕組みを教えてください」
Turn 4: 「episodic memoryの実装ではどのようなベクトル空間を使いますか？」
（話題転換）
Turn 5: 「ところで、Rustのメモリ安全性について教えてください」
Turn 6: 「ep-recallツールでベクトル検索に関するエピソードを検索してください」
```

### 合否基準

- [x] 日本語エピソードが `episodes/YYYY/MM/DD/*.md` に生成される（`2026/03/27/` に 8 ファイル）
- [x] スラグが英語 kebab-case（LLM 生成）または MD5 フォールバック（`episode-xxxxxxxx` — 想定通り）
- [x] `ep-recall query="ベクトル検索"` で関連エピソードがヒットする（`episode-fec6ab604...` / `episode-cda4ed5...` 2件）
- [x] `tokens` フィールドが 0 でない（38, 139, 228, 1317, 1711, 2298 等確認）
- [x] `surprise` フィールドが frontmatter に存在する（0.3922363 / 0.2582522 確認）

### WSL 確認コマンド

```bash
# 新規生成エピソード確認
ls -lt /root/.openclaw/workspace-keruvim/episodes/$(date +%Y)/$(date +%m)/$(date +%d)/*.md | head -5

# CJK tokens 確認
grep "tokens:" /root/.openclaw/workspace-keruvim/episodes/$(date +%Y)/$(date +%m)/$(date +%d)/*.md | tail -10

# ログ確認
grep -i "ingest\|cjk\|token\|surprise" /tmp/openclaw-gw3.log | tail -20
```

---

## テスト結果サマリー

| テストケース | 結果 | 備考 |
|---|---|---|
| TC-5.6-3: ep-expand | ✅ PARTIAL PASS (2026-03-27) | ai.expand RPC 疎通確認。D1 ノード未生成のため「D1 not found」応答（想定内） |
| TC-5.9: CJK | ✅ PASS (2026-03-27) | 8 エピソード生成、surprise-boundary 発動、ep-recall 日本語クエリ ヒット |
| TC-5.7-1: Sleep Timer | ✅ PASS (2026-03-27) | ai.setMeta last_activity=4h前 → 2分後に「Sleep Timer triggered」ログ確認 |
| TC-5.7-2: D1 生成 + ep-expand | ✅ PASS (2026-03-27) | D1 ×3 生成、D0 archived ×10、RefineSemanticEdges 動作、ai.expand → 8 children・142KB body |
| TC-5.6-3: ep-expand (完全版) | ✅ PASS (2026-03-27) | D1 スラグ `keruvim-memory-d1-1774554436706` で ai.expand → children 8件・本文取得成功 |

---

## 実行ログ

### 2026-03-27 実行記録

#### 前提: Gemini API 429 クォータ枯渇（2026-03-26 17:10〜2026-03-27 01:19）

- 2026-03-26 17:10 に `text-embedding-004` の 1日クォータ (1,500 RPD) 枯渇
- 翌日 01:19 に復活確認（`ai.surprise` 正常完了）
- TC-5.6-3 / TC-5.9 ともにクォータ復活後に実施

#### TC-5.6-3 実行ログ抜粋（2026-03-27 01:20）

```
[Episodic-Core] Method: ai.recall          ← ep-recall: goroutine-vs-os-threads 検索
[Episodic-Core] Method: ai.expand          ← 01:20:06 RPC 呼び出し成功
[Episodic-Core] Method: ai.recall          ← 関連エピソード追加検索
```

ボット応答:
```
goroutine-vs-os-threads というスラグは D1 サマリーノードとして見つからず、
展開できる D0 エピソードが存在しません。
関連エピソード:
• goroutine-vs-threads (2026-03-26 16:43)
• go-goroutine-vs-threads (2026-03-26 16:37)
```

#### TC-5.9 実行ログ抜粋（2026-03-27 01:22〜01:28）

```
[Episodic Memory] Calculated surprise: 0.3922363
[Episodic Memory] surprise-boundary exceeded. Finalizing previous episode...
[Episodic Memory] Sending 4 chunks to Go sidecar via batchIngest...
[Episodic-Core] Method: ai.batchIngest     ← episode-f62672a8... 等 4ファイル生成
[Episodic Memory] Calculated surprise: 0.2582522
[Episodic Memory] surprise-boundary exceeded. Finalizing previous episode...
[Episodic-Core] Method: ai.recall          ← ep-recall: ベクトル検索
```

ep-recall 結果:
```
episode-fec6ab604... : 意味検索の仕組み（BERT/Sentence-Transformers）
episode-cda4ed5...   : HNSWアルゴリズム（Hierarchical Navigable Small World）
```

---

## TC-5.7: Sleep Consolidation 実行ログ（2026-03-27）

### TC-5.7-1: Sleep Timer トリガー確認

```
[WSL] ai.setMeta {key:"last_activity", value:"<now-4h>"} → response: true
[エピソディックコア] Sleep Timer triggered for /root/.openclaw/workspace-keruvim/episodes (Idle for >3h)
  タイムスタンプ: 02:19:57 (setMeta 送信から正確に2分後)
```

判定: **PASS** — Sleep Timer が `last_activity` 更新を検知し、2分以内に `checkSleepThreshold` 発火

### TC-5.7-2: D1 生成・archived・RefineSemanticEdges

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
  ...（8 children）
```

- D0 archived 件数: 10件 (2026/03/26), 1件 (2026/03/27)
- D1 ファイル: `/root/.openclaw/workspace-keruvim/episodes/2026/03/27/` に 3件

判定: **PASS** — D0→D1 昇格・archived タグ付与・semantic エッジ追加すべて確認

### TC-5.6-3 完全版: ep-expand で D1 展開

```javascript
// ai.expand 直接 RPC 呼び出し
sendRPC('ai.expand', {slug:'keruvim-memory-d1-1774554436706', agentWs:ws})
// Response:
{
  body: "Episode ID: agent-identity-setup\n..." // 142,309 chars
  children: ["agent-identity-setup","episodic-memory-failures","ep-save-test-refactor",
             "agent-name-testing","agent-name-issue","openclaw-agent-name-testing",
             "openclaw-ui-resolved", ...] // 8 children
}
```

判定: **PASS** — D1 スラグ指定で archived D0 children 8件・本文 142KB を正常取得

### 注記: consolidation.go LLM モデル変更

`gemma-3-27b-it` が 429 (quota exhausted) のため変更:
- LLM: `gemma-3-27b-it` → `gemini-2.5-flash`
- Embed: `gemini-embedding-2-preview` → `gemini-embedding-001`

エピソード frontmatter 確認 (`episode-f62672a8...`):
```yaml
id: episode-f62672a8dcbfcac41c03a3e78b648737
created: 2026-03-27T01:24:29+07:00
tags: [auto-segmented, chunked, surprise-boundary]
saved_by: main
surprise: 0.3922363
tokens: 139
```
