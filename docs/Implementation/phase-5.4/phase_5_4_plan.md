# Phase 5.4: Go サイドカーの起動と RPC 通信テスト 実行プラン

## 🎯 フェーズの目的
このフェーズでは、OpenClaw プラグインの Go サイドカー (`episodic-core`) が正常に起動し、TypeScript 側との JSON-RPC over TCP 通信が確立されることを検証します。これはプラグインのコア機能である AI サービス (Surprise 計算、Episode スラッグ生成など) の基盤となります。

## ✅ 前提条件（必ず確認してください）
- WSL2 ArchLinux 環境が構築済み (Phase 5.0 完了)
- OpenClaw CLI がインストール済みかつ `openclaw --version` で動作確認済み (Phase 5.0 完了)
- `episodic-claw` プラグインがビルド済み (`dist/index.js` と Go バイナリが生成済み) (Phase 5.2 完了)
- プラグインがローカルインストール済み (`~/.openclaw/extensions/episodic-claw/` に配置済み) (Phase 5.2 完了)
- `openclaw.json` にプラグインスロットの設定が完了済み (Phase 5.2 完了)
- Google AI Studio の API キーが `~/.openclaw/.env` に設定済み (Phase 5.1 完了)

## 📋 詳細手順

### 🔧 ステップ 0: 前提条件の最終確認（10分）
このステップを飛ばすと後で泣くことになるので、きちんとやりましょう。

| 確認項目 | コマンド/手順 | 期待結果 | 問題があったときの対処 |
|----------|--------------|----------|----------------------|
| **WSL 環境確認** | `wsl --list --verbose` | ArchLinux が実行中であること | WSL が入ってない？ それなら `wsl --install -d ArchLinux` だよ |
| **ディレクトリ存在確認** | `ls -la ~/.openclaw/extensions/episodic-claw/` | `dist/` と `bin/` ディレクトリが存在 | Phase 5.2 の手順をもういっこやってみて |
| **環境変数確認** | `cat ~/.openclaw/.env \| grep GOOGLE_AI_STUDIO_KEY` | API キーが設定されていること（`your_actual_key_here` とか） | `.env` ファイル作って `GOOGLE_AI_STUDIO_KEY=あなたのキー` と書こう |
| **プラグイン設定確認** | `cat ~/.openclaw/openclaw.json \| grep -A 10 "plugins.slots"` | `contextEngine` と `memory` が `"episodic-claw"` に設定 | `openclaw.json` を開いて、ちゃんと設定し直そう |

### 📁 ステップ 1: バイナリ配置の確認（5分）
「ファイルがあるよ？」レベルじゃなくて、ちゃんと動くやつか見ようぜ。

| 確認項目 | コマンド/手順 | 期待結果 | 問題があったときの対処 |
|----------|--------------|----------|----------------------|
| **バイナリ存在確認** | `ls -l ~/.openclaw/extensions/episodic-claw/bin/episodic-core` | ファイルが存在かつ実行権限あり（`-rwxr-xr-x` が理想） | 権限ない？ なら `chmod +x ~/.openclaw/extensions/episodic-claw/bin/episodic-core` してくれ |
| **バイナリタイプ確認** | `file ~/.openclaw/extensions/episodic-claw/bin/episodic-core` | `ELF 64-bit LSB executable, x86-64, version 1 (SYSV)` とか表示 | 変なバイナリ？ Phase 5.2 の Go クロスコンパイル手順見直しだね（`GOOS=linux GOARCH=amd64` お忘れなく） |
| **ヘルプ表示確認** | `~/.openclaw/extensions/episodic-claw/bin/episodic-core --help` | エラーなくヘルプかバージョン情報が表示 | バイナリが壊れてる？ ならもういっこビルドし直そう |

### ⚙️ ステップ 2: Gateway 再起動と初期化ログ監視（15分）
ここが肝。ログを見逃さないように、ターミナルは2つ用意してね。

| 実行項目 | コマンド/手順 | 期待結果 | 問題があったときの対処 |
|----------|--------------|----------|----------------------|
| **既存プロセス停止** | `pkill -f openclaw` または `openclaw gateway stop` | 既存の OpenClaw プロセスがスッと停止 | `ps aux \| grep openclaw` で残ってないか念のためチェック |
| **ゲートウェイ起動** | `openclaw gateway start` | ゲートウェイが起動してバックグラウンドで動き出す | エラー出た？ ならば `openclaw gateway start --verbose` で詳細ログを見よう |
| **初期化ログ監視** | 別ターミナルで `tail -f ~/.openclaw/logs/gateway.log` または標準出力を監視 | 起動後30秒以内に `[Episodic Memory] Starting Go sidecar...` が出現 | ログ出ないときは：<br>1. プラグインの `index.ts` で `register()` 呼ばれてるか確認<br>2. Go サイドカーのビルドに問題ないか確認<br>3. 環境変数がちゃんと読み込めてるか確認 |
| **ゲートウェイ起動完了確認** | `curl -s http://localhost:18789/ \| grep -i "openclaw"` またはブラウザで `http://localhost:18789/` にアクセス | ダッシュボードが表示されるか、API がちゃんと応答 | ポート 18789 が使われてるか？ `netstat -tlnp \| grep :18789` で確認だね |

