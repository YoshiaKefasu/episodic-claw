# 容赦ないコードレビュー：Episodic Memory Phase 3 (Retrieval + Assemble + PebbleDB/HNSW)
（Reviewer: Staff Software Engineer, Google）

## TL;DR: アーキテクチャの選択は完璧だが、Phase 2で直したはずの「並行処理の穴」がまた開いている
PebbleDB (LSM) + HNSW (In-Memory) のハイブリッド設計は、100kエピソードでも数ミリ秒のRecallを実現する業界最高峰の選択だ。 [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) の ID マッピング（s2i / i2s）や Temporal Re-rank の実装も堅実だし、TS側の `ep-recall` / `ep-save` ツール登録による「エージェント自律型の記憶操作」は、プラグインアーキテクチャとして極めてエレガントだ。

しかし、コードを読んだ結果、**Phase 2 で私が指摘し、お前が見事に修正した「並行処理」に関する新しい、より深刻な問題が3件**、そして **Recall パイプラインのパフォーマンスを殺す設計上の欠陥が1件**見つかった。
このまま本番に入れれば、高負荷時にJSONレスポンスが混線してクライアントがパニックを起こすか、Rebuildが全RPCを数十秒単位でブロックしてOpenClaw本体がタイムアウトする。

---

## 🚫 致命的欠陥 (P0 レベル)

