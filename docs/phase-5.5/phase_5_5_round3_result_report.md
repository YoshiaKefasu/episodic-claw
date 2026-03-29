# Phase 5.5 第3ラウンド E2E テスト結果報告（DNS 修正版）

## 実行日時
2026-03-21 00:40 (ICT, UTC+7)

## テスト概要
WSL の DNS を `10.255.255.254` → `1.1.1.1` に修正後、Phase 5.5 の E2E テストを再実行。

## 結果サマリー

### Part A: DNS 修正

| Step | 内容 | 結果 | 備考 |
|------|------|------|------|
| DNS-1 | `/etc/resolv.conf` を `1.1.1.1` に変更 | ✅ | `nameserver 1.1.1.1` に上書き |
| DNS-2 | `generativelanguage.googleapis.com` 解決確認 | ✅ | `ping` で `172.253.118.95` に解決成功 |

### Part B: Phase 5.5 E2E テスト（第3ラウンド + DNS 修正）

| Step | 内容 | 結果 | 備考 |
|------|------|------|------|
| B-0 | Gateway 起動（binary モード） | ✅ | `(binary)` モードで起動確認 |
| B-0 | Go サイドカー起動 | ✅ | `episodic-core` プロセス稼働中 |
| B-0 | watcher.start | ✅ | `[Episodic-Core] Method: watcher.start` |
| B-2a | **エージェントへのメッセージ送信** | ✅ | `openclaw agent --agent main -m "..."` で送信成功 |
| B-2a | **エージェントの応答** | ✅ | 日本語でエラーレポート応答（「Go sidecar socket not connected」） |
| B-2a | **Go サイドカー接続** | ❌ | `Go sidecar socket not connected` エラー（前回と同様） |
| B-2a | **ingest フック発火** | ❌ | ソケット未接続のため失敗 |
| B-2a | **episodes/ ファイル生成** | ❌ | ingest 失敗のためファイル生成なし |

**フェーズ達成**: DNS は修正されたが、**rpc-client.ts の根本的な設計バグ（register() の多重呼び出しによる接続断）が未解決** のため **Phase 5.5 は未達（INCOMPLETE）** → 🔴


## 詳細分析

### DNS 修正の効果
- ✅ WSL の DNS が `1.1.1.1` に変更され、`generativelanguage.googleapis.com` の解決が可能に
- ✅ 前回の DNS タイムアウトエラーは解消
- ただし、DNS 修正とは別に存在する **rpc-client.ts の設計バグ**が新たなブロッカーとして浮上

### 新たに発見された根本原因 🔴

**rpc-client.ts の設計バグ — register() の多重呼び出し**

OpenClaw のプラグインシステムは `register()` 関数を複数回呼び出す場合がある（ログに `[Episodic Memory DEBUG] Starting register()...` が複数回出現）。

```typescript
// index.ts L42: register() 内で rpcClient をローカル変数として生成
const rpcClient = new EpisodicCoreClient();
```

**問題のメカニズム:**

1. **1回目の register()**: `rpcClient_1` が生成される → `gateway_start` フックが発火 → `rpcClient_1.start()` が呼ばれる → ソケット接続確立 ✅
2. **2回目の register()**: `rpcClient_2` が生成される → `gateway_start` フックは**既に発火済み** → `rpcClient_2.start()` は**呼ばれない** → `rpcClient_2.connectOpts` は `undefined` ❌
3. **ツール登録**: OpenClaw が最新の `register()` で登録されたツールを使用 → `rpcClient_2` が使用される
4. **ingest 呼び出し**: `rpcClient_2.request()` が呼ばれる → `this.socket` は `undefined` → `this.connectOpts` も `undefined` → `throw new Error("Go sidecar socket not connected")`

**決定的証拠:**
```
[Episodic Memory DEBUG] Starting register()...  (1回目)
[Episodic Memory DEBUG] Starting register()...  (2回目)
[Episodic Memory] Starting Go sidecar...        (gateway_start フックは1回だけ)
...
[Episodic Memory] Error processing ingest: Error: Go sidecar socket not connected  (2回目の rpcClient が使用された)
```

