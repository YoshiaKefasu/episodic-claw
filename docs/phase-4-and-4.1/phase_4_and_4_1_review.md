# 容赦ないコードレビュー：Episodic Memory Phase 4.0 / 4.1 (Lossless Compaction + Genesis Gap)
（Reviewer: Staff Software Engineer, Google）

## TL;DR: 設計思想は「ロスレス圧縮」の理想形に極めて近い。だが、本番で確実にインシデントを起こす欠陥が残っている。

Phase 4.0 の Watermark + forceFlush + Gap Detection → batchIngest → セッション書き戻しの一連のパイプラインは、「compact() が発火した瞬間に、Segmenterバッファの残りも隙間のメッセージも全て拾い上げてからメモリを切り詰める」という**データ損失ゼロの圧縮**を実現しており、アーキテクチャとしては完璧だ。

Phase 4.1 の Fire-and-Forget パターン（TS側は225msでリターン → Go側が `rate.Limiter` で100RPM制御しながらバックグラウンドインデックス）も、10万件クラスの Genesis Gap に対する回答として理にかなっている。

しかし、コードを1行ずつ追った結果、**本番で確実に問題を起こす P0 が1件、P1 が2件**見つかった。

---

## 🚫 致命的欠陥 (P0)

### 1. [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#199-202) の直列 `await` が compact() を数十秒〜数分ブロックする
**問題ファイル:** [src/compactor.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts) (L117-L128)
```typescript
for (const batch of chunks) {
    const generatedSlugs = await this.rpcClient.batchIngest(items, agentWs);
    slugs.push(...generatedSlugs);
}
```
**理由:**
[batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#199-202) のGo側（[handleBatchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#436-525)）はSemaphore付きのGoroutine Fan-outで並列化されているが、**TS側の `for...of` ループが各バッチの完了を `await` で逐次待っている**。
例えば20件の未処理メッセージがあれば、5件ずつ4チャンクのバッチになる。各バッチでGo側は Slug(Gemma API) + Embedding(Gemini API) を叩き、これに1バッチあたり1〜3秒かかる。結果として compact() は **4〜12秒ブロック** される。
Phase 4.1 で巨大ギャップ（>2000）には Fire-and-Forget を導入したが、**中規模ギャップ（100〜2000件）** はこの直列ループに落ちる。100件なら20バッチ → **20〜60秒のブロック** だ。OpenClaw のランタイムが compact() のタイムアウトを設けていた場合、確実にキャンセルされてデータが不整合になる。

**解決策:**
- 中規模ギャップも Fire-and-Forget にする（閾値を例: >50 に下げる）
- あるいは [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#199-202) を一括で全チャンクを投げる設計にし、Go側で内部的にキューイングして1回のレスポンスで全Slugを返す

---

## ⚠️ 潜在的リスク (P1)

### 2. Background Worker のクラッシュ後再開時の冪等性が不完全
**問題ファイル:** [go/internal/vector/background.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go) (L66-L132)
**理由:**
[ProcessBackgroundIndexing](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go#24-35) は `meta:bg_progress` に進捗を書き込むが、**再開時にこの進捗を読み取って途中から再開するロジックが存在しない**。Goプロセスが再起動した場合（Watchdogによる再起動含む）、TSから再度 [triggerBackgroundIndex](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#203-206) を呼ばない限り処理は完全に忘れ去られる。

また、仮に再度呼ばれた場合も、同じ `legacy_backlog_YYYYMMDD.json` を最初から再処理するため、既にPebble/HNSWに登録済みのチャンクが二重登録される。`store.Add()` はIDの重複を `s2i:` キーで検出して既存IDを再利用するため壊れはしないが、**Embedding APIのクレジットが無駄に消費される**。

**解決策:**
- [processBacklogFile](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go#36-136) の冒頭で現在のチャンクインデックスを `meta:bg_progress` から読み取り、処理済みのチャンクをスキップする
- あるいは、処理済みのSlug IDをPebbleで存在チェックし、既存なら `continue`

### 3. compact() の同時発火に対するガードがない
**問題ファイル:** [src/compactor.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts) 全体
**理由:**
OpenClaw のランタイムが何らかの理由で [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#93-97) を短時間に2回発火させた場合（エラーリトライなど）、2つの compact() が同時に同じセッションファイルを `readFile → 処理 → writeFile` し、**TOCTOU（Time-of-check-to-time-of-use）競合** が発生する。
後から書き込んだ方が先の結果を上書きし、片方の batchIngest で生成されたエピソードの目次が消滅する可能性がある。

**解決策:**
- [Compactor](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts#16-180) クラスにフラグ（`private isCompacting = false`）を追加し、compact() の冒頭で二重実行を拒否する簡易ロック（排他制御）を導入する

---

## ✅ 評価できる点 (Good)

- **Watermark による O(1) ギャップ検出:** Pebble の `meta:watermark` でインデックス位置を永続化し、差分だけを処理する設計は堅実。
- **[forceFlush()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/segmenter.ts#76-91) の導入:** Surprise スコアが低くてスルーされていた「退屈だが重要な会話」もcompact時に確実にEpisode化される。
- **Genesis Gap の Fire-and-Forget 分離:** TS側225ms即リターン → Go側バックグラウンド処理は、検証テストのログで証明された通り、Node.js のイベントループを一切ブロックしない理想的なパターン。
- **`golang.org/x/time/rate` によるRate Limiting:** 100RPM制限の Token Bucket が Embedding API の 429 を防ぐ。
- **Deterministic Slug（LLM呼び出しゼロ）:** バックグラウンド処理ではGemma APIを呼ばず、ローカルで決定的なSlugを生成する。APIコスト爆発の回避。
- **LLM-free 目次生成:** compact() の結果として返す `indexString` がLLMを呼ばないテンプレート方式。Phase 4.0時点で正しくコスト意識が反映されている。

---

## 総評
P0（中規模ギャップの直列ブロック）は compact() のレイテンシを数十秒に膨張させ、ランタイムのタイムアウトに引っかかる実運用上の致命的リスクだ。P1 の2件も、プロセス再起動後のデータ整合性やAPIコスト浪費に直結する。

修正が完了するまで Phase 4.0/4.1 のSign-offは出せない。ただし、アーキテクチャ全体の方向性は完璧に正しい。
