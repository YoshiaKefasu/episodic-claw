---
title: Episodic-Claw Markdown Format Improvement Report
date: 2026-04-06
---

## 🔧 Pro Engineer Review — 2026-04-06
> Perspective: Google / IBM Production Engineering
> Principles applied: YAGNI · KISS · DRY · SOLID
> Source code verified: ✅ (as of 2026-04-06)

### 📍 Current Reality (Source Code vs. Document)
- ✅ **Markdown-First Architecture**: `episodic-claw` は現在、MarkdownをSource of Truthとして扱い、そこからPebbleDB（ベクトルインデックス）を再構築する設計（`go/indexer/indexer.go`, `go/internal/vector/background.go`）になっています。
- ⚠️ **Format Discrepancy (Bloat)**: 実際の生成ファイル（例: `eju-training-fate.md`）を確認すると、本文内に Telegram の生の JSON メタデータ（`Conversation info`, `Sender`, `Replied message`）がそのままコードブロックとして挿入されています。これは「人間とLLMにとっての可読性（Readability）」を著しく下げ、コンテキストトークンを無駄に消費しています（ファイルあたり約3000トークンに達している主因）。
- ⚠️ **DRY Violation**: Frontmatterの `id` と `title` が重複しています。

### 🎯 Core Problem (1 sentence)
> Markdown本文に生のJSONメタデータが混入しているため、LLMのコンテキスト枠を無駄に消費し、人間にとっての可読性と検索性（Grep）が著しく低下している。

### 🔍 Principle Filter
| Check | Result | Note |
|-------|--------|------|
| **YAGNI** — Is this actually needed now? | ❌ No | 検索やインデックスに不要なTelegramの内部IDや詳細JSONを毎回本文に書く必要はない。 |
| **KISS** — Is there a simpler solution? | ⚠️ Simpler exists | JSONコードブロックをやめ、人間が読める簡潔なプレーンテキストのヘッダー（または引用）に変換するべき。 |
| **DRY** — Any duplication to eliminate? | ⚠️ Found | Frontmatter の `id` と `title` の重複。本文中の `Sender (untrusted metadata)` 等の冗長なボイラープレート。 |
| **SOLID** — Any violation causing real problems? | ⚠️ Found | 関心の分離（SRP）違反。本文（会話の文脈）とメタデータ（ルーティング情報）が混ざっている。 |

---

### 🛤️ Solution Options

#### Option A — 構造化Markdown + メタデータのFrontmatter退避 *(推奨)*
**Approach**: 生のJSONを完全に排除し、ルーティング情報（Message ID等）はYAML Frontmatterに移動。発言者と引用は標準的なMarkdown記法（引用ブロック `>` や太字）でシンプルに表現する。
**Implementation cost**: Low (Go側のテキスト生成テンプレートを修正するだけ)
**Risk**: Low (インデクサーはテキスト本文のみを見るため、ベクトル検索の精度はむしろ向上する)
**Why recommended**: コンテキストトークンを劇的に削減でき、`ep-recall` 実行時のLLMの負荷とノイズを減らせる。また、KISSの原則に最も従う。
**Concrete steps**:
1. `go/main.go` または生成テンプレートにおいて、JSONブロックの出力を停止する。
2. 会話ログの表現を以下のように簡略化する：
   ```markdown
   > **ヨシア (2026-04-03 18:19)**:
   > お疲れさん！やっと本腰入れて特訓に戻れるな。...
   ```
3. 必須のメタデータ（元のチャットIDなど）は YAML Frontmatter の `metadata` フィールド等に押し込む。

#### Option B — メタデータSidecarファイル分離方式
**Approach**: `.md` ファイルは純粋な会話テキストのみとし、Telegramのメタデータは同じ階層に `.json` のSidecarファイルとして保存する。
**Implementation cost**: Medium (I/Oの修正が必要)
**Risk**: Medium (ファイル管理が二重になり、ユーザーがエディタで直接削除した時の同期が複雑化する)
**When to choose this instead**: 将来的にシステムがJSONメタデータを厳密に再利用・検証する必要が生じた場合。
**Concrete steps**:
1. Markdown生成時に、メタデータだけを切り出して `eju-training-fate.meta.json` に書き出す。

---

### ✅ Pro Recommendation
> **Choose Option A because**: "Markdown-First" という現在のアーキテクチャの強みを最大化しつつ、トークン消費とノイズを劇的に削減できるため。Option Bはシステムを不必要に複雑にする（YAGNI違反）。
> Estimated implementation: 2-3 hours (Goテンプレートの修正とテスト)
> Rollback plan: 既存のMarkdownファイルはそのままでよく、新しいエピソードから新フォーマットを適用するだけで後方互換性は保たれる。

### ⚡ Quick Wins (implement regardless of option chosen)
- [ ] YAML Frontmatter の `id` と `title` が完全に同一の場合、`title` をもっと要約された意味のある文字列（LLMに生成させる等）にするか、不要なら削る。
- [ ] `assistant: <final>` などのシステムタグを、人間が読みやすい `**Assistant**: ` などの標準Markdownに置換する。

---

### 🏥 Legacy Format Healing Strategy (Backward Compatibility)
既存の古いフォーマット（JSONブロック混入型）のファイルをどう扱うかについて、現在のシステムが持つ `runAutoRebuild` および `RunAsyncHealingWorker` の強力なフェイルセーフ機構を活かしたアプローチを推奨する。

**推奨アプローチ: Lazy Migration on Rebuild / Healing**
- **仕組み**: `go/indexer/indexer.go` または `HealingWorker` が既存の `.md` ファイルをロードしてパースした際、本文内に ````json\n{\n  "message_id":` のようなレガシーパターンを検知した場合、オンザフライでテキストを新フォーマット（Option A）に変換する。
- **処理**: 抽出したメタデータをYAML Frontmatterにマージし、クリーンアップされた本文と共にファイルを上書き保存（`frontmatter.Serialize` 相当）する。
- **利点 (YAGNI/KISS)**: 特別な一括マイグレーションスクリプトを単独で実装する必要がなく、システムの通常の Rebuild/Healing サイクルの中で自然に（かつ安全に）浄化が行われる。ユーザーが古いファイルを直接触った場合も、次のWatcher/Healingサイクルで自動的にクリーンアップされる。

**代替アプローチ: Explicit CLI Migration**
- もしバックグラウンドで勝手にファイルが書き換わるのを嫌う場合、CLIに `ep-claw migrate-format` のような明示的なコマンドを追加し、ユーザーのオプトインで一括変換を走らせる。ただし、パースと変換のコアロジックは上記のLazy Migrationと全く同じものを使い回す（DRY）。