### 1. [sendResponse](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#105-109) / [sendEvent](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#110-119) の並行書き込み競合（Data Race on `net.Conn.Write`）
**問題ファイル:** [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) (L105-L108, L110-L118)
**問題箇所:**
```go
func sendResponse(conn net.Conn, resp RPCResponse) {
	bytes, _ := json.Marshal(resp)
	conn.Write(append(bytes, '\n'))
}
```
**理由:**
Phase 2のレビューで `go handleSurprise(conn, req)` としてGoroutineで並行化した。これ自体は正しかった。
しかし、その結果として**複数のGoroutineが同時に同一の `conn` に対して `Write` を呼ぶ**ようになった。
Go の `net.Conn.Write` はドキュメント上 "safe for concurrent use" とされるが、これは**個々のWrite呼び出しがアトミックに書き込まれることを保証しない**。大きなレスポンス（例えば Recall の結果が数KB）が2つ同時に Write された場合、**JSONの断片が interleave（混線）** して `{"jsonrpc":"2.0","result":[{"Re{"jsonrpc":"2.0","result":"pong"...` のような壊れたバイト列がTS側のソケットに流れ込む。TS側の `readline` はこれを1行として読み取り、`JSON.parse` がクラッシュする。
**解決策:**
[sendResponse](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#105-109) に `sync.Mutex` を導入し、JSONのマーシャリングから `Write` と改行の送信までをアトミックに保護せよ。
```go
var writeMu sync.Mutex

func sendResponse(conn net.Conn, resp RPCResponse) {
	data, _ := json.Marshal(resp)
	data = append(data, '\n')
	writeMu.Lock()
	conn.Write(data)
	writeMu.Unlock()
}
```
あるいは、各コネクションに専用の書き込みチャネル（`chan []byte`）を持たせ、シリアライズされた書き込みGoroutineで処理するプロデューサー・コンシューマーパターンが最もGoらしい設計だ。

---

### 2. [handleIndexerRebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#181-260) の直列 `filepath.Walk` がAPI Rate Limitを無視し、他の全RPCをブロックする
**問題ファイル:** [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) (L216-L251)
**問題箇所:**
```go
err = filepath.Walk(params.Path, func(path string, info os.FileInfo, err error) error {
    // ...
    emb, err := provider.EmbedContent(ctx, doc.Body)  // ← 1ファイルずつ直列呼び出し
    // ...
})
```
**理由:** 2つの問題がある。
1. **直列実行:** 数百のMarkdownを1つずつ順番にEmbedding APIに投げている。1リクエスト約200-500msとすると、100ファイルのRebuildに **50秒〜2分以上かかる**。この間、他のRPC（ping, recall）は `storeMutex.Lock()` を待ち続ける（[getStore](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#29-44) 経由）。ただし現状の `storeMutex` は [getStore](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#29-44) のみに影響するので、正確には `vstore.Clear()` から `vstore.Add()` へ至る `store.mutex.Lock()` が Rebuild 中ずっと保持され、**Recall が完全にブロックされる**。
2. **Rate Limit:** Google AI Studio の Embedding API には1分あたりのリクエスト数制限がある。数百ファイルを一気に叩けばすぐに `429 Too Many Requests` が返り、Rebuildが中途半端に失敗する。
**解決策:**
- `errgroup` と Semaphore（`make(chan struct{}, 10)` 等）を用いた **Goroutine fan-out** で並列化+同時実行上限を設ける。
- Rebuild中もRecallが動くよう、**新旧ダブルバッファリング**（新しいStoreを構築し、完成したらアトミックにスワップ）を検討せよ。

---

## ⚠️ 潜在的リスク (P1 レベル)

### 3. Retriever の N+1 クエリ問題（ファイルI/O の連鎖的増幅）
**問題ファイル:** [src/retriever.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/retriever.ts) (L44-L50)
**問題箇所:**
```typescript
for (const res of results) {
    const doc = await this.rpcClient.parseFrontmatter(sourcePath);
    // ...
}
```
**理由:**
`ai.recall` でTop-5のエピソードを取得した後、それぞれの `sourcePath` に対して **1件ごとに** `frontmatter.parse` RPCを叩き、Go側がMarkdownをディスクI/Oで読み直している。これは典型的な **N+1 クエリ問題** だ。
K=5 であれば 1 (recall) + 5 (parse) = 6 往復のRPC通信が発生する。Recall のレイテンシ自体がHNSWの超高速（1ms以下）で設計されているのに、結果の組み立て段階で各エピソードの本文取得に5回のファイルI/Oが逐次発生し、**トータルの assemble レイテンシが100ms以上に膨張**する可能性がある。
**解決策:**
Go側の [Recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#242-305) RPC（あるいは新設の `RecallFull` RPC）で `SourcePath` に基づいてファイル本文も一緒に読み込み、[ScoredEpisode](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#32-37) に `Body string` フィールドを追加して一度の応答で全データを返すバッチ型設計にすべきだ。

### 4. [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) の `Grow` 呼び出しにおけるID連続性の暗黙的仮定
**問題ファイル:** [go/internal/vector/store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) (L115-L116, L184)
**問題箇所:**
```go
s.graph.Grow(int(uid))
s.graph.Add(hnsw.Point(rec.Vector), uid)
```
**理由:**
`go-hnsw` の `Grow(id int)` は内部バッファを [id](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#11-14) の値まで拡張するものだが、IDが大きく飛んだ場合（例: 削除後にmaxIDが飛ぶ、あるいは手動でIDが設定される場合）、**バッファのメモリ使用量がID値に比例して膨張**する。これは現状のインクリメンタルID方式では問題にならないが、将来 Episode の削除機能を追加した際にID空間に穴が開き、メモリ効率が低下する可能性がある。
**解決策（将来的）:**
ID再利用の仕組み（Free list）を導入するか、あるいは `Grow` を呼ばずに必要時に自動拡張する上位のラッパーを検討する。現時点ではインクリメンタルIDなので **P2（低優先度）** として記録しておく。

---

## ✅ 評価できる点 (Good)
- **PebbleDB + HNSW のハイブリッド設計:** Source of Truth がMarkdownのままであり、Pebble が飛んでも [rebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#175-178) で完全復元できる壊れないアーキテクチャ。
- **エージェントのストアを `agentWs` 単位で分離** (`vectorStores` map): マルチエージェント環境を正しくサポートしている。
- **`ep-recall` / `ep-save` ツール登録:** エージェントが「自律的に過去の記憶を検索・保存する」という未来のUXを先取りした設計。
- **JSON + msgpack 双方のタグ修正:** シリアライズ/デシリアライズの境界でのサイレント破壊を防いだ。

## 総評
P0 の2件（Write競合とRebuildの直列+ブロック）は本番で確実にインシデントを引き起こすレベルだ。特に [sendResponse](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#105-109) の競合は、Phase 2の修正（Goroutine化）によって新しく生まれた「二次的なバグ」であり、並行処理の導入には常にデータレースの精査が必要であることを改めて肝に銘じてほしい。

P1 のN+1問題はパフォーマンスに直結するため、P0の修正と合わせて対処すべきだ。修正が完了するまで、Phase 3のSign-offは出せない。
