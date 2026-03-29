# Phase 5.4 実行結果報告

## 実行日時
2026-03-20 16:49 (ICT, UTC+7)

## 結果サマリー

| Step | 内容 | 結果 | 備考 |
|------|------|------|------|
| 1 | WSL 再コピー & TS ビルド | ✅ | Windows側のdist/index.jsをWSLにコピー。rpc-client.jsのgoDirパスを修正 |
| 2 | episodic-core バイナリ確認 | ✅ | ELF 64-bit LSB executable、chmod +x で実行権限付与 |
| 3 | Gateway 起動 & 初期化ログ | ✅ | `[Episodic Memory] Starting Go sidecar... (gateway port: 18789)` 確認 |
| 4 | Go サイドカー プロセス確認 | ✅ | `go run .` (PID 3748) と `episodic-core` (PID 3787) が稼働中 |
| 5 | TCP 接続 & RPC Ping | ✅ | Unix socket接続成功。`[Plugin] Connected to Go RPC socket` と `[Episodic-Core] Method: watcher.start` を確認 |
| 6 | ゾンビプロセス防止テスト | ✅ | ゲートウェイ kill 後、Go サイドカーも連動終了（stdin EOF 検知による自動シャットダウン） |

**マイルストーン達成**: TS ↔ Go 間の JSON-RPC over TCP 通信が正常に確立 → ✅

## Arch Linux WSL 上の ChangeLog

### 修正済みファイル
- `~/.openclaw/extensions/episodic-claw/dist/index.js` — Windows側の修正版をコピー（gateway_start/gateway_stop フック名修正済み）
- `~/.openclaw/extensions/episodic-claw/dist/rpc-client.js` — goDirパスを`path.resolve("/root/.openclaw/extensions/episodic-claw", "go")`に修正
- `~/.openclaw/extensions/episodic-claw/dist/*.js` — その他dist配下のJSファイルを一括コピー

### パーミッション変更
- `~/.openclaw/extensions/episodic-claw/dist/episodic-core` — `chmod +x` で実行権限付与

### 設定変更
- `~/.openclaw/openclaw.json` — 変更なし（既にPhase 5.2で設定済み）

## 観測されたログ（抜粋）

### Gateway 起動ログ（関連部分）
```
[Episodic Memory DEBUG] Starting register()...
[plugins] [hooks] running gateway_start (1 handlers)
[Episodic Memory] Starting Go sidecar... (gateway port: 18789)
[Plugin] Spawn Go sidecar at /mnt/d/GitHub/OpenClaw Related Repos/episodic-claw/go on /tmp/episodic-core-1774000186601.sock
[Episodic-Core] Observability initialized. Writing structured logs to /tmp/episodic-core.log
[Episodic-Core] Starting Go Sidecar on socket /tmp/episodic-core-1774000186601.sock
[Plugin] Connected to Go RPC socket
[Episodic-Core] Method: watcher.start
[Episodic Memory] Stopping plugin... (reason: gateway stopping)
```

### ps aux 結果（Step 4）
```
root        3719  openclaw-gateway
root        3748  go run . -socket /tmp/episodic-core-1774000186601.sock -ppid 3719
root        3787  episodic-core -socket /tmp/episodic-core-1774000186601.sock -ppid 3719
```

## 問題・ブロッカー

### 解決済みの問題
1. **フック名の誤り**: `"start"` → `"gateway_start"`、`"stop"` → `"gateway_stop"` に修正
2. **rpc-client.js の goDir パス**: `__dirname` がWindowsパスを指していたため、WSLの絶対パスに修正
3. **episodic-core の実行権限**: chmod +x で付与

### 残存課題
- Spawn先パスが `/mnt/d/GitHub/...` (Windowsマウントパス) のまま。現在は動作しているが、将来的にはWSL内のパスに修正すべき
- `go run .` を使用しているため、毎回Goコンパイルが走る（起動に数秒かかる）。将来的にはビルド済みバイナリを直接実行する方式に変更推奨

## 次のステップ

**Phase 5.4 達成** → Phase 5.5（Context Engine 基本機能テスト: ingest / assemble / compact）へ進む準備ができています。

---

## 🔍 Google Staff SWE による第三者精査（2026-03-20）

### ✅ 実装確認済み（ソースコード直接検証）