### 👀 ステップ 3: プロセス稼働確認（5分）
「動いてるっぽい」じゃなくて、本当に動いてるかガチで見よう。

| 確認項目 | コマンド/手順 | 期待結果 | 問題があったときの対処 |
|----------|--------------|----------|----------------------|
| **Go サイドカー プロセス確認** | `ps aux \| grep episodic-core \| grep -v grep` | `episodic-core` バイナリが実行中であること | プロセス見つからない？<br>1. ゲートウェイのログをもう一度見てみよう<br>2. サイドカーの起動に失敗してる可能性あり |
| **リソース使用量確認** | `top -p $(pgrep episodic-core)` または `htop` | CPU/メモリが異常に高くないこと（だいたい落ち着いてるはず） | メモリ食いすぎ？ もしかするとリークしてるかも…次のステップで詳しく見よう |
| **ポート監視確認** | `netstat -tlnp \| grep episodic-core` または `ss -tlnp \| grep episodic-core` | 特定のポート（127.0.0.1:XXXXX とか）で LISTEN 状態であること | ポートが開いてない？ ファイアウォール設定か、サイドカーのバインディングアドレスを疑ってみて |

### 🌐 ステップ 4: TCP 接続と RPC Ping テスト（10分）
ここで初めて「ちゃんと話せてる？」って確認するんだ。緊張するね。

| 実行項目 | コマンド/手順 | 期待結果 | 問題があったときの対処 |
|----------|--------------|----------|----------------------|
| **基本 TCP 接続テスト** | `nc -zv 127.0.0.1 <port>` または `curl -v telnet://127.0.0.1:<port>` | 接続が成功すること（`<port>` は前のステップで確認したやつ） | 接続拒否された？ サイドカーがポートをリッスンしてない可能性大 |
| **TS 側からの ping テスト** | OpenClaw ゲートウェイのログを監視しながら、適当に会話を送信<br>または、プラグインの RPC クライアントを直接呼び出すテストスクリプト実行 | TS 側ログに `DEBUG: Connected to sidecar`、`DEBUG: Received pong from sidecar` が出現 | ログレベル調整しよう：<br>`lsp-powershell_set_log_level` または該当するツールで DEBUG レベルに設定 |
| **実際の RPC コールテスト** | プラグイン提供のテストツールを使う（ある場合）または、`ep-save` ツールを試しに実行し、Go サイドカーが正常にレスポンス返すか確認 | `ep-save` がエラーなく実行され、`Saved episode to ...` と返却される | RPC エラー出たら：<br>1. Go サイドカーのログでエラー詳細確認<br>2. API キーが正しいか再確認<br>3. ネットワークポリシーが RPC ポートをブロックしてないか確認 |
| **レスポンス時間測定** | 簡単なベンチマークスクリプト作って、10回程度 RPC 呼んで平均応答時間測定 | 平均応答時間が 5秒以内（ネットワーク環境によるけどね） | 応答遅い？ Google API へのレイテンシーか、Go サイドカーの処理負荷を見てみよう |

### 🔌 ステップ 5: 自動シャットダウン・リークテスト（20分）
これで本当に大丈夫か、最後に念入りにチェックだ。ゾンビプロセスとか嫌じゃん？

