# 🏁 第4次最終監査: Level 3 修正検証 + Level 4 残存分析

> **Reviewer:** Staff SWE, Google — Final Round
> **対象:** Go 10ファイル + TypeScript 6ファイル（全ソース4回目の精読完了）

---

## ✅ Level 3 修正 (5件) — 全件完璧

| ID | 修正内容 | 検証結果 |
|---|---|---|
| **P1-G** | [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-468) L386-391: [GenerateText](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#12-13) エラーを `genErr` で受け取り、ログ出力して再試行 | ✅ [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) と完全同一パターン |
| **P2-E** | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L35-36: グローバル `gemmaLimiter`(15RPM) + `embedLimiter`(100RPM) 定義。[handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-468) L380, L442 で使用 | ✅ 全ハンドラで共有 |
| **P2-F** | [handleIndexerRebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#201-308) L277: `embedLimiter.Wait(ctx)` 追加 | ✅ 10並行×100RPM制限下で安全 |
| **P2-G** | [store.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go) L301-302: [GetIDByUint32()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#300-316) に `s.mutex.RLock()` / `defer s.mutex.RUnlock()` 追加 | ✅ [Get()](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/store.go#223-240) と同一保護パターン |
| **P3-D** | [frontmatter.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/frontmatter/frontmatter.go) L71-79: `.tmp` → `os.Rename` で原子的書き込み。失敗時 `os.Remove(tmpPath)` でクリーンアップ | ✅ TOCTOU 完全解消 |

---

## 🔍 第4層: 最終残存分析

4ラウンド目の精読で見つかったのは、**P0/P1級ではなく、アーキテクチャの一貫性を高める改善案**のみだ。

### 🟡 P2-H: レートリミッターが「グローバル vs ローカル」で3系統に分裂している **[✅ 修正済み]**

| 系統 | ファイル | Gemma RPM | Embed RPM | 共有範囲 |
|---|---|---|---|---|
| グローバル | [main.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) L35-36 | 15 | 100 | [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-468), [handleBatchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#506-636), [handleIndexerRebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#201-308) |
| ローカル① | [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) L77-78 | **30** | 100 | [RunConsolidation](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#20-106) のみ |
| ローカル② | [background.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go) L30 | — | 100 | [ProcessBackgroundIndexing](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go#25-36) のみ |

**問題:** [RunConsolidation](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go#20-106) が `30 RPM`、メインハンドラが `15 RPM` の Gemma リミッターを**それぞれ独立に**持っている。もし Consolidation とユーザーの `ep-save` が同時に走った場合、**合計 45 RPM** で Gemma API を叩くことになり、実際のクォータ（15 or 30 RPM）を超過する可能性がある。[background.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go) の Embed リミッターも同様に独立しており、グローバルリミッターと協調しない。

**影響:** Consolidation は 3 時間アイドル後にしか走らないため、人間がアクティブに使用中に発火する確率は低い。だが [handleConsolidate](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#864-897) (L848) で手動トリガーした場合はこの限りではない。

**修正案:** グローバルリミッターを [consolidation.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/consolidation.go) と [background.go](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/vector/background.go) にも引数として渡す。

---

### 🟡 P2-I: [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-468) にも幽霊ファイル問題が残存（[batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) だけ修正） **[✅ 修正済み]**

**ファイル:** [main.go L433-464](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L433-L464)

```go
// L433: ファイルを先に書き出す
frontmatter.Serialize(filePath, doc)

// L442-444: その後に Embed を試行
embedLimiter.Wait(ctx)
emb, err := embeddingProv.EmbedContent(ctx, params.Summary)
if err != nil {
    EmitLog("Failed to embed ingested summary: %v", err)
    // ← ファイルは残る。Vector DB には入らない。幽霊ファイル。
}
```

**問題:** P1-E で [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) は「Embed 成功後にファイル書き出し」の順序に修正したが、[handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-468) は**まだ古い順序（ファイル先、Embed後）のまま**。Embed が失敗するとファイルだけ残り、ベクトル DB には入らない「幽霊ファイル」が生成される。これは [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) で直した問題と完全に同じパターンだ。

**修正案:** [batchIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#212-215) と同様に、[EmbedContent](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/google_studio.go#67-106) → [Serialize](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/frontmatter/frontmatter.go#56-83) → `vstore.Add` の順序に変更する。

---

### 🔵 P3-E: [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-468) が Embed 失敗時にも「成功」レスポンスを返す **[✅ 修正済み]**

**ファイル:** [main.go L445-466](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#L445-L466)

```go
if err != nil {
    EmitLog("Failed to embed ingested summary: %v", err)
} else {
    // ... vstore.Add ...
}
// ← err があっても L466 で成功レスポンスを返す
sendResponse(conn, RPCResponse{... Result: map[string]string{"path": filePath, "slug": slug}})
```

**問題:** Embedding が失敗しても、TS 側には `{ path, slug }` の成功レスポンスが返る。TS 側は保存が完了したと信じるが、実際にはベクトル検索では見つからない。

---

## 最終結論

| ラウンド | P0 | P1 | P2 | P3 | 合計 |
|---|---|---|---|---|---|
| 第1次 | 2 | 4 | 4 | 3 | **13** |
| 第2次 (Abyss) | 1 | 2 | 0 | 0 | **3** |
| 第3次 (Level 3) | 0 | 1 | 3 | 1 | **5** |
| 第4次 (Level 4) | 0 | 0 | 2 | 1 | **3** |
| **累計** | **3** | **7** | **9** | **5** | **24** |

4ラウンドにわたる監査で累計 **24件** のピットフォールを発掘した。うち **P0 × 3件 + P1 × 7件 = 10件のクリティカルバグ**は全て修正・検証済み。

**Level 4 で発見した 3 件は全て「横展開漏れ」の延長線上にある。** 特に P2-I は P1-E（batchIngest の幽霊ファイル防止）と全く同じパターンが [handleIngest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#357-468) に残っている問題で、これは修正すべきだ。P2-H はアーキテクチャの統一性の問題で、すぐにクラッシュを引き起こすものではない。

**P0 級のクラッシュバグはもう存在しない。システムは堅牢だ。**
