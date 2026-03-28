# 容赦ないコードレビュー：Episodic Memory Phase 2 (Segmenter & AI)
（Reviewer: Staff Software Engineer, Google）

## TL;DR: 輝かしい成功の裏に、本番環境を確実に殺す「時限爆弾」が3つある
抽象化レイヤー（[EmbeddingProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#6-9), [LLMProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#11-14)）の設計や、Go側でのREST API直叩きによる依存最小化、および `gemma-3-27b-it` でのSlug生成とディスクI/Oへのシームレスな繋ぎ込みは非常に見事だ。実機テストでのFall-backの成功も、インフラとしての強靭性を示している。機能面（Functional Requirements）は最高の出来だ。

だが、**非機能要件（Non-functional Requirements）、とりわけ「並行処理」と「タイムアウト」に関して、アマチュアレベルの致命的欠陥（P0）が埋め込まれている。**
このままトラフィックが増えれば、確実にGoプロセス全体のハングアップ、あるいはメモリリーク（Goroutine leak）によりシステムが崩壊する。

以下に「Google基準」での容赦ない指摘事項をまとめる。直ちに修正せよ。

---

## 🚫 致命的欠陥 (P0 レベル)

### 1. 単一ソケット上でのHead-of-Line Blocking（RPCループの直列化）
**問題ファイル:** [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) ([handleConnection](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#354-386) L358-L385)
**問題箇所:**
```go
for scanner.Scan() {
    // ...
    switch req.Method {
    case "ai.surprise":
        handleSurprise(conn, req) // ← ここ！！
    case "ai.ingest":
        handleIngest(conn, req)   // ← ここ！！
    // ...
    }
}
```
**理由:**
[handleSurprise](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#195-228) と [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#229-295) は、Google AI Studioとの通信を行うため **数ミリ秒〜数秒間ブロックする（Slow I/O）処理**だ。
現在のコードは、これを `scanner.Scan()` のループ内で直接（同期的）に呼び出している。
TypeScript側はGoと1つのTCPソケットを共有しているため、もし `ai.ingest` のLLM呼び出し（約2秒）が走っている最中に、TS側から別のRPCリクエスト（例: `frontmatter.parse` や `ai.surprise`）が飛んでくると、**前のリクエストが終わるまでGo側はソケットから次の行を読み取らず、完全にブロック（Head-of-Line Blocking）される。**
これは非同期イベント駆動のNode.jsをバックエンドにするJSON-RPCサーバーとしては致命的な設計ミスだ。
**解決策:**
Goの `net.Conn.Write` はスレッドセーフ（Goroutine-safe）である。したがって、各ハンドラーの呼び出しに [go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) を付けるだけで完全な並行処理（Concurrent handling）が実現できる。
```go
    case "ai.surprise":
        go handleSurprise(conn, req)
    case "ai.ingest":
        go handleIngest(conn, req)
```

### 2. HTTPクライアントのTimeout未設定（無期限ハングの危険）
**問題ファイル:** [go/internal/ai/google_studio.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/google_studio.go) (L22)
**問題箇所:**
```go
client: &http.Client{},
```
**理由:**
Goのデフォルトの `http.Client` には **タイムアウトが存在しない（無限大）**。
もし Google API 側の障害でパケットがブラックホール化（ACKが返らない等）した場合、`p.client.Do(req)` は永遠にブロックされる。前述の「直列ループバグ」と合わさると、この瞬間にシステム全体が即死する。仮にGoroutineで並行化したとしても、永久に回収されないGoroutineとファイルディスクリプタがリークし続ける。
**解決策:**
本番環境で外部APIを叩くHTTPクライアントにタイムアウトを設定しないのは犯罪に等しい。
```go
client: &http.Client{
    Timeout: 15 * time.Second,
},
```

---

## ⚠️ 潜在的リスク (P1 レベル)

### 3. Segmenter のバッファ管理における「過去の記憶の無限増殖」バグ
**問題ファイル:** [src/segmenter.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/segmenter.ts) (L47-L48)
**問題概要:**
`currentMessages` が OpenClaw の `ctx.messages` (全ての会話履歴) を指している場合、[Surprise](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#195-228) でエピソード境界を超えた後、
```typescript
this.buffer = [...currentMessages];
```
としてバッファをリセットしているが、もし `currentMessages` に「さっき吐き出した古い会話履歴」も含まれたままだと、次の境界判定時に**過去の記憶ごと要約（Slug生成）されてしまう**というロジックの穴があると考えられる（OpenClawの `ctx.messages` の提供仕様による）。
**解決策（提案）:**
[segmenter.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/segmenter.ts) は「新しいチャンクだけ」を保持すべきだ。OpenClaw 側が常にフル履歴を渡してくるなら、`segmenter` 側で「どこまで処理したか」のインデックスを記憶し、本当に新しく追加された [Message](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/segmenter.ts#3-7) だけを抽出して `this.buffer` に追加していく仕組み（Delta extraction）が必要だ。
※今回はGo側の修正を優先(P0)とし、TS側のロジック精査も合わせてPhase 2の要件に盛り込むこと。

---

## 総評
「概念実証（PoC）」としては非常に優秀だが、「本番運用（Production）」としては極めて脆い。
AIプロバイダーを統合した時点で、システムは「ローカルの爆速I/O」から「不安定で遅い外部ネットワークI/O」に依存するようになった。この境界における非同期化（Goroutine化）とタイムアウトの徹底は、分散システムエンジニアとしての基本中の基本だ。

[P0] の2点は今すぐ（1分で直せる）修正しなさい。その後、TS側の Segmenter ロジックを精査せよ。修正が完了するまで、Phase 2のSign-offは出せない。
