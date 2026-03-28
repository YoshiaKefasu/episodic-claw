# Phase 5.5 E2E テスト実行結果報告

## 実行日時
2026-03-20 22:40 (ICT, UTC+7)

## テスト概要
Phase 5.5 の正式な E2E テスト（`openclaw agent` コマンド使用）を実施。TUI (`openclaw tui`) は非対話環境では使用できないため、`openclaw agent --agent main -m "..."` で代用。

## 結果サマリー

### Part A: Phase 5.4 P3 確認（前提条件）

| Step | 内容 | 結果 | 備考 |
|------|------|------|------|
| A-3 | Gateway 起動（binary モード） | ✅ | `(binary)` モードで起動確認 |
| A-4 | ps aux（go run なし） | ✅ | `episodic-core` プロセスのみ |

### Part B: Phase 5.5 E2E テスト

| Step | 内容 | 結果 | 備考 |
|------|------|------|------|
| B-0 | Go サイドカー RPC API 確認 | ✅ | watcher.start, ai.recall, ai.ingest 等を確認 |
| B-2a | **エージェントへのメッセージ送信** | ✅ | `openclaw agent --agent main -m "..."` で送信成功 |
| B-2a | **エージェントの応答** | ✅ | Keruvim が日本語で応答（「Phase 5.4の成果をしっかり覚えておくね」） |
| B-2a | **ingest フック発火** | ❌ | `Go sidecar socket not connected` エラーで失敗 |
| B-2a | **episodes/ ファイル生成** | ❌ | ingest 失敗のためファイル生成なし |
| B-3 | episodic-core ログ確認 | ⚠️ | watcher.start は成功したが、后续の ingest 処理で接続断 |
| B-4 | assemble / recall テスト | ❌ | ソケット接続エラーのため失敗 |

**フェーズ達成**: エージェントとの通信は成功したが、Context Engine の ingest 機能が動作しなかったため **Phase 5.5 は未達（INCOMPLETE）** → 🔴


## 詳細分析

### 成功した点
1. **Gateway 起動**: バイナリ実行モードで正常起動
2. **Go サイドカー起動**: `episodic-core` プロセスが起動し、watcher.start が成功
3. **エージェント通信**: `openclaw agent` コマンドで Keruvim にメッセージ送信成功
4. **エージェント応答**: Keruvim が適切に応答（「Phase 5.4の成果をしっかり覚えておくね。Goサイドカーがbinaryモードで起動成功し、RPC通信も確立したとのこと。episodic-clawプラグインの動作確認も順調に進んでいるようだね。」）

### 失敗した点
1. **Go サイドカーのソケット接続が断絶**: 初期接続は成功したが、後続の ingest/recall 処理時に「Go sidecar socket not connected」エラーが発生
2. **ingest 処理失敗**: エージェントのメッセージを Episode として永続化できなかった
3. **episodes/ ファイル未生成**: ingest 失敗のため、エピソードファイルが作成されなかった

### エラーログ（抜粋）
```
[Episodic Memory] Retrieval failed: Error: Go sidecar socket not connected
    at EpisodicCoreClient.request (/root/.openclaw/extensions/episodic-claw/src/rpc-client.ts:181:13)
    at EpisodicCoreClient.recall (/root/.openclaw/extensions/episodic-claw/src/rpc-client.ts:214:17)
    at EpisodicRetriever.retrieveRelevantContext (/root/.openclaw/extensions/episodic-claw/src/retriever.ts:26:44)
    at Object.assemble (/root/.openclaw/extensions/episodic-claw/src/index.ts:96:53)

[Episodic Memory] Error processing ingest: Error: Go sidecar socket not connected
    at EpisodicCoreClient.request (/root/.openclaw/extensions/episodic-claw/src/rpc-client.ts:181:13)
    at EpisodicCoreClient.setMeta (/root/.openclaw/extensions/episodic-claw/src/rpc-client.ts:234:17)
    at Object.ingest (/root/.openclaw/extensions/episodic-claw/src/index.ts:84:31)
```

### 根本原因の推定
`rpc-client.ts` の `request` メソッドが `this.socket` が null または接続されていない状態で呼び出されている。初期接続は成功したが、その後ソケット接続が失われた可能性がある。

考えられる原因：
1. **ソケットタイムアウト**: 初期接続後、一定時間操作がないとソケットがクローズされる
2. **コンカレンシー問題**: 複数の RPC リクエストが同時に発行され、ソケットの状態管理が不正
3. **Go サイドカーのシグナル処理**: SIGPIPE 等のシグナルによりソケットがクローズされた


## Arch Linux WSL 上の ChangeLog

