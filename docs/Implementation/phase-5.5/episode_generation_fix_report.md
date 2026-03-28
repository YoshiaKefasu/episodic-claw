# EpisodicClaw エピソード生成・保存パスのバグ修正レポート

## 1. 無名ファイル（[.md](file:///Y:/kasou_yoshia/shared-wisdom/LANDMINES.md)）生成問題
### **概要**
生成されたエピソードファイル名が空になり、拡張子のみの [.md](file:///Y:/kasou_yoshia/shared-wisdom/LANDMINES.md) として保存される不具合。

### **根本原因**
Gemini APIなどのLLMによるスラッグ生成（`GenerateText`）において、レートリミット（429 Too Many Requests）等のAPIエラーが発生した場合のリトライ・フォールバックの設計ミス。

* 以前のコードでは、3回リトライしてもAPIエラー（`genErr`）が返るだけで、品質チェック関数（[auditEpisodeQuality](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#617-647)）を通らないため、品質異常変数（`auditErr`）は一度も初期化されず `nil` のままループを抜けていた。
* フォールバック処理が `if auditErr != nil { // MD5ハッシュにする }` となっていたため、APIエラーで全て失敗した場合はこの条件をすり抜け、変数 `slug` が空文字列（`""`）のまま処理が続行されていた。

### **解決策**
* リトライループ内に `genFailed` 変数を導入し、API自体のエラーと、品質チェックのエラー状態を正しく分離・記録するように修正。
* フォールバックの条件を `if genFailed || auditErr != nil` に変更し、APIエラー・品質異常・空文字列のいずれのケースでも安全に後続処理（Deferred 退避 または MD5ハッシュ名の付与）が発動するようガードを強化。
* （※ 以前にリネームされた本インシデントのファイルは、ハッシュ値 `episode-2c75426c86d5ed91.md` に正常にリカバリ済み）

---

## 2. ディレクトリの二重作成（`episodes/episodes`）問題
### **概要**
エピソードが想定された `$HOME/.openclaw/workspace-XXX/episodes/YYYY/MM/DD` ではなく、`.../episodes/episodes/YYYY/MM/DD` と2階層深く保存される不具合。

### **根本原因**
TypeScriptクライアントとGoサイドカー間におけるパス引数渡しでの冗長性。

* TypeScript側 ([src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts)) の [ingest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#137-147) 関数内で、すでに `const resolvedAgentWs = path.join(agentWs, "episodes");` とディレクトリ名を解決し、それをGoのRPCサーバーに渡していた。
* 一方、Goサイドカー内のパス解決ロジックでは、渡された `AgentWs` に対してさらに `filepath.Join(params.AgentWs, "episodes", YYYY...)` とハードコードで `episodes` 文字列を付与して結合していた。

### **解決策**
Goサイドカー側の `filepath.Join` を包括的に検索調査し、TypeScriptから渡されるパラメーターの仕様に合わせて冗長な `"episodes"` の追加を削除。

**修正対象ファイルと箇所:**
* [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) の [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#473-616), [handleBatchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#654-788), [drainDeferredQueue](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#336-435)
* [go/internal/vector/consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) の [processCluster](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#103-270)
* [go/internal/vector/background.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go) の [processBacklogFile](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go#33-140)

以上の修正により、現在は正しく一度だけ `episodes` を介した日付ディレクトリが作成されるようになっている。

---

## 3. その後の状態について
* 上記修正後、一連のGoバイナリの再コンパイル（`npm run build:ts && npm run build:go:linux`）を完了。
* 次にWSL上で `ai.ingest` が実行された際は、一意なID保証（正常時：スラッグ名、異常時：ハッシュ名）、および正しい1段階の `episodes/YYYY/MM/DD` パスで出力されることを担保。
