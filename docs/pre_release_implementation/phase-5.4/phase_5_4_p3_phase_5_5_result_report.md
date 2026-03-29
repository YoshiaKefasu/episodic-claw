# Phase 5.4 P3 再検証 + Phase 5.5 実行結果報告

## 実行日時
2026-03-20 21:40 (ICT, UTC+7) — API キー修正后再実行済み

## 結果サマリー

### Part A: Phase 5.4 P3 再検証（バイナリ実行モード確認）

| Step | 内容 | 結果 | 備考 |
|------|------|------|------|
| A-1 | バイナリ・dist コピー | ✅ | ELF 64-bit LSB executable 確認 |
| A-2 | postinstall.js → chmod 755 | ✅ | `[episodic-claw] chmod 755: /root/.openclaw/extensions/episodic-claw/dist/episodic-core` |
| A-3 | Gateway 起動（binary モード確認） | ✅ | ログに `(binary)` が表示された |
| A-4 | ps aux（go run なし） | ✅ | `episodic-core` プロセスのみ（`go run .` なし） |

**P3 解決確認**: `go run .` プロセスなし、`(binary)` 起動ログ確認 → ✅

### Part B: Phase 5.5 Context Engine テスト

| Step | 内容 | 結果 | 備考 |
|------|------|------|------|
| B-0 | Go サイドカー RPC API 確認 | ✅ | watcher.start, ai.recall, ai.ingest, indexer.getWatermark 等を確認 |
| B-1 | テスト用マークダウンファイル準備 | ✅ | `/tmp/episodic-test-vault/` に 2 つのテストファイル作成 |
| B-2 | watcher.start / ingest テスト（スクリプト版） | ⚠️ **無効** | 本番フローではない（自動 ingest が発火していない） |
| B-3 | episodic-core ログ / PebbleDB 確認 | ⚠️ **保留** | スクリプトの不正起動による |
| B-4 | recall / assemble テスト（スクリプト版） | ⚠️ **無効** | 手動で null を確認したに等しく E2E の体を成していない |

**フェーズ達成**: TS ↔ Go 間の JSON-RPC 疎通は確認できたが、**Context Engine の機能（ingest/assemble/compact）の実働テストとしては不十分のため Phase 5.5 は未達（INCOMPLETE）** → 🔴


## Arch Linux WSL 上の ChangeLog

### コピー済みファイル
- `~/.openclaw/extensions/episodic-claw/dist/episodic-core` — Linux バイナリをコピー（2026-03-20）
- `~/.openclaw/extensions/episodic-claw/dist/*.js` — 最新 dist JS 一括コピー（2026-03-20）
- `~/.openclaw/extensions/episodic-claw/scripts/postinstall.js` — 新規作成（2026-03-20）
- `~/.openclaw/extensions/episodic-claw/src/rpc-client.ts` — Windows 側修正版をコピー（2026-03-20）

### パーミッション変更
- `dist/episodic-core` — chmod 755 適用（postinstall.js 経由）

### ディレクトリ作成
- `/root/episodes` — Watcher 起動用ディレクトリ
- `/tmp/episodic-test-vault` — テスト用マークダウンファイル格納ディレクトリ

### 設定変更
- `~/.openclaw/openclaw.json` — 変更なし（Phase 5.2 設定を継続使用）
- `~/.openclaw/.env` — Gemini API キーを追加（2026-03-20 21:37）
  ```
  GOOGLE_AI_STUDIO_KEY=[REDACTED_FOR_SECURITY]
  GEMINI_API_KEY=[REDACTED_FOR_SECURITY]
  ```
  **注**: Go サイドカーは `GEMINI_API_KEY` 環境変数を使用。`GOOGLE_AI_STUDIO_KEY` は OpenClaw Core 用。
  **🚨 警告**: 以前記載されていた生の API キーは至急失効させてください。（※補足：テスト用の無料APIで問題ない）

## 観測されたログ（抜粋）