### コピー済みファイル
- `~/.openclaw/extensions/episodic-claw/dist/episodic-core` — Linux バイナリをコピー（2026-03-20）
- `~/.openclaw/extensions/episodic-claw/dist/*.js` — 最新 dist JS 一括コピー（2026-03-20）
- `~/.openclaw/extensions/episodic-claw/scripts/postinstall.js` — 新規作成（2026-03-20）
- `~/.openclaw/extensions/episodic-claw/src/rpc-client.ts` — Windows 側修正版をコピー（2026-03-20）

### パーミッション変更
- `dist/episodic-core` — chmod 755 適用（postinstall.js 経由）

### ディレクトリ作成
- `/root/episodes` — Watcher 起動用ディレクトリ（※本来は不要、プラグインのフォールバックパス）
- `/root/.openclaw/workspace-keruvim/episodes` — 正規のエピソード格納ディレクトリ

### 設定変更
- `~/.openclaw/openclaw.json` — 変更なし（Phase 5.2 設定を継続使用）
- `~/.openclaw/.env` — Gemini API キーを追加済み
  ```
  GOOGLE_AI_STUDIO_KEY=[REDACTED]
  GEMINI_API_KEY=[REDACTED]
  ```


## 観測されたログ（抜粋）

### Gateway 起動ログ
```
[Episodic Memory] Starting Go sidecar... (gateway port: 18789)
[Plugin] Spawn Go sidecar (binary) at /root/.openclaw/extensions/episodic-claw/dist/episodic-core on /tmp/episodic-core-1774019807521.sock
[Episodic-Core] Starting Go Sidecar on socket /tmp/episodic-core-1774019807521.sock
[Plugin] Connected to Go RPC socket
[Episodic-Core] Method: watcher.start
```

### エージェント応答
```
[ws] ⇄ res ✓ agent 131ms runId=1aeaced7-7b2e-454a-8992-7c26d3d1ae32 conn=40255ab6…e0db id=ee140a31…e8bf
Phase 5.4の成果をしっかり覚えておくね。Goサイドカーがbinaryモードで起動成功し、RPC通信も確立したとのこと。episodic-clawプラグインの動作確認も順調に進んでいるようだね。何か手伝えることがあればいつでも教えて。引き続き見守ってるよ。
```

### ingest 失敗ログ
```
[Episodic Memory] Retrieval failed: Error: Go sidecar socket not connected
[Episodic Memory] Error processing ingest: Error: Go sidecar socket not connected
```

### episodic-core ログ
```
[Episodic-Core] Observability initialized. Writing structured logs to /tmp/episodic-core.log
[Episodic-Core] Starting Go Sidecar on socket /tmp/episodic-core-1774019807521.sock
[Episodic-Core] Method: watcher.start
```


## 問題・ブロッカー

### 解決済みの問題
1. **バイナリ実行モード**: ✅ `(binary)` で起動確認
2. **Watcher 起動**: ✅ watcher.start が成功
3. **エージェント通信**: ✅ `openclaw agent` コマンドで Keruvim に送信成功
4. **エージェント応答**: ✅ Keruvim が適切に応答

### 未解決の問題（🔴 Critical）
1. **Go サイドカーのソケット接続断絶**: 初期接続は成功するが、後続の ingest/recall 処理時に「Go sidecar socket not connected」エラーが発生する。このため Context Engine の ingest 機能が動作しない。
2. **episodes/ ファイル未生成**: ingest 失敗のため、エピソードファイルが作成されない。
3. **プラグインのフォールバックパス問題**: `resolveAgentWorkspaceDir` API が利用できない場合、`/root/episodes` にフォールバックするが、このディレクトリは存在しない。本来は `~/.openclaw/workspace-keruvim/episodes` を使用すべき。

### 原因分析
`rpc-client.ts` の `request` メソッドで `this.socket` が null または接続されていない状態で呼び出されている。初期接続の `start()` メソッドは成功するが、その後の `request()` 呼び出しで接続が失われている。

修正が必要な箇所：
- `src/rpc-client.ts` の `request` メソッドで、ソケット接続の状態チェックとリトライロジックの追加
- `start()` メソッドで確立した接続が維持されるようにハートビートやリコネクト機能の実装


## 次のステップ

**Phase 5.5 は未達（INCOMPLETE）** → 以下の修正が必要：

1. **🔴 Critical**: `rpc-client.ts` のソケット接続管理を修正（リトライ/リコネクト機能の追加）
2. **🔴 Critical**: `index.ts` の `resolvedAgentWorkspaceDir` フォールバックロジックを修正
3. **修正後**: Phase 5.5 の完全な再テスト（E2E フロー全体：送信 → ingest → 応答 → episodes 生成）

**注**: ソースコードの修正は Windows 側の `/mnt/d/GitHub/OpenClaw Related Repos/episodic-claw/` で行い、修正後に WSL に再コピーしてテストする必要があります。
