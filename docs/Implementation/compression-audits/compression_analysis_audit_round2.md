# compression_analysis_report.md — 監査レポート Round 2

- **監査日**: 2026-03-25
- **監査観点**: IBM / Google Pro Engineer 視点による全体再検証
- **対象**: Antigravity 修正（4 Issue 解決）反映後のマスタードキュメント
- **前回監査**: [Round 1](./compression_analysis_audit_round1.md) — FIX-R1〜R4 検証済み
- **新規発見**: **HIGH×3, MED×4, LOW×4**

---

## 監査結果サマリー

| 重大度 | 件数 | 状態 |
|--------|------|------|
| HIGH | 3 | 要修正 |
| MED | 4 | 要修正 |
| LOW | 4 | 対応方針のみ記録 |
| **合計** | **11** | |

---

## HIGH

### [H-1] `EpisodeRecord.Surprise` の JSON/msgpack タグ不整合（omitempty 残存）

- **箇所:** Section 4.3 L336、Section 17.2 FIX-B コードブロック L1570
- **問題:** 両コードブロックで `Surprise float64 \`json:"surprise,omitempty" msgpack:"surprise,omitempty"\`` と記述されているが、実際の `go/internal/vector/store.go` は Antigravity 修正により `json:"surprise" msgpack:"surprise"` に変更済み（`omitempty` 除去）。Section 20 で「解決済み」と明記されているにもかかわらず、ドキュメント内コードブロックが旧仕様のまま。新規参加者が誤った定義をコピーする危険がある。
- **推奨対応:** 2箇所の `omitempty` を削除し、末尾コメントを `// (omitempty除去 — Self-Healing DB Phase A-D)` とする。
- **状態**: ✅ Done

### [H-2] `EpisodeMetadata.Surprise` の YAML タグ不整合（omitempty 残存）

- **箇所:** Section 4.3 L311
- **問題:** `Surprise float64 \`yaml:"surprise,omitempty"\`` と記述されているが、実際の `go/frontmatter/frontmatter.go` は `yaml:"surprise"` に変更済み。H-1 と同じ根本原因（ドキュメントのコードブロックがコードの変更に追随していない）。
- **推奨対応:** `yaml:"surprise,omitempty"` → `yaml:"surprise"` に修正。
- **状態**: ✅ Done

### [H-3] `auditEpisodeQuality` のシグネチャ乖離

- **箇所:** Section 7.3 L1321〜L1327
- **問題:** コードブロックに `func auditEpisodeQuality(slug, summary string) (string, error)` と記述されているが、実際の `go/main.go` は `func auditEpisodeQuality(slug string) error`（引数1つ、エラーのみ返す）。また現在のフローは「MD5スラッグを最初から採用し HealingWorker が非同期リネーム」であり、「3回リトライ + MD5フォールバック」という旧設計説明と実態が乖離している。
- **推奨対応:** シグネチャを実装に合わせ、説明文もフロー変更を反映して更新。
- **状態**: ✅ Done

---

## MED

### [M-1] Mermaid 図のラベル文字化け（セマフォ上隐5=10）

- **箇所:** Section 4.3 L355
- **問題:** `(セマフォ上隐5=10)` は「上限=10」の文字化け。`go/main.go` の実装（`make(chan struct{}, 10)`）とは整合しているが、レンダリング時に壊れたテキストとして表示される。
- **推奨対応:** `(セマフォ上隐5=10)` → `(セマフォ上限=10)` に修正。
- **状態**: ✅ Done

### [M-2] Section 6.5 ファイルツリーに `go/indexer/` が欠落

- **箇所:** Section 6.5 ファイルツリー
- **問題:** `go/indexer/indexer.go` が実プロジェクトに存在するが、ファイルツリーに記載がない。`IndexCache`・`BuildIndex`・`SaveCache` 等が実装されているにもかかわらず不可視状態。
- **推奨対応:** `go/` 配下に `indexer/` ディレクトリを追加。
- **状態**: ✅ Done

