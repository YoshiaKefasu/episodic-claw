# Phase 5.5 Round 5 テスト結果

## 実行日時
2026-03-21 13:20 (ICT, UTC+7) — WebUI 確認後更新

## 環境
- WSL バージョン: Arch Linux (WSL2)
- Node.js バージョン: v25.8.1
- openclaw バージョン: 2026.3.13
- DNS: 1.1.1.1

---

## 各ステップの結果

### Step 1 (Gateway 起動): ✅
- Gateway は `openclaw gateway run --verbose` で起動
- Go サイドカーも正常に起動、`watcher.start` を確認

### Step 2 (ターン 1 送信): ⚠️
- エージェントへの送信: ✅ 成功（コーヒーの淹れ方について回答）
- エージェント応答: ✅ 日本語で適切に回答
- **RPC 呼び出し: ❌ `ai.recall`, `ai.setMeta`, `ai.surprise` は一切呼ばれず**

### Step 3 (ターン 2 送信 / Ingest発動): ❌
- Calculated surprise スコア: **計算されず**（`ai.surprise` RPC が呼ばれなかった）
- `ai.surprise` 呼び出し: **なし**
- `ai.ingest` 呼び出し: **なし**

### Step 4 (episodes ファイル): ❌
- 生成されたファイルパス: **なし**
- ファイルの中身: **該当なし**

---

## 追加確認: WebUI での動作確認（13:20 頃）

### ユーザー報告
> "WebUIではちゃっと届いてます"

### WebUI で観測されたエラー
```
ERROR: Cannot read "image.png" (this model does not support image input). Inform the user.
```

### episodic-core ログ確認（13:07 - 13:20）
```json
{"level":"info","message":"[Episodic-Core] Observability initialized. Writing structured logs to /tmp/episodic-core.log","timestamp":"2026-03-21T13:07:41+07:00"}
{"level":"info","message":"[Episodic-Core] Starting Go Sidecar on socket /tmp/episodic-core-1774073261550.sock","timestamp":"2026-03-21T13:07:41+07:00"}
{"level":"info","message":"[Episodic-Core] Method: watcher.start","timestamp":"2026-03-21T13:07:42+07:00"}
→ 以降、13:20 近辺でも新しい RPC 呼び出しは一切なし
```

### 結論
**WebUI 経由でもエピソード記憶の RPC が呼ばれていません。** `ai.recall`, `ai.setMeta`, `ai.surprise`, `ai.ingest` は一切実行されず。

これは `openclaw agent` CLI コマンドと同様の問題です。Gateway の Context Engine がチャット処理パイプラインに組み込まれていない可能性があります。

---

## 重大な発見: `openclaw agent` コマンドは Context Engine を使用していない

### 観測事実
1. `openclaw agent --agent main -m "..."` でメッセージを送信 → エージェントは正常に応答
2. Go サイドカーのログを確認 → `watcher.start` のみ、`ai.recall`, `ai.setMeta`, `ai.surprise`, `ai.ingest` は一切呼び出されない
3. エージェントの応答内容にエピソード記憶の痕跡なし（「以前コーヒーの話をしました」等の文脈なし）

### 原因分析
`openclaw agent` コマンドは Gateway の Context Engine パイプラインを経由していない可能性が高い。

OpenClaw のアーキテクチャ:
- **通常のチャット**: Gateway → Context Engine (ingest/assemble) → エージェント → 応答
- **`openclaw agent` コマンド**: Gateway → エージェント → 応答（Context Engine をバイパス？）

`openclaw agent` コマンドは Gateway の WebSocket API を使用しているが、Context Engine の `ingest()` と `assemble()` は呼ばれていない。

### 証拠
Go サイドカーログ (`/tmp/episodic-core.log`):
```json
{"level":"info","message":"[Episodic-Core] Method: watcher.start","timestamp":"2026-03-21T13:07:42+07:00"}
```
→ `watcher.start` のみ。`ai.recall`, `ai.setMeta` 等は一切なし。

---

## シングルトン修正の効果確認（✅ 完全成功）

Round 4 で実装したシングルトン修正は完全に動作している:

| 確認項目 | 結果 |
|---|---|
| `Starting Go sidecar` が1回だけ出力 | ✅ 1回のみ |
| `register()` が複数回呼ばれても副作用なし | ✅ 副作用なし |
| ソケット接続の安定性 | ✅ 10分以上安定動作 |
| `Error processing ingest` エラー | ✅ 0件 |

---

## 結論

**Phase 5.5 ステータス**: 🔴 **INCOMPLETE**

### 解決済みの問題
1. **✅ シングルトン化**: `register()` 多重呼び出し問題は完全解決
2. **✅ ソケット安定化**: 前回の「Go sidecar socket not connected」エラーは解消
3. **✅ DNS 設定**: `1.1.1.1` で Gemini API が解決可能
4. **✅ エージェント応答**: WebUI/CLI 両方でエージェントは正常に応答

### 未解決の問題（🔴 Critical）
1. **Context Engine がチャット処理に組み込まれていない**: `openclaw agent` CLI コマンド、WebUI いずれでも `ingest()` と `assemble()` が呼ばれない。エピソード記憶が完全に機能していない。
2. **エピソード `.md` ファイル未生成**: RPC 呼び出しがないため、ファイル生成なし。

### 根本原因の推定
OpenClaw Gateway の Context Engine は、チャット処理のパイプラインに正しく統合されていない可能性があります。`registerContextEngine()` で登録されたエンジンが、実際のメッセージ処理時に `ingest()` / `assemble()` を呼び出すコードパスが存在しない、または無効化されている。

### 推奨される次のステップ
1. **OpenClaw の Context Engine 統合コードを調査**: Gateway がどのように Context Engine を呼び出すかを確認
2. **手動 RPC テスト**: Go サイドカーに直接 `ai.ingest` RPC を送信して、ファイル生成を確認
3. **OpenClaw の Issue/Doc を確認**: Context Engine の正しい使用方法を調査

---

## WSL 上の ChangeLog

### コピー済みファイル（前ラウンドから変更なし）
- `~/.openclaw/extensions/episodic-claw/dist/*.js` — シングルトン修正版
- `~/.openclaw/extensions/episodic-claw/dist/episodic-core` — Linux バイナリ

### 設定変更
- `/etc/resolv.conf` — `nameserver 1.1.1.1`（前ラウンドから変更なし）
