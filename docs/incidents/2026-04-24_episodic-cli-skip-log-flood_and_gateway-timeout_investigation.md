# 2026-04-24 調査レポート: Episodic CLI skipログ多発 + Gateway probe timeout

## 0. 依頼スコープ

- ユーザー報告:
  - `"[Episodic Memory] CLI mode detected. Skipping plugin initialization to prevent blocks."` が大量に出る
  - `openclaw status / openclaw gateway probe` で Gateway が `unreachable` になる
- 実施範囲:
  - **Episodic-Claw本体コードの修正は行わない**（別エージェントで対応予定）
  - 原因調査と Kasou 上の運用復旧（到達性回復）まで

---

## 1. 事象の要約

### 1.1 CLI skipログ多発

- 文言は実際に `openclaw-2026-04-24.log` に連続記録。
- 例: `openclaw-2026-04-24.log:3870, 3873, 3876, 3879, 3882 ...`

### 1.2 Gateway probe timeout

- `openclaw gateway probe` が `Connect: failed - timeout` を返す状態を再現。
- 同時に `openclaw status` でも gateway unreachable 表示。

---

## 2. 事実ベースの根拠（最低3件）

### Evidence A: CLI skip文言の発生源（ソース）

- `episodic-claw/src/index.ts:548-552`
  - `DAEMON_CMDS = ["gateway", "agent", "test"]`
  - `!isDaemon` のとき `"CLI mode detected..."` を出力
- `node` コマンドは daemon 判定配列に含まれていない

**意味**: `node` 側実行文脈では CLI 判定になりやすく、skipログが出る条件を満たす。

### Evidence B: 実ログで同一文言が継続発生

- `X:\tmp\openclaw\openclaw-2026-04-24.log:3870-3908`
  - 同文言が周期的に継続

**意味**: 単発の起動ログではなく、繰り返し実行される経路で出ている。

### Evidence C: gateway は起動完了ログを出している

- `openclaw-2026-04-24.log:4142-4156`
  - `gateway loading configuration…`
  - `starting HTTP server...`
  - `ready (3 plugins, 7.3s)`

**意味**: gateway 自体は初期化できている。問題は「起動失敗」ではなく、到達性/負荷側の可能性が高い。

### Evidence D: node/gateway の同時高負荷

- 実行時プロセス:
  - `openclaw-gateway` CPU `97.6%` (`ps`)
  - `openclaw-node` CPU `73.1%` (`ps`)

**意味**: probe の 3秒予算で timeout しやすい運用状態になっていた。

### Evidence E: node停止で probe が即回復

- `systemctl --user stop openclaw-node` 後:
  - `openclaw gateway probe` → `Reachable: yes` / `Connect: ok (114ms)`
  - `openclaw status` → `gateway reachable 124ms`

**意味**: 到達性障害の主因は gateway単体故障より、同時稼働時の負荷/競合影響の寄与が高い。

---

## 3. 実施した対処

## 3.1 設定変更

- ファイル: `~/.openclaw/openclaw.json`
- 変更:
  - `gateway.tls.enabled: true -> false`
  - 位置: `openclaw.json:744-746`

**目的**: Gateway接続系の挙動を `ws/http` に寄せて検証を単純化。

## 3.2 サービス操作

1. `openclaw-gateway` 再起動
2. `openclaw-node` 一時停止
3. `openclaw gateway probe` / `openclaw status` / `openclaw gateway health` で再検証

---

## 4. 現在の状態（作業終了時点）

- `openclaw-gateway.service`: `active/running`, `NRestarts=0`
- `openclaw-node.service`: `inactive/dead`（一時停止）
- `openclaw gateway probe`: `Reachable: yes`, `Connect: ok (~106ms)`
- `openclaw status`: gateway reachable 表示へ復帰

---

## 5. まだ残っているもの（今回スコープ外）

1. **Episodic-Claw本体の CLI 判定ロジック修正**
   - `DAEMON_CMDS` に `node` を含めるか、`OPENCLAW_SERVICE_KIND` を優先判定するかは別タスク

2. **Nodeサービス再稼働方針の整理**
   - 現在は復旧優先で `openclaw-node` を停止
   - 再有効化する場合は、gateway と同時稼働時の負荷/役割を再確認してから戻す

---

## 6. オペレーションメモ（再現/復旧手順）

### 6.1 再現確認

1. `openclaw gateway probe`
2. `openclaw status`
3. `ps` で `openclaw-gateway` / `openclaw-node` の CPU 確認

### 6.2 暫定復旧

1. `systemctl --user stop openclaw-node`
2. `openclaw gateway probe`
3. `openclaw status`

### 6.3 戻し手順（必要時）

- `systemctl --user start openclaw-node`
- ただし戻した直後は `probe timeout` 再発有無を必ず確認すること

---

## 7. v0.4.28d 対策済み項目（2026-04-24 追記）

> v0.4.28d Option A+ で以下の対策を実施済み。

### 7.1 ログ洪水抑制

- CLI skip ログ（`"CLI mode detected..."`）はデフォルトで沈黙化された
- デバッグ時は `EPISODIC_LOG_CLI_SKIP=1` 環境変数で復元可能
- `Symbol.for("episodic.cli.skipped")` 同一プロセス内抑制は維持

### 7.2 runtime 判定のテスト可能化

- `resolveRuntimeMode(argv)` 純粋関数として `src/runtime-mode.ts` に抽出
- 返り値: `{ mode: "daemon" | "cli"; reason: string }`
- daemon 起動時に構造化 event 出力: `{ source: "episodic-claw", event: "runtime-mode", mode, reason }`

### 7.3 再発時の一次切り分け（Runbook）

1. **skip ログ洪水の再発確認**: `grep "CLI mode detected" openclaw-*.log | wc -l`
   - 0件 → v0.4.28d 対策で抑制済み ✅
   - 1件以上で `EPISODIC_LOG_CLI_SKIP` が設定されている → env flag を確認
2. **gateway probe timeout の再発**:
   - `systemctl --user stop openclaw-node` → `openclaw gateway probe` で回復するか確認
   - 回復する → node/gateway 同時負荷が原因（v0.4.28d では node daemon化を先送りしているため、このパターンは不变）
   - 回復しない → OpenClaw core 側の問題（本リポジトリ外）
3. **CPU 高騰時の確認順**:
   - `ps` で gateway/node の CPU 確認
   - gateway CPU が異常 → plugin 初期化負荷の可能性 → `resolveRuntimeMode` event で reason を確認
   - node CPU が異常 → node daemon化（別PR）後の lazy-init 効果を確認
4. **plugin ノイズ無効化フラグ**:
   - `EPISODIC_LOG_CLI_SKIP=0` または未設定 → skip ログ抑制
   - `EPISODIC_LOG_CLI_SKIP=1` → skip ログ復元（デバッグ用）

### 7.4 未解決・別PR待ち

- `DAEMON_CMDS` へ `node` 追加 → register() lazy-init 化完了後
- `OPENCLAW_SERVICE_KIND` env 優先判定 → 同上
- 詳細は `docs/plans/v0.4.x/v0.4.28d_cli_skip_log_flood_and_gateway_probe_timeout_hardening.md` の Deferral Record 参照