| 実行項目 | コマンド/手順 | 期待結果 | 問題があったときの対処 |
|----------|--------------|----------|----------------------|
| **初期状態確認** | `ps aux \| grep episodic-core \| grep -v grep` \| wc -l | 1（サイドカーが実行中） | 0？ じゃあ前のステップに戻ろう |
| **シャットダウンシミュレーション** | `pkill -f openclaw` または `openclaw gateway stop` | OpenClaw ゲートウェイが停止 | ゲートウェイが止まらない？ じゃあ強制終了も検討だね |
| **サイドカー自動停止確認** | シャットダウンコマンド実行後、5秒以内に `ps aux \| grep episodic-core \| grep -v grep` を再実行 | 0（サイドカーも一緒に止まってること） | ゾンビプロセス残っちゃった？<br>1. プラグインのシャットダウンハンドラーに問題ないか確認<br>2. Go サイドカーがシグナルをちゃんとハンドリングしてるか確認 |
| **リークテスト（3回繰り返し）** | 以下のサイクルを3回繰り返す：<br>1. ゲートウェイ起動<br>2. 10秒待機<br>3. ゲートウェイ停止<br>4. 5秒待機し、プロセス確認 | 各サイクル後にサイドカープロセスが0になること<br>メモリ使用量が増えてないこと | メモリリーク疑う？<br>`watch -n 1 "ps aux \| grep [e]pisodic-core \| awk '{sum+=\$6} END {print sum}'"` でメモリ使用量監視しよう |
| **最終状態確認** | `ps aux \| grep episodic-core \| grep -v grep` | 0（残ってるプロセスがひとつもないこと） | 残ってたら手動で終了させて、根本原因をじっくり調査しよう |

## 🏆 成功基準（ここに到達したらフェーズ完了！）
以下のすべてを満たしたなら、このフェーズはおしまいです。おつかれさまでした！

1. **バイナリ配置 OK**: `~/.openclaw/extensions/episodic-claw/bin/episodic-core` が存在し、実行権限あり、正しいアーキテクチャのバイナリであること
2. **ゲートウェイ起動 OK**: `openclaw gateway start` 実行後、`[Episodic Memory] Starting Go sidecar...` ログが stdout/stderr に出現すること
3. **プロセス稼働 OK**: ゲートウェイ起動中に `episodic-core` プロセスが実行中かつ、特定のポートで LISTEN 状態であること
4. **RPC 通信 OK**: 
   - TS 側ログに `DEBUG: Connected to sidecar` が出現
   - TS 側ログに `DEBUG: Received pong from sidecar` が出現
   - `ep-save` ツールがエラーなく実行され、エピソードが正常に保存されること
5. **シャットダウン動作 OK**: ゲートウェイ停止時に `episodic-core` プロセスも連動して停止し、ゾンビプロセスが残らないこと
6. **リークなし OK**: シャットダウン/起動サイクルを3回繰り返しても、メモリ使用量に著しい増加が見られないこと

## 🚨 トラブルシューティングガイド（「あーん」とならないために）
| 症状 | 考えられる原因 | 対処法 |
|------|--------------|--------|
| `[Episodic Memory] Starting Go sidecar...` ログが出ない | プラグインの登録失敗、Go サイドカーのビルドエラー | 1. `openclaw plugins doctor` でプラグインの状態確認<br>2. Go サイドカーを手動で実行してエラー見る：`~/.openclaw/extensions/episodic-claw/bin/episodic-core` |
| 接続はできるが RPC ピングが失敗する | ログレベル設定不一致、API 認証エラー | 1. ログレベルを DEBUG に設定し、詳細確認<br>2. `~/.openclaw/.env` の API キー再確認<br>3. Google API の quota が使い果たされてないか確認 |
| ゲートウェイ停止時にサイドカーが残る | シグナルハンドリングの問題 | 1. プラグインのシャットダウンハンドラー実装を確認<br>2. Go サイドカーが SIGTERM/SIGINT をちゃんとハンドリングしてるか確認 |
| 間欠的な接続失敗 | ポート競合、ファイアウォール設定 | 1. `lsof -i:<port>` で競合プロセスがないか確認<br>2. WSL のネットワーク設定および Windows ファイアウォールを確認 |
| メモリ使用量が徐々に増加 | メモリリーク（バッファ解放漏れ、ゴルーチンリーク） | 1. Go サイドカーのコードでリソース解放漏れがないか確認<br>2. プロファイラーツール（pprof）使って詳細調査 |

## 🔧 推奨ツール・コマンド（これ使うと捗るよ）
- プロセス監視: `ps`, `top`, `htop`, `lsof`
- ネットワーク確認: `netstat`, `ss`, `nc`, `curl`
- ログ監視: `tail -f`, `journalctl`（該当する場合なら）
- デバッグ: `strace`, `gdb`（必要に応じて）
- API テスト: `curl` を使った直接的な RPC エンドポイントテスト（内部実装によるけど）

## ➡️ 次のフェーズへ進むときの条件
このフェーズが完了したら、すぐに **Phase 5.5: Context Engine 基本機能テスト (ingest / assemble / compact)** に進んでいいですよ。このフェーズの成功は、これからのすべてのテストにおける前提条件になるからね。

さあ、これで準備万端！ それでは、いってらっしゃい〜 🚀