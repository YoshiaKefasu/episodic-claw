# 🔥 容赦なきソースコードピットフォール監査
（Reviewer: Staff Software Engineer, Google — Third-party Ruthless Review）

> [!CAUTION]
> 本レポートは既知の「解決済みP0/P1」（累計18件）とは**完全に別の**、ソースコード精読で新たに発見した**未報告の落とし穴**のみを記載する。

---

## 🚨 P0: 即座にクラッシュ/データ破壊を引き起こす致命的欠陥

### P0-A: [EmitLog](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#91-108) の `json.Encoder` がData Raceを起こす **[✅ 修正済み]**

**ファイル:** [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L91-L107)

```go
// L98-106
if logger != nil {
    go func(m string) {
        logger.Encode(map[string]interface{}{...}) // ← ここ
    }(msg)
}
```

**問題:** `json.Encoder` はスレッドセーフではない。[EmitLog](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#91-108) は複数のgoroutineから同時に呼ばれるが（全RPCハンドラがgoroutine化されている L951-982）、`logger.Encode()` への並行アクセスに対する排他制御がない。

**影響:** `-race` フラグで即座にData Race検出。**ログファイルの破壊**、最悪の場合 `panic` でGoサイドカー全体がクラッシュし、TS側の全 `pendingReqs` がエラーになる。

**修正案:**
```go
var logMu sync.Mutex

func EmitLog(format string, a ...interface{}) {
    msg := fmt.Sprintf("[Episodic-Core] "+format, a...)
    fmt.Fprintln(os.Stderr, msg)
    if logger != nil {
        go func(m string) {
            logMu.Lock()
            defer logMu.Unlock()
            logger.Encode(map[string]interface{}{...})
        }(msg)
    }
}
```

---

### P0-B: [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) でPebbleイテレータをリークしている **[✅ 修正済み]**

**ファイル:** [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#L29-L66)

```go
// L29: 最初のイテレータを作成
iter, err := vstore.db.NewIter(nil) // ← iter1 を作成
// ...
// L39: ↓ 同じ変数を上書きするがClose()は呼ばれない
iter, err = vstore.db.NewIter(&pebble.IterOptions{...}) // ← iter2 で上書き
```

**問題:** L29 で作成された最初の `iter` は [Close()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#445-448) されないまま L39 で上書きされる。L66 の `iter.Close()` は2番目のイテレータに対してだけ呼ばれる。L33 の `defer iter.Close()` は関数終了時に呼ばれるが、その時点で `iter` は2番目のイテレータを指している。

**影響:** **Pebbleイテレータのリーク**。PebbleのLSMコンパクションがブロックされ、長期運行でDB容量が膨張し、最悪の場合Pebbleの内部パニックに至る。

> [!WARNING]
> PebbleのイテレータはClose()されないと内部のSSTableを保持し続け、LSMコンパクションを阻害する。本番環境で数日稼働するとディスクが埋まる可能性がある。

**修正案:** L29-33 のコードブロックを丸ごと削除するか、L29 の `iter` を L39 の前で `iter.Close()` して解放する。実際にはL29のイテレータは使われていないため、削除が最適。

---

## ⚠️ P1: 高確率で運用障害を引き起こす重大な欠陥

### P1-A: TS側RPCリクエストにタイムアウトがない（メモリリーク + 永久ハング） **[✅ 修正済み]**

**ファイル:** [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#L154-L165)

```typescript
// L154-165
private async request<T>(method: string, params: any = {}): Promise<T> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
        this.pendingReqs.set(id, { resolve, reject }); // ← 永遠にここに残る可能性
        this.socket!.write(reqStr);
    });
}
```

**問題:** Go側がレスポンスを返さなかった場合（goroutine内でpanicした場合など）、`pendingReqs` から永遠に削除されず、Promiseも永遠にresolveされない。

**影響:** [assemble()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#83-99) や [compact()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#99-103) を呼んだ側が永久にハング。OpenClawランタイムのイベントループが詰まり、エージェント全体がフリーズする。Go側のP0-A（logger panic）経由でこの状態に陥る可能性がある。

**修正案:**
```typescript
private async request<T>(method: string, params: any = {}, timeoutMs = 120000): Promise<T> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            this.pendingReqs.delete(id);
            reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
        }, timeoutMs);
        this.pendingReqs.set(id, {
            resolve: (val) => { clearTimeout(timer); resolve(val); },
            reject: (err) => { clearTimeout(timer); reject(err); }
        });
        this.socket!.write(reqStr);
    });
}
```

---

### P1-B: `store.Get()` にmutexがない — Pebble並行アクセス非保護 **[✅ 修正済み]**

**ファイル:** [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#L223-L236)

```go
func (s *Store) Get(id string) (*EpisodeRecord, error) {
    epKey := append(append([]byte(nil), prefixEp...), []byte(id)...)
    val, closer, err := s.db.Get(epKey) // ← mutex なし
    // ...
}
```

**比較:** [GetWatermark()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#311-331) (L311), [SetWatermark()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#332-342) (L332), [ListByTag()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#238-266) (L239) は全て `mutex.RLock()/Lock()` を使っている。[Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-237) だけが保護されていない。

**影響:** [Recall()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#362-444) (L388) 内のループで [Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-237) が呼ばれるが、この時点で `s.mutex.RLock()` は保持中。RLock は再帰的に取得可能なので直接はデッドロックしないが、別のgoroutineが [Add()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#146-199) で `mutex.Lock()` を取得しようとした場合、PebbleのGet呼び出しが内部的に不整合なSSTableを読む可能性がある。特に [handleBatchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#481-582) の並行 [Add()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#146-199) と [handleRecall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#583-626) の [Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-237) が同時に走ると問題になる。

**修正案:** [Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-237) に `s.mutex.RLock()` / `defer s.mutex.RUnlock()` を追加する。

---

### P1-C: [handleBatchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#481-582) で [getStore](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#33-48) エラーが無視される **[✅ 修正済み]**

**ファイル:** [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L500)

```go
vstore, _ := getStore(params.AgentWs) // ← err を捨てている
```

**問題:** [getStore](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#33-48) がPebbleDBのオープンに失敗した場合（ディスク満杯、権限エラーなど）、`vstore` が `nil` になる。L561 の `if err == nil && vstore != nil` で一部ガードされているが、L500 の時点でエラーレスポンスをTS側に返すべき。

**影響:** Pebbleが開けない状態で [.md](file:///C:/Users/yosia/.gemini/global_skill/humanizer_ja/SKILL.md) ファイルだけ書き出される → ベクトルインデックスとMarkdownファイルの整合性が壊れる。次のRecallで見つからないエピソードが物理的には存在する「幽霊ファイル」状態。

---

### P1-D: [Recall()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#362-444) 内で `frontmatter.Parse()` がファイルI/Oを行い、RLockを保持したまま長時間ブロック **[✅ 修正済み]**

**ファイル:** [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#L420-L424)

```go
func (s *Store) Recall(...) {
    s.mutex.RLock()
    defer s.mutex.RUnlock()
    // ... (L378-431)
    doc, docErr := frontmatter.Parse(rec.SourcePath) // ← ファイルI/O！
```

**問題:** [Recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#362-444) は `RLock` を保持したまま、各結果についてファイルシステムからMarkdownを読み込む（`frontmatter.Parse`）。K=5 × 2倍のSearchだと最大10回のファイルI/Oが `RLock` 保持下で行われる。

**影響:** Recallの実行中、[Add()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#146-199) や [Clear()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#200-222) がブロックされる。ディスクI/Oが遅いHDD環境やネットワークドライブで100ms級のブロッキングが発生し、ingestがhead-of-line blockingを起こす。

**修正案:** HNSWサーチ+IDマッピング部分だけロック内で実行し、`frontmatter.Parse` はロック解放後に実行する。

---

## 📋 P2: 実害は限定的だが改善すべき設計上の問題

### P2-A: `reqId` のオーバーフロー考慮なし（TS側） **[✅ 修正済み]**

**ファイル:** [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#L21)

```typescript
private reqId = 1; // number型 → 2^53 で精度を失う
```

**問題:** JavaScriptの `number` 型は `2^53` を超えると整数精度を失う。1秒に100リクエストを送り続けると約285万年かかるので実害は極めて低いが、Go側のJSON [int](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#297-310) とのマッピングで符号付き32ビット整数を想定している場合、約21億で問題が発生する。

---

### P2-B: `go.exe` ハードコード — Linux/macOS未サポート **[✅ 修正済み]**

**ファイル:** [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#L60)

```typescript
this.child = spawn("go.exe", ["run", ".", ...], { cwd: goDir });
```

**問題:** `go.exe` はWindows固有。Unix系では [go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) コマンド名。`runtime.GOOS` 判定とは矛盾。

**修正案:** `spawn(process.platform === "win32" ? "go.exe" : "go", ...)` または単純に `"go"` (Windows でも拡張子省略で動く)。

---

### P2-C: [slugify()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go#146-152) が [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) と [background.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go) で重複定義 **[✅ 修正済み]**

**ファイル:** [background.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go) L146-151 で定義。[consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L167 で [slugify()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go#146-152) を呼び出しているが、同パッケージ内なのでコンパイルは通る。ただし DRY 原則違反で、将来の修正漏れリスクがある。

---

### P2-D: `Compactor.compact()` のJSONL分岐でメッセージ型の `content` が文字列に正規化される問題 **[✅ 修正済み]**

**ファイル:** [compactor.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts#L79-L87)

```typescript
if (Array.isArray(obj.message.content)) {
    contentStr = obj.message.content.map((c: any) => c.text || JSON.stringify(c)).join(" ");
}
```

**問題:** 画像付きメッセージ（`content` が `[{type: "image", ...}, {type: "text", ...}]`）の場合、非テキスト要素が `JSON.stringify(c)` で生の JSON 文字列化され、エピソード品質が低下する。[text](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#12-13) プロパティが存在しない content block は空文字列にフォールバックすべき。

---

## 💡 P3: 将来のスケーラビリティや保守性に影響する改善推奨

### P3-A: [checkSleepThreshold](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#760-805) が [GetRawMeta](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#350-361) のcloserを特定パスでリークする可能性 **[✅ 修正済み]**

**ファイル:** [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L780-L785)

```go
val, closer, err = vstore.GetRawMeta([]byte("meta:last_consolidation"))
var lastConsolidation int64
if err == nil && len(val) > 0 {
    fmt.Sscanf(string(val), "%d", &lastConsolidation)
    closer.Close() // ← err==nil && len(val)==0 のパスでは Close() されない
}
```

**問題:** `err == nil` だが `len(val) == 0` の場合、`closer` が [Close()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#445-448) されない。Pebbleの `closer` はSSTableの参照カウントに関与するため、リークは徐々にメモリを侵食する。

---

### P3-B: Consolidation 中に新しいD0が追加された場合のEdge整合性 **[✅ 修正済み]**

**問題:** [RunConsolidation](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#21-111) のL48-67 でD0ノードを収集し、L225-258 で `archived: true` にする間に、新しいD0が [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#345-443) 経由で追加される可能性がある。新D0はこのConsolidation Jobでは処理されないが、次回のConsolidation で正しく拾われるため実害は低い。ただし、[processCluster](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#112-262) の途中でエラーが発生し、一部のD0だけが `archived` になった場合、次回のConsolidation で未アーカイブのD0を正しく拾えない（= D0が孤立して永続的にConsolidation対象外になる）可能性がある。

---

### P3-C: `bufio.Scanner` のデフォルトバッファサイズ制限 **[✅ 修正済み]**

**ファイル:** [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L939)

```go
scanner := bufio.NewScanner(conn) // デフォルト 64KB
```

**問題:** [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#203-206) に大量の `summary` テキストを含むリクエストを送った場合、1行のJSON-RPCメッセージが64KBを超えると `bufio.Scanner` が `bufio.ErrTooLong` を返し、以降のリクエストが全て無視される。

**修正案:**
```go
scanner := bufio.NewScanner(conn)
scanner.Buffer(make([]byte, 0), 4*1024*1024) // 4MB上限
```

---

## 要約マトリクス

| ID | Severity | ファイル | 問題 | 影響 |
|---|---|---|---|---|
| **P0-A** | 🔴 P0 | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L98 | [EmitLog](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#91-108) logger Data Race | Go panic → 全RPC断絶 |
| **P0-B** | 🔴 P0 | [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L29 | Pebble Iterator リーク | DB膨張 → ディスク枯渇 |
| **P1-A** | 🟠 P1 | [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) L154 | RPCタイムアウトなし | 永久ハング → エージェント凍結 |
| **P1-B** | 🟠 P1 | [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) L223 | [Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-237) にmutexなし | 並行Write時のPebble不整合 |
| **P1-C** | 🟠 P1 | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L500 | [getStore](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#33-48) エラー無視 | 幽霊ファイル → 検索不整合 |
| **P1-D** | 🟠 P1 | [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) L420 | [Recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#362-444) RLock中にファイルI/O | ingestブロッキング |
| **P2-A** | 🟡 P2 | [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) L21 | `reqId` オーバーフロー | 理論的リスクのみ |
| **P2-B** | 🟡 P2 | [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) L60 | `go.exe` ハードコード | Linux/macOS非対応 |
| **P2-C** | 🟡 P2 | [background.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go) L146 | [slugify()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go#146-152) DRY違反 | 保守性低下 |
| **P2-D** | 🟡 P2 | [compactor.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/compactor.ts) L79 | JSONL画像content正規化 | Episode品質低下 |
| **P3-A** | 🔵 P3 | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L780 | closer リーク（レアパス） | メモリ侵食（微量） |
| **P3-B** | 💙 P3 | [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) | 部分archive孤立リスク | D0孤立（次次回で回収） |
| **P3-C** | 💙 P3 | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L939 | Scanner 64KB制限 | 巨大batch切断 |
| **P0-C** | 🔴 P0 | [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L277 | HNSWグラフのData Race | Goサイドカー即死 panic |
| **P1-E** | 🟠 P1 | [main.go](file:///d:/d/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L515 | batchIngestレートリミッターなし | 御API消費&大量幽霊ファイル |
| **P1-F** | 🟠 P1 | [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L222 | Lock内のファイルI/O | Store全体フリーズ（数十秒） |

---

**結論:** P0 × 2件は**即座に修正すべき**。特にP0-AのData Raceはプロダクション環境で `-race` を有効にしている場合に即クラッシュする。P1 × 4件は次のリリースまでに対応が必要。P2/P3は計画的に改善すべき技術的負債。

---

## 🕵️‍♂️ 第2次審査: 新たなる深層ピットフォール (The Abyss)

修正された13項目の実装は完璧だ。P0-AのMutex保護、P0-Bのイテレータ削除、P1-AのTimeout、P1-Dのロック分割など、どの修正も副作用（新たなバグ）を生まずにクリーンに実装されていることをソースコードレベルで確認した。

**しかし、コードベースの全結合面をさらに深く掘り下げた結果、これまでの監査をすり抜けていた「第2層のP0/P1ピットフォール」が3つ新たに見つかった。**
既存の修正が完璧だったからこそ浮き彫りになった、並行処理とAPI制限に関するより深い落とし穴だ。これらは非常に危険だ。

### 🔴 新P0-C: RefineSemanticEdges でのHNSWグラフへの排他制御なし（Data Race & Panic） **[✅ 修正済み]**

**ファイル:** `go/internal/vector/consolidation.go` L278周辺
**問題:** `RefineSemanticEdges` 内で、`pq := vstore.graph.Search(...)` が呼び出されているが、ここでは `s.mutex.RLock()` が一切取得されていない。
**影響:** コンソリデーションの後半フェーズ実行中に、並行して `handleIngest` や `handleBatchIngest` が走り `vstore.Add()`（`s.mutex.Lock`を使用）が呼ばれると、**HNSWグラフの内部Arrayに対して同時にRead/Write**が発生し、Goランタイムがインデックス範囲外アクセス（Index out of bounds）でパニックしクラッシュする。
**修正案:** `vstore.Recall` 同様、`Search` 実行時のみ `vstore.mutex.RLock()` / `RUnlock()` で保護するアクセスラッパー（例: `vstore.SearchGraph()`）を実装し、それを利用する。

### 🟠 新P1-E: atchIngest にレートリミッターなし（無限リトライ＆沈黙のデータロス） **[✅ 修正済み]**

**ファイル:** `go/main.go` L515-577 (`handleBatchIngest`)
**問題:** `RunConsolidation` には `rate.Limiter` があるが、`handleBatchIngest` には存在せず、単純なセマフォ（最大5並行）でAPIを叩いている。Google AI Studioの無料枠（15 RPM / 100 RPM）を即座に超過する。
さらなる問題は、`slug, _ = provider.GenerateText(...)` とエラーを `_` で握りつぶし、空文字のまま3回無駄に再試行している点。さらにエグいのは、`EmbedContent` が 429 エラーを返した場合、`if err == nil && vstore != nil` のブロックがスキップされるため、**「.md ファイルは生成されたのに Vector DB には存在しない」完全な幽霊ファイル（永久に検索されない記憶）が大量生産される**点だ。
**修正案:** `batchIngest` にも `rate.Limiter` を導入し、`GenerateText` や `EmbedContent` のエラーを正しくハンドルする。失敗時はMarkdownファイルの書き出し自体をスキップする。

### 🟠 新P1-F: UpdateRecord の排他ロック内でのファイルI/O（全体デッドロック的ブロッキング） **[✅ 修正済み]**

**ファイル:** `go/internal/vector/store.go` L268 (`UpdateRecord`) & `go/internal/vector/consolidation.go` L222
**問題:** P1-Dで `Recall` 内のファイルI/Oはロック外に出して修正したが、一方で `UpdateRecord` は `s.mutex.Lock()` で**グローバルな書き込みロックを取得したまま**コールバックを実行する。そして `RunConsolidation` はこのコールバック内で `frontmatter.Parse` と `Serialize` という最悪のディスクI/Oを行っている。
**影響:** コンソリデーションによる子ノード(D0)のアーカイブ化処理中、Vector Store全体がブロックされ、その間一切の `Recall` (検索) や `Ingest` が停止（ハング）する。数百件のアーカイブ時は数十秒間のフリーズを引き起こす。
**修正案:** ファイルのI/O（Parse, Serialize）は `UpdateRecord` の呼び出し前と呼び出し後に移動する。`UpdateRecord` 内（ロック内）では、メモリ上の `EpisodeRecord.Tags` と `Edges` の追加のみを行う。

---
これら3つの落とし穴は、システムの安定稼働においてアキレス腱となる。
