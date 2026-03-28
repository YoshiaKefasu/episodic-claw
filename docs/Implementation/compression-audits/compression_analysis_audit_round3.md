# compression_analysis_report.md — 監査レポート Round 3

---

## Audit Report — Round 3
> Reviewed from the perspective of an IBM / Google Pro Engineer
> Date: 2026-03-25
> Mode: Post-Implementation (Round 2 全修正後の検証)
> Prior audits: 2 | New findings this round: 5

### Convergence Status
| Prior Round Issues | Status |
|-------------------|--------|
| H-1: EpisodeRecord.Surprise omitempty 残存 | Resolved |
| H-2: EpisodeMetadata.Surprise omitempty 残存 | Resolved |
| H-3: auditEpisodeQuality シグネチャ乖離 | Resolved |
| M-1: Mermaid セマフォ文字化け | Resolved |
| M-2: go/indexer/ 欠落 | Resolved |
| M-3: Section 21 件数誤り | Resolved |
| M-4: ai.getMeta 説明欠如 | Resolved |
| L-1: Unix Socket Server ノード名 | Resolved |
| L-2: errors import 幽霊バグ | Resolved |
| L-3: Mermaid 余分な全角文字 | Resolved |
| L-4: Phase 0 ツリー注記欠如 | Resolved |

---

## 監査結果サマリー

| 重大度 | 件数 | 状態 |
|--------|------|------|
| MED | 3 | 要修正 |
| LOW | 2 | 対応方針のみ記録 |
| **合計** | **5** | |

---

## Impact on Related Features *(new only)*

### [M-1] Section 4.6「手動編集 → Watcher が自動反映」と Section 4.3 WARNING の矛盾

- **箇所:** Section 4.6 L719、Section 4.3 L346〜349
- **問題:** Section 4.6 のテーブルには「手動編集 | ユーザーが直接 `.md` を修正 → Watcher が自動反映」と記載されている。しかし同じドキュメントの Section 4.3 の `[!WARNING]` には「Watcher はファイル変更イベントをTS側へ通知するが、**自動インデックス更新は行わない**」「Rebuild は `indexer.rebuild` RPC で明示的に呼び出す」と明記されている。
  - 実際の動作: 手動で `.md` を編集しても HNSW / Pebble のインデックスは更新されない。Recall でその変更が反映されるには明示的な `indexer.rebuild` が必要。
  - 影響: ユーザーが Section 4.6 の記述を信じて手動編集後に `ep-recall` を使った場合、古い内容が返却される（または手動編集が検索にヒットしない）。Markdown-First の主要訴求ポイントである「手動編集→即時反映」が実際には機能しないという誤解を招く。
- **推奨対応:** Section 4.6 の該当行を「手動編集 | ユーザーが直接 `.md` を修正 → `indexer.rebuild` で DB を更新（Watcher はTS通知のみ）」に修正。または Section 4.3 WARNING に「Section 4.6 の Watcher 自動反映記述は不正確」という相互参照注記を追加する。

---

## Potential Problems & Risks *(new only)*

### [M-2] `compact()` の `tokensAfter` 計算に CJK 非対応の `length/4` が残存

- **箇所:** Section 4.5 L706
- **問題:** `compact()` の返却値で `tokensAfter: Math.ceil(JSON.stringify(session.messages).length / 4)` を使用している。これは Section 14.2 で「`length/4` の過小評価を解消」と明記して `estimateTokens()` を導入した対応の適用漏れである。`JSON.stringify(...).length / 4` は ASCII 前提の計算であり、日本語等の CJK 文字は UTF-16 で 1〜2 文字コードポイントのため実際のトークン数（≈1.5トークン/文字）を最大6倍過小評価する。
  - 影響: `compact()` のレスポンスを利用するログ・フック・Dashboard において、CJK 会話後の「圧縮後トークン数」が大幅に低く表示される。診断メタデータとして使われる値が信頼できなくなる。
  - `estimateTokens()` は `src/utils.ts` にすでに存在し、同じ `compact()` 実装の中でも `assemble()` (L647) では正しく使用されている。
- **推奨対応:** Section 4.5 L706 を `tokensAfter: estimateTokens(JSON.stringify(session.messages))` に修正し、実装および `assemble()` との一貫性を確保する。

### [M-3] `compact()` コード例に `isCompacting` 排他制御ガードが欠如

- **箇所:** Section 4.5 L653〜L710 のコードブロック
- **問題:** Section 12.1 では「`isCompacting` フラグ + `try/finally` パターンにより、TOCTOU競合によるセッションファイル破壊を構造的に防止」と明記されているが、Section 4.5 の `compact()` コード例にはこの排他制御が一切含まれていない。
  - 影響: 新規参加者がこのコードブロックをリファレンス実装として参照した場合、`isCompacting` ガードを実装しない `compact()` を作成する可能性がある。OpenClaw ランタイムが高頻度トークン超過を検知するシナリオでは `compact()` が同時多重発火し、セッションファイルが破損する（partial write が重なって JSON が壊れる）。
  - コード例と Section 12.1 の記述が矛盾しており、どちらが「真の仕様」かが不明瞭。
- **推奨対応:** Section 4.5 のコード例に `isCompacting` フラグチェック + `try/finally` によるリセットを追加する。または冒頭に「このコード例は排他制御ガードを省略した骨格です。実際の実装は Section 12.1 参照」という [!NOTE] を追加する。

