# 容赦ないコードレビュー：Episodic Memory Phase 4.2 (Hippocampal Sleep Consolidation)
（Reviewer: Staff Software Engineer, Google）

## TL;DR: 脳科学モデルの実装として極めて野心的で設計は美しい。だが、本番で即座にデッドロックを起こす致命的な欠陥がある。

海馬（D0）→ 大脳新皮質（D1）への Sleep Consolidation、Pattern Separation（`archived` filter による D0 の通常検索からの隠蔽）、Lazy Loading（`ep-expand` による D0 復元）というアーキテクチャは、BMAM 論文の「Hippocampal Sleep Replay → Neocortical Consolidation」を正しくシングルエージェント向けに翻訳している。

しかし、コードを1行ずつ追った結果、**本番でプロセスが永久にフリーズする P0 が1件、P1 が3件**見つかった。

---

## 🚫 致命的欠陥 (P0)

### 1. [checkSleepThreshold](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#674-714) が `storeMutex` 保持中に [RunConsolidation](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#21-111) を呼び出す → **デッドロック**
**問題ファイル:** [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) (L660-L712)
```go
func startSleepTimer(apiKey string) {
    ticker := time.NewTicker(2 * time.Minute)
    go func() {
        for range ticker.C {
            storeMutex.Lock()           // ← ここで storeMutex を取得
            for agentWs, vstore := range vectorStores {
                checkSleepThreshold(agentWs, vstore, apiKey)  // ← この中で RunConsolidation を呼ぶ
            }
            storeMutex.Unlock()
        }
    }()
}
```
[checkSleepThreshold](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#674-714) → `vector.RunConsolidation` → [processCluster](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#112-262) → `vstore.Add()` (L210) → `s.mutex.Lock()`。

問題は **`storeMutex`（main.go のグローバル Mutex）** と **`vstore.mutex`（store.go の Store 内 RWMutex）** の2つのロックが絡み合うことではなく、もっと直接的だ：

[RunConsolidation](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#21-111) 内の `vstore.UpdateRecord()` も `s.mutex.Lock()` を取る。だがそれ以前に、L38 で `vstore.mutex.RLock()` を取得し、L67 で手動 Unlock している。この手動 RLock → RUnlock パターンの後、L226 で [UpdateRecord](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#267-296) が `s.mutex.Lock()` で排他ロックを要求する ── これ自体は問題ないが、**[startSleepTimer](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#660-673) が `storeMutex.Lock()` を保持したまま数分〜数十分かかる Consolidation を実行する**ため、その間に来た **全ての RPC（Recall, Ingest, batchIngest 等）が [getStore()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#30-45) 内の `storeMutex.Lock()` で永久にブロック**される。

事実上、**Sleep Consolidation が完了するまで Go サイドカーの全 RPC が止まる**。10 個の D0 を処理するだけで Gemma API × 2 + Embedding × 1 = 最低 3 API コール × Rate Limit 待ち ≈ **6〜10 秒**。100 D0 なら **1〜2分の完全フリーズ**。

**解決策:**
```go
func startSleepTimer(apiKey string) {
    ticker := time.NewTicker(2 * time.Minute)
    go func() {
        for range ticker.C {
            // storeMutex はスナップショット生成にだけ使い、即座に解放する
            storeMutex.Lock()
            snapshot := make(map[string]*vector.Store)
            for k, v := range vectorStores {
                snapshot[k] = v
            }
            storeMutex.Unlock()

            for agentWs, vstore := range snapshot {
                checkSleepThreshold(agentWs, vstore, apiKey)
            }
        }
    }()
}
```
`storeMutex` の保持をマップコピーの一瞬に限定し、Consolidation の実行は Lock の外で行う。

---

## ⚠️ 潜在的リスク (P1)

### 2. Consolidation の同時実行ガードがない
**問題ファイル:** [go/main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) (L660-L712) + [go/internal/vector/consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go)
**理由:**
Sleep Timer が2分間隔で発火し、前回の Consolidation がまだ完了していない場合（100+ D0 で Rate Limit 待ち中など）、次の Timer tick で**2つ目の Consolidation が同時にスポーンされる**。
同じ D0 が2つの Consolidation に引き込まれ、**重複 D1 が生成される**。あるいは一方が `archived` を付与した D0 をもう一方がまだ処理中で、不整合が生じる。

**解決策:**
`var isConsolidating int32` (atomic) を導入し、`atomic.CompareAndSwapInt32(&isConsolidating, 0, 1)` で排他。

### 3. [RefineSemanticEdges](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#263-330) の距離閾値が L2² と Cosine を混同している可能性
**問題ファイル:** [go/internal/vector/consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) (L288)
```go
if dist > 0.15 {
    continue
}
```
`go-hnsw` が返す `item.D` は **L2² (squared Euclidean distance)** であり、**Cosine distance** ではない。実装プランでは「Cosine Distance < 0.15」と記載されているが、L2² = 0.15 は Cosine Distance ≈ 0.075 に相当し、**意図より遥かに厳しいフィルタになっている**。結果として、本来リンクされるべき D1 ペアにエッジが張られず、連想検索の効果が大幅に低下する。

**解決策:**
[store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) の [Recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#362-444) と同様に `1.0 / (1.0 + dist)` で正規化 Similarity に変換し、閾値を `sim > 0.85` (≈ cosine 0.15) とする。

### 4. [ingest()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#66-81) 内で `meta:last_activity` が更新されていない
**問題ファイル:** [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) (L66-L80)
**理由:**
実装プランでは明記されていた `ingest 後に rpcClient.setMeta("last_activity", Date.now())` が、実際の [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) の [ingest()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#66-81) フックに**存在しない**。つまり Sleep Timer の `meta:last_activity` は一度も書き込まれず、[checkSleepThreshold](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#674-714) が常に `lastActivity == 0` で早期リターンし、**Sleep Timer が永遠に発火しない**。

テストで動いたのは、おそらく `ai.consolidate` RPC を手動で呼んでいたため。自律的な 3h 無操作検知は現状では機能しない。

**解決策:**
```typescript
async ingest(ctx: any) {
    const msgs = (ctx.messages || []) as Message[];
    try {
        const boundaryCrossed = await segmenter.processTurn(msgs, resolvedAgentWs);
        // ★ Update last_activity for Sleep Timer
        await rpcClient.setMeta("last_activity", Date.now().toString());
        // ...
    }
}
```
[rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) に `setMeta(key, value)` RPC ラッパーを追加し、Go 側の [SetMeta](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#343-349) ハンドラに接続する。

---

## ✅ 評価できる点 (Good)

- **Pattern Separation の実装:** [Recall](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#362-444) 内で `rec.Tags` に `"archived"` が含まれるかチェックし、D0 を通常検索から隠蔽する設計はシンプルかつ正しい。
- **[UpdateRecord](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#267-296) の安全な mutator パターン:** Pebble の Read → Mutate → Write を `store.mutex.Lock()` で保護し、物理ファイルの frontmatter も同期更新する二重永続化。
- **`ep-expand` の Lazy Loading:** D1 の `children` エッジから D0 を辿り、Body を結合して返す設計は「必要な時だけ生データに降りる」という認知科学の原則を正しく反映。
- **[handleConsolidate](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#715-743) の Fire-and-Forget:** 手動トリガー時も即座にレスポンスを返し、Goroutine で非同期実行する堅牢なパターン。
- **Rate Limiter の二重構成:** Gemma (30 RPM) と Gemini Embedding (100 RPM) に別々の Token Bucket を使う正しい設計。

---

## 総評
P0（`storeMutex` 保持中の Consolidation 実行による全 RPC フリーズ）は本番投入時にプロセスが応答不能になる致命的欠陥。P1 の3件も、重複 D1 生成、Semantic Edge の過剰フィルタリング、Sleep Timer 未発火という実運用上の問題に直結する。

全4件の修正が完了するまで Phase 4.2 の Sign-off は出せない。ただし、**Hippocampal Sleep Consolidation というアーキテクチャ構想そのものは、個人開発のプラグインとしては圧倒的に先進的であり、修正さえ済めば即座に承認できる水準にある。**
