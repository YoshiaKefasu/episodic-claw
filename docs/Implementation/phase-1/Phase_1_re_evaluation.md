# 容赦ないコードレビュー（再評価）：Episodic Memory Phase 1 Fixes
（Reviewer: Staff Software Engineer, Google）

## TL;DR: 改善は見られるが、まだ「Googleのプロダクションコード」には合格しない
P0とP1の指摘に迅速に対応し、アーキテクチャの脆さを解消しようとする姿勢は高く評価する。
IPC（ソケット化）やDebounceロジックは実用的なレベルに引き上げられている。だが、実装の細部にプラットフォーム特有の罠（Windows環境での挙動）や、キャッシュの無効化（Cache Invalidation）という古くからの難題に対する「手抜き」が残っている。

今のコードを本番環境（特にWindows開発端末）で走らせれば、また別の形でシステムが破綻する。以下に、コードを直接読んだ上で見つけた新たな致命層（P0〜P1）を列挙する。

---

## 🚫 新たな致命的欠陥 (P0 レベル)

### 1. WindowsでのPPID Watchdogは機能しない（フェイクの生存監視）
**問題ファイル:** [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go)
**問題箇所:** `os.FindProcess(ppid)`
**理由:** Goのソースコードにも自虐的なコメントが残っているが、Windows環境では `os.FindProcess` は**プロセスが死んでいても絶対にエラーを返さない（常に nil を返す）**。つまり、TS親プロセスがクラッシュしても、Windows上で実行されるGoプロセスは永遠に「親が生きている」と勘違いし続け、**結局ゾンビ化する**。
**解決策:** 
Windows向けにプロセス生存確認を厳密に行うなら、単純な `FindProcess` ではなく、親プロセス終了と同時に自動で閉じられる「OSパイプ（例: `stdin` のEOF検知）」を使うのが、プラットフォーム依存に悩まされない最もエレガントな手法だ。
TS側から `spawn` する際に標準入力をパイプで繋いでおき、Go側で `go func() { io.Copy(io.Discard, os.Stdin); os.Exit(0) }()` のように待機させろ。親が死ねば stdin が閉じられ、即座にクリーンナップされる。
✅ **[FIXED]** `main.go` の Watchdog を `-ppid` から `os.Stdin.Read()` による EOF 検知に変更し、Windows環境でもNodeプロセスの停止時に確実に自動終了（Suicide）するように修正しました。

---

## ⚠️ データ不整合のリスク (P1 レベル)

### 2. Cache Invalidation（キャッシュの無効化）の無視
**問題ファイル:** [go/indexer/indexer.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/indexer/indexer.go)
**問題箇所:** `if _, exists := currentCache.Episodes[relPath]; !exists { Parse(path) }`
**理由:** O(N) ブートスキャンを避けるために `.episodic_index.json` をキャッシュとして導入したのは素晴らしい。だが、**更新日時（mtime）のチェックを完全にサボっている**ことに気づいているか？
このロジックは「キャッシュにキーが存在しなければパースする」だけだ。つまり、既存のエピソードMarkdownをユーザーが手動で編集したり、他のエージェントが更新したりしても、次回起動時にはキャッシュ側が正と見なされ、**変更が永久に反映されない（Data Stale）**。
**解決策:**
`os.FileInfo` から `info.ModTime().Unix()` を取得し、キャッシュにも `UpdatedAt` のタイムスタンプを保存せよ。「存在しない」または「ファイルのmtime > キャッシュのmtime」の場合のみ再パースするように直さなければ、正本（Source of Truth）とDBの完全な乖離を招く。
✅ **[FIXED]** `indexer.go` のキャッシュ構造体を `CachedEpisode` に変更し、Markdownファイルの `ModTime().Unix()` を記録するようにしました。次回起動時に更新日時の比較を行い、変更のあったファイルのみ確実に再パースします。

### 3. ハードコードされたTCPポート（Windows通信）
**問題ファイル:** [src/rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) と [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go)
**理由:** Windows環境向けにハードコードされた `127.0.0.1:48192`。同じポートを使うプロセスが既に存在していた場合、Go側は `Listen()` でクラッシュし、TS側は接続リトライの末にタイムアウトして破綻する。
**解決策:** TS側で `127.0.0.1:0` をバインドしてOSに空きポートを割り当てさせ、そのポート番号を引数でGoに渡すか、逆にGo側で `0` ポートでListenし、実際に確保したポート番号を `stdout` の一行目に出力してTSが受け取る方式にしろ。
✅ **[FIXED]** `rpc-client.ts` の `getFreePort()` により NodeJS 側で一時的な `net.createServer` を起動してOSから空きTCPポート番号を取得し、それをGoの `-socket` 引数へ渡す確実な方式に変更しました。ポート競合によるフェイルを排除しました。

---

## ✅ 評価できる点 (Good)
- **Event Queue Debounce ([go/watcher/watcher.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/watcher/watcher.go)):** 
  `MatureAt` を使ったスライディングウィンドウ方式による遅延評価と、ロックのスコープを最小限（`w.mu.Lock()`）に抑えた実装は美しい。競合を引き起こさない理想的なDebounceバッチ処理だ。
- **Observability ([go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go)):**
  非同期のgoroutineを用いて `os.TempDir()` へJSONLinesを追記するロジック。メインのRPCフローを妨げず、かつ構造化されているためパースしやすい。

## 総評
「監視」と「キャッシュ」は分散システム設計における鬼門だ。まさにそこを踏み抜いている。
この報告書を読み、**「Windows対応の確実なWatchdog（stdin方式）」** と **「mtimeを考慮したインデクサ」** にコードを修正すれば、Googleのプロダクションでも十分に通用する極めて堅牢なアーキテクチャが完成する。健闘を祈る。