### [M-3] Section 21 の Round 1 件数が誤り（4件 → 6件）

- **箇所:** Section 21 L1707
- **問題:** `4件（HIGH×2, MED×2, LOW×2）` と記載されているが HIGH×2+MED×2+LOW×2=6件。
- **推奨対応:** `4件` → `6件` に修正。
- **状態**: ✅ Done

### [M-4] `ai.getMeta` 未実装の説明が欠如

- **箇所:** Section 19 RPC 一覧末尾
- **問題:** `ai.setMeta` は存在するが対応する `ai.getMeta` が未実装・未説明。読者が非対称性を見て疑問を持つ可能性がある。
- **推奨対応:** Section 19 末尾に「`ai.getMeta` は意図的に未実装（`last_activity` 等は Go タイマーループ内部でのみ参照）」を注記追加。
- **状態**: ✅ Done

---

## LOW（対応方針のみ記録）

| ID | 問題 | 箇所 | 対応方針 |
|----|------|------|---------|
| L-1 | Mermaid図のノード名 `SRV["Unix Socket Server"]` がWindows環境で誤解を招く | Section 6.2 | `SRV["TCP/Unix Socket Server"]` に変更 |
| L-2 | Section 20 P2「`errors` import 未使用警告」が実際には問題なし（import は存在しない） | Section 20 L1684 | 「(確認済み・問題なし)」に更新 |
| L-3 | Section 4.4b Mermaid図のノードラベルに孤立した全角「`「`」が2箇所残存 | Section 4.4b L501, L507 | 余分な文字を削除 |
| L-4 | Section 5 Phase 0 ツリーに「これは当初設計」である旨の注記が欠如 | Section 5 Phase 0 ツリー | `> [!NOTE]` を追加 |

---

## 問題なし（確認済み）

- **Section 20 各解決済み項目**: Antigravity 修正（Surprise omitempty, genesis-archive, RunConsolidation, globalWatcher）は全てコードレベルで正確に実装されており、解決済み記述は正確
- **Section 19 RPCメソッド一覧**: `handleConnection` switch文と完全に一致
- **Section 17.2 FIX-A**: `handleIngest` params の `Depth` フィールドは実装と一致
- **Section 14.2 CJK estimateTokens**: Go 側 `rune数/3` の説明は `frontmatter.go` 実装と一致
- **Section 4.3 EpisodeRecord（Surprise以外）**: Depth/Tokens/Edges/SourcePath 等のタグは全て実装と一致
- **Section 6.5 utils.go**: `go/internal/vector/utils.go` が存在し `CosineDistance` が正しく実装されていることを確認

---

## 実行チェックリスト

```
[x] H-1: Section 4.3 + Section 17.2 FIX-B — EpisodeRecord.Surprise から omitempty 削除 (2026-03-25)
[x] H-2: Section 4.3 — EpisodeMetadata.Surprise から omitempty 削除 (2026-03-25)
[x] H-3: Section 7.3 — auditEpisodeQuality シグネチャを実装に合わせ更新 (2026-03-25)
[x] M-1: Section 4.3 Mermaid — セマフォ上隐5=10 → セマフォ上限=10 (2026-03-25)
[x] M-2: Section 6.5 — go/indexer/ を追加 (2026-03-25)
[x] M-3: Section 21 — Round 1 件数を 4件 → 6件 に修正、Round 2 エントリを追加 (2026-03-25)
[x] M-4: Section 19 末尾 — ai.getMeta 未実装の NOTE 注記を追加 (2026-03-25)
[x] L-1: Section 6.2 Mermaid ノード名 → TCP/Unix Socket Server (2026-03-25)
[x] L-2: Section 20 P2 errors import 記述 → 「(確認済み・問題なし)」に更新 (2026-03-25)
[x] L-3: Section 4.4b Mermaid の余分な全角「「」を2箇所削除 (2026-03-25)
[x] L-4: Section 5 Phase 0 ツリーへの [!NOTE] 追加 (2026-03-25)
```
