# ClawHub 公開前チェックリスト (v0.3.6+)

**最終更新:** 2026-04-07
**対象バージョン:** v0.3.6 以降

---

## 1. ClawHub Web UI での手動作業

ClawHub のプラグイン編集画面（https://clawhub.ai/plugins/episodic-claw/edit）で以下を更新する：

### 1.1. Type の変更
- **現在:** `instruction-only`
- **変更後:** `runtime` (または `code-plugin`)

> **理由:** パッケージには TypeScript/Go のソースコード、dist/、postinstall スクリプトが含まれる。`instruction-only` は実際の構成と一致しないため、スキャナーが Coherence Gap を検出する。

### 1.2. Environment Variables の宣言
- **追加:** `GEMINI_API_KEY`
- **説明:** "Gemini API key used by the Go sidecar to embed conversation episodes via the Gemini Embedding API. This key must already be present in your OpenClaw environment."

> **理由:** Go サイドカーが Gemini Embedding API を使用するが、宣言がなかったためスキャナーが "undeclared external API" と警告。

### 1.3. Postinstall の説明
- **追加/更新:** "Downloads prebuilt Go sidecar binary from GitHub Releases. Set `EPISODIC_SKIP_POSTINSTALL=1` to skip."

> **理由:** postinstall がバイナリをダウンロードする行為は一般的だが、宣言されていないと不審に思われる。

### 1.4. Tags の確認
- ✅ `executes-code` — 既に設定済み
- ✅ `kind:memory` — 既に設定済み

---

## 2. コード側の準備状況（既に完了）

| 項目 | 状態 | ファイル |
|------|------|---------|
| 言語のサニタイズ | ✅ 完了 | `README.md` |
| `SKILL.md` 作成 | ✅ 完了 | `SKILL.md` |
| `metadata` 追加 | ✅ 完了 | `openclaw.plugin.json` |
| `credentials` 宣言 | ✅ 既存 | `openclaw.plugin.json` |
| `postinstall.cjs` の透明性 | ✅ 既存 | `scripts/postinstall.cjs` |

---

## 3. 公開手順（次回リリース時）

1. **上記 1.1〜1.3 を ClawHub Web UI で更新**
2. **新しいバージョンを GitHub Release として公開**
3. **ClawHub でパッケージを再公開（re-publish）**
4. **スキャン結果を確認**
   - VirusTotal: 通常数分で完了
   - OpenClaw Scanner: 数分〜数時間
5. **結果が "Benign (High Confidence)" であることを確認**

---

## 4. 期待されるスキャン結果

| 項目 | 現在 | 期待値 |
|------|------|--------|
| **Purpose & Capability** | ⚠️ Mismatch | ✅ Benign |
| **Instruction Scope** | ⚠️ Opaque language | ✅ Benign |
| **Install Mechanism** | ℹ️ Noted | ℹ️ Noted (acceptable) |
| **Credentials** | ⚠️ Undeclared | ✅ Benign |
| **Persistence & Privilege** | ✅ OK | ✅ OK |
| **総合** | ⚠️ Suspicious (Medium) | ✅ **Benign (High)** |