### Gateway 起動ログ（Part A-3 — バイナリ実行確認）
```
[Episodic Memory] Starting Go sidecar... (gateway port: 18789)
[Plugin] Spawn Go sidecar (binary) at /root/.openclaw/extensions/episodic-claw/dist/episodic-core on /tmp/episodic-core-1774009441177.sock
[Episodic-Core] Observability initialized. Writing structured logs to /tmp/episodic-core.log
[Episodic-Core] Starting Go Sidecar on socket /tmp/episodic-core-1774009441177.sock
[Plugin] Connected to Go RPC socket
[Episodic-Core] Method: watcher.start
```

### ps aux 結果（Part A-4）
```
root  5776  openclaw-gateway
root  5800  episodic-core -socket /tmp/episodic-core-1774009441177.sock -ppid 5776
```
**確認**: `go run .` プロセスは表示されず、`episodic-core` バイナリが直接実行されている。

### RPC テスト結果（Part B-2: watcher.start）
```
[Test] Starting sidecar...
[Plugin] Spawn Go sidecar (binary) at /root/.openclaw/extensions/episodic-claw/dist/episodic-core on /tmp/episodic-core-1774010099132.sock
[Episodic-Core] Starting Go Sidecar on socket /tmp/episodic-core-1774010099132.sock
[Plugin] Connected to Go RPC socket
[Test] ✅ Sidecar connected
[Test] Starting watcher for: /tmp/episodic-test-vault
[Episodic-Core] Method: watcher.start
[Test] ✅ Watcher started
[Test] ✅ Sidecar stopped
```

### RPC テスト結果（Part B-4: recall / getWatermark — API キー修正後）
```
[Test] ✅ Connected
[Test] Testing recall...
[Episodic-Core] Method: ai.recall
[Test] recall results: null
[Test] Testing getWatermark...
[Episodic-Core] Method: indexer.getWatermark
[Test] watermark: { "dateSeq": "", "absIndex": 0 }
[Test] ✅ Done
```
**注**: `recall results: null` は正常動作。エピソードが未登録のため結果が `null` になる。API キー認証エラーは解消済み。

### episodes/ ディレクトリ（既存テストデータ）
```
/root/.openclaw/extensions/episodic-claw/episodes_test_phase4_5/vector.db/MANIFEST-000001
/root/.openclaw/extensions/episodic-claw/episodes_test_phase3/vector.db/MANIFEST-000001
/root/.openclaw/extensions/episodic-claw/tests/real_test_ws/vector.db/MANIFEST-000016
/root/.openclaw/extensions/episodic-claw/tests/real_test_ws/vector.db/MANIFEST-000012
/root/.openclaw/extensions/episodic-claw/tests/test_ws/vector.db/MANIFEST-000001
```

## 問題・ブロッカー

### 解決済みの問題（追加修正分含む）
1. **バイナリ実行モードへの移行**: `__dirname` が Windows パスを指していた問題を修正。
2. **Spawn パス（cwd）の修正**: `rpc-client.ts` L69-70 にて、バイナリ実行時にも不要な `/root/go` が cwd にならないよう `cwd: pluginRoot` を明示指定するよう修正完了。
3. **API キー設定・漏洩対応**: Go サイドカー用に `GEMINI_API_KEY` を設定。レポートに記述されていた生キーは削除した（※直ちに失効手続をすること）。

### 不正テスト（スクリプト）による汚染
`/root/episodes` を手動作成した点は、本来のエージェント会話フローから外れたアドホックな処理であり、Phase 5.5 E2E テストとしては無効。

## 次のステップ

**Phase 5.4 P3 再検証は完了** → Phase 5.5 のスクリプトテストは「機能の疎通確認」に留まり E2E として不完全なため、以下のステップで**Phase 5.5 の再テスト**を行う。

1. **🚨 即時対応**: Google AI Studio で漏洩した API キーを無効化・再発行する。（※補足：テスト用の無料APIで問題ない）
2. **Phase 5.5 完全版テスト**: 修正済みの `opencode_phase_5_5_prompt.md` に従い、OpenClaw TUI (`openclaw chat`) で Keruvim と対話する「真の E2E テスト」を Opencode で再実行する。