### エラーログ
```
[Episodic Memory] Retrieval failed: Error: Go sidecar socket not connected
    at EpisodicCoreClient.request (/root/.openclaw/extensions/episodic-claw/src/rpc-client.ts:279:15)
```

Line 279 は `throw new Error("Go sidecar socket not connected");` — `this.connectOpts` が `undefined` の場合のフォールバック。


## /tmp/episodic-core.log 全文（Go 側ログ記録）

```json
{"level":"info","message":"[Episodic-Core] Observability initialized. Writing structured logs to /tmp/episodic-core.log","timestamp":"2026-03-21T00:32:55+07:00"}
{"level":"info","message":"[Episodic-Core] Starting Go Sidecar on socket /tmp/episodic-core-1774027955357.sock","timestamp":"2026-03-21T00:32:55+07:00"}
{"level":"info","message":"[Episodic-Core] Method: watcher.start","timestamp":"2026-03-21T00:33:25+07:00"}
```

**分析**: Go サイドカーは正常に起動し、watcher.start を受信。ソケット切断のログは一切なし。問題は TS 側（rpc-client.ts）にある。


## Arch Linux WSL 上の ChangeLog

### 設定変更
- `/etc/resolv.conf` — `nameserver 1.1.1.1` に変更（2026-03-21 00:05）

### コピー済みファイル（2026-03-20 23:14）
- `~/.openclaw/extensions/episodic-claw/dist/*.js` — 修正済み dist JS 一括コピー
- `~/.openclaw/extensions/episodic-claw/dist/episodic-core` — Linux バイナリを再コピー
- `~/.openclaw/extensions/episodic-claw/src/*.ts` — 修正済み src TS 一括コピー


## 問題・ブロッカー

### 解決済みの問題
1. **🔴 → ✅ DNS タイムアウト**: WSL の DNS を `1.1.1.1` に変更して解決
2. **🔴 → ✅ Thundering Herd**: `reconnectPromise` でシリアライズ（コード上は実装済み）
3. **🔴 → ✅ Pending Leak**: `rejectPending` で即時 reject（コード上は実装済み）

### 未解決の問題（🔴 Critical）
1. **register() の多重呼び出しによる接続断**: OpenClaw が `register()` を複数回呼び出すと、2回目以降の `rpcClient` は `gateway_start` フックが発火済みのため `start()` が呼ばれず、`connectOpts` が `undefined` になる。結果、`request()` が「Go sidecar socket not connected」エラーを throw する。
2. **エージェント応答の検証**: エージェントは応答したが、内容は「Go sidecar socket not connected」エラーの報告。エピソードの保存は成功していない。

### 修正が必要な箇所
- `src/index.ts`: `rpcClient` をローカル変数ではなく**シングルトン**または**グローバル変数**として管理し、`register()` の多重呼び出しに対応する設計に変更
- または、`gateway_start` フック内で `rpcClient.start()` を呼ぶ代わりに、`register()` 内で即座に `start()` を呼び、`gateway_stop` で `stop()` を呼ぶ設計に変更


## 次のステップ

**Phase 5.5 は未達（INCOMPLETE）** → 以下の修正が必要：

1. **🔴 Critical**: `src/index.ts` の `rpcClient` 管理をシングルトンパターンに変更し、`register()` の多重呼び出しに対応
2. **修正後**: Phase 5.5 の完全な再テスト（E2E フロー全体：送信 → ingest → 応答 → episodes 生成）

**注**: ソースコードの修正は Windows 側の `/mnt/d/GitHub/OpenClaw Related Repos/episodic-claw/` で行い、修正後に WSL に再コピーしてテストする必要があります。

## エージェント応答（確認）

```
エピソードメモリへの保存を試みましたが、「Go sidecar socket not connected」というエラーが返ってきました。
RPC通信が確立されているとおっしゃっていましたが、メモリシステムではソケットが未接続と判定されているようです。
ソケットの状態を確認したほうがいいでしょうか、それとも再試行しますか？
```

エージェントは正常に応答し、エラー内容を正確に報告している。これはエージェント自体は動作していることを示す。