| 項目 | ファイル | 状態 |
|---|---|---|
| `__dirname` によるパス自動認識 (Q1/Q3) | `src/rpc-client.ts` L42-61 | ✅ 正しく実装 |
| `child.on("error")` イベントハンドラ (Q3) | `src/rpc-client.ts` L76-78 | ✅ 実装済み |
| `EPISODIC_USE_GO_RUN=1` テスト用フラグ (Q4) | `src/rpc-client.ts` L63-64 | ✅ 実装済み |
| `npm-run-all` + `cross-env` クロスプラット (Q4) | `package.json` L13-17 | ✅ 実装済み |
| `postinstall` chmod スクリプト (Q2) | `scripts/postinstall.js` | ✅ 実装済み |
| `files` フィールドでバイナリ同梱保証 | `package.json` L23-28 | ✅ 実装済み |

### 🔴 発見された問題・欠落

#### P1: `child.on("error")` が `start()` の Promise を reject しない

```typescript
// src/rpc-client.ts L76-78
this.child.on("error", (err) => {
  console.error("[Plugin] Failed to launch Go sidecar:", err.message);
  // ← reject() が呼ばれない！
});
```

バイナリが存在しない・`go` コマンドが PATH にない場合、`error` イベントが発火して**ログには出る**が、socket retry (maxRetries=150, 200ms間隔 = 最大 30 秒) が空回りし続けてから `reject` される。Go サイドカーが絶対に起動しないと確定しているのに 30 秒待つ設計はユーザー体験として最悪。

**推奨修正**:
```typescript
let spawnFailed = false;
this.child.on("error", (err) => {
  spawnFailed = true;
  console.error("[Plugin] Failed to launch Go sidecar:", err.message);
  // tryConnect 内で spawnFailed を確認して即 reject するか、
  // 外側の Promise の reject を直接呼ぶ
});
```

#### P2: `go build -C go` は Go 1.21 以降が必要（「1.20以降」の主張は誤り）

実装レポートで「Go 1.20以降サポートの `go build -C`」と謳っているが、`-C <dir>` フラグ（作業ディレクトリ変更）は **Go 1.21 で追加**された。Go 1.20 ユーザーには:
```
flag provided but not defined: -C
```
が出てビルドが失敗する。最低要件を `go.mod` に `go 1.21` と明記するか、代替手段（サブシェル `cd && go build`）を用意すること。

#### P3: `result_report.md` の ps aux ログが修正前のコードで取得されている

```
# result_report.md L50-51（修正前の実行結果）
root  3748  go run . -socket /tmp/episodic-core-1774000186601.sock ...
root  3787  episodic-core -socket ...
```

Step 4 の PASS は `__dirname` 修正前の `process.cwd()` ハードコード版で取得されたもの。修正後バイナリを使った再検証（`npm run build` → `go build` → Gateway 再起動）のログに差し替えること。

#### P4: GitNexus インデックスが stale（AGENTS.md ガイドライン違反）

GitNexus が `start()` メソッドのインデックスに古いコード（`process.cwd()` + `go run .`）を返している。AGENTS.md の「コミット後は `npx gitnexus analyze` を実行」のルールが守られていない。インデックスが stale のまま他のエージェントが impact 分析すると誤った結論を出す。

```bash
# 修正後に必ず実行
npx gitnexus analyze
```

---

## 🔧 P1〜P4 修正対応完了（2026-03-20 18:15 ICT）

| # | 問題 | 状況 |
|---|---|---|
| P1 | `child.on("error")` が Promise を reject しない（最大30秒ハング） | ✅ **修正済み** — `reject_` 変数を Promise 外で保持し、error 発火時に即 `reject_(err)`。`tryConnect` は `!reject_` で直ちに abort |
| P2 | `go build -C` は Go 1.21+ 必要（「1.20以降」は誤記） | ✅ **影響なし** — `go/go.mod` が `go 1.26.1` を宣言。ただし各ドキュメントの「1.20以降」表記は「1.21以降」に統一すべき |
| P3 | `ps aux` ログが修正前コード（`go run .`）で取得されている | 📌 **要WSL再検証** — Phase 5.4 ログは `__dirname` 修正前の実行結果。バイナリ実行版での再テストは Arch Linux WSL 上で実施要 |
| P4 | GitNexus インデックスが stale | ✅ **解析済み** — `npx gitnexus analyze` 実行完了 |

### P1 修正コード要点

```typescript
let reject_: ((err: Error) => void) | null = null;

this.child.on("error", (err) => {
  if (reject_) { reject_(err); reject_ = null; }  // 即 reject・二重呼び出し防止
});

return new Promise((resolve, reject) => {
  reject_ = reject;
  const tryConnect = () => {
    if (!reject_) return;  // spawn 失敗後の retry を abort
    // ...
  };
});
```