---

## Missing Steps & Considerations *(new only)*

*（MED/LOWとして下記の推奨アクションテーブルにまとめる）*

---

## Unaddressed Edge Cases *(new only)*

### [L-1] `buildDateSeq(unprocessed.length)` の引数と `dateSeq` 仕様の不整合

- **箇所:** Section 4.5 L675 と L696
- **問題:** `dateSeq` は文書全体を通じて「日次カウンタ（0時リセット）」「YYYYMMDD-N」と説明されているが、コード例内での生成方法が2箇所で食い違っている。
  - Step 3 (L675): `dateSeq: buildDateSeq(unprocessed.length)` — 引数が「今回のバッチ件数」
  - Step 6 (L696): `` dateSeq: `${today}-${session.messages.length - 1}` `` — 引数が「新配列の末尾インデックス」
  - `buildDateSeq` 関数の定義もシグネチャも文書中に一切記述がなく、引数の意味が不明。`dateSeq` が「日次通し番号（ゼロリセット）」を意味するなら、「今回のバッチ件数」でも「メッセージ末尾インデックス」でもなく、その日の現在の通し番号（PebbleDB から取得した最新カウンタ）が正しいはず。
  - Step 3 と Step 6 の `dateSeq` 意味論が統一されておらず、将来的に `dateSeq` を人間可読トレーシングに使おうとした際に混乱を招く。
- **推奨対応:** `buildDateSeq` の関数定義と引数の意味を文書に追記する。Step 3 と Step 6 で `dateSeq` の値が異なる意図（Step 3 = 処理前の最終インジェスト通し番号、Step 6 = compact 後の新配列末尾）を明示的にコメントで説明する。

### [L-2] `compact()` の `fs.writeFile` にアトミック書き込み保護が未言及

- **箇所:** Section 4.5 L689、Section 15.2 (4番目の防御層)
- **問題:** Section 15.2.4「原子的書き込みと TOCTOU 防止」では「全ての `frontmatter.Serialize` を `.tmp` → `os.Rename` するアトミック置換パターン」と謳っているが、これは Go 側 Episode `.md` ファイル書き込みの話である。TS 側の `compact()` における `await fs.writeFile(ctx.sessionFile, JSON.stringify(session), "utf-8")` はアトミックではない Node.js の直接書き込みであり、`compact()` 実行中にプロセスが強制終了（OOM Kill 等）した場合、セッションファイルが切り詰め（truncation）または部分書き込みで壊れる可能性がある。
  - セッションファイルが壊れると OpenClaw 全体がクラッシュするため影響は甚大。
  - Section 15.2 の「5つの防御層」が TS 側 `compact()` には適用されていない可能性をドキュメントが示唆していない点が誤解を招く。
- **推奨対応:** Section 4.5 の `compact()` コード例に「セッションファイルは `.tmp` への一時書き込み + `fs.rename` によるアトミック置換を行う」旨のコメントを追加する。または Section 15.2.4 に「なお TS 側の `compact()` での `sessionFile` 書き込みにも同様のアトミックパターンが必要」という注記を追加する。

---

## Recommended Actions
| Priority | Action | Reason | Is New? |
|----------|--------|--------|---------|
| MED | Section 4.6 の「手動編集 → Watcher が自動反映」を Section 4.3 WARNING と整合するよう修正 | Watcher は自動インデックス更新を行わない（要 `indexer.rebuild`）と既に明記されており、Section 4.6 が虚偽情報を提供している | Yes |
| MED | Section 4.5 L706 の `tokensAfter` 計算を `estimateTokens()` に置き換える | `length/4` は CJK 非対応。`estimateTokens()` が同ファイル内で使用可能。`assemble()` との一貫性欠如 | Yes |
| MED | Section 4.5 の `compact()` コード例に `isCompacting` ガードを追加、または省略注記を明示 | Section 12.1 と矛盾。新規開発者が排他制御なしの実装を再現するリスク | Yes |
| LOW | Section 4.5 に `buildDateSeq` の定義とシグネチャを追記し、Step 3 / Step 6 の `dateSeq` 意味論を統一 | 現状では `buildDateSeq` の引数の意味が不明で、Step 3 と Step 6 の値の意図が乖離している | Yes |
| LOW | Section 4.5 または Section 15.2.4 に TS 側 `compact()` のセッションファイル書き込みアトミック化の注記を追加 | Go 側の Atomic Write 保護が TS 側に未適用であることが未言及。compact 中クラッシュでセッション破損リスク | Yes |

---

## 実行チェックリスト

```
[x] M-1: Section 4.6 — 「Watcher が自動反映」→「Watcher はTS通知のみ、indexer.rebuild で DB を更新」に修正 (2026-03-25)
[x] M-2: Section 4.5 L706 — tokensAfter を estimateTokens() 使用に修正 (2026-03-25)
[x] M-3: Section 4.5 compact() コード例 — [!NOTE] でisCompacting ガード省略の旨と Section 12.1 参照を追記 (2026-03-25)
[ ] L-1: Section 4.5 — buildDateSeq の定義・シグネチャを追記、Step 3 / Step 6 dateSeq 意味論を統一コメント（低優先）
[ ] L-2: Section 4.5 または Section 15.2.4 — compact() sessionFile アトミック書き込み注記を追加（低優先）
```
