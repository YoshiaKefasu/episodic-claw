# Phase 5.5 Round 5: Episodic Memory Ingest (Surprise) と Workspace 動的解決 テスト

> **作成日**: 2026-03-21 (ICT, UTC+7)
> **前回**: Round 4 → ソケットやシングルトンの安定性は確認したが、エピソード `.md` ファイルが生成されない（原因：ターン1の仕組み）こと、また生成パスが固定（`~/.openclaw/episodes/main`）になる問題などがあった。
> **今回**: 
> 1. **ソースコードの変更（Workspace動的解決ロジック）**が加わりました。最新のコードをビルドしてからテストします。
> 2. **連続した2ターン以上** の対話を行い、かつ **トピックを急変** させることで Surprise スコアを閾値をまたがせ、`ai.ingest` によって正しく `~/.openclaw/workspace-keruvim/episodes` にファイルが生成されることを確実にする。

---

## あなたへの役割

WSL Arch Linux 環境のオペレーターとして、以下のテストを実行してください。

---

## Step 0: コードのビルドと完全クリーンアップ

今回、ソースコード（`index.ts`）に手を加加えた最新ビルドを適用済みです。
さらに、前回のGatewayポート競合（`Port 18789 is already in use`）を防ぐため、完全にプロセスを落とします。

```bash
# ⚠️ 注意: TypeScriptのビルドはWindows側で完了済みであり、ここで WSL 側から `npm run build:ts` をするとファイル破損が起きる現象が確認されたため、今回はビルドコマンドを記載していません。

# 既存の Gateway 停止 (正当な手順)
openclaw gateway stop
# 残っていれば強制終了
pkill -f "openclaw gateway run"

# 前回ログをクリア
> /tmp/gateway-r5.log
> /tmp/episodic-core.log
echo "Logs cleared"
```

---

## Step 1: Gateway 起動と Workspace 解決確認

```bash
# Gateway を --verbose でバックグラウンド起動
GEMINI_API_KEY="<your_api_key>" openclaw gateway run --verbose 2>&1 | tee /tmp/gateway-r5.log &
GW_PID=$!
sleep 5
```

### 検証ポイント 📍
以下のログから、エージェント（今回は`keruvim`でテスト予定）のワークスペースが正しく解決されたか確認してください。

```bash
grep "Resolved workspace dir" /tmp/gateway-r5.log
```
**期待されるログ例**:
`[Episodic Memory] Resolved workspace dir: /root/.openclaw/workspace-keruvim/episodes` (または `workspace-main` からなど)

---

## Step 2: ターン 1 送信（トピック A）

まず最初のターンを送ります。この段階では `ai.ingest` は発動しません。
今回は使用エージェントを `--agent keruvim` で統一します。

```bash
openclaw agent --agent keruvim -m "コーヒーの美味しい淹れ方について、おすすめの豆の種類と一緒に教えてください。"
sleep 10
```

### 検証ポイント 📍
- ゴーサイドアでのエラー（ソケット切断など）がないことだけ確認。

---

## Step 3: ターン 2 送信（トピック B: 急変）

ここが本番です。直前の「コーヒー」の話題から、全く関係のない「量子力学」の話に急変させます。これにより、内部セグメンターの Surprise スコアが上がり、直前のコーヒーの話がエピソードとして `ai.ingest` されるはずです。

```bash
openclaw agent --agent keruvim -m "ところで話題が変わりますが、量子コンピュータの最新のアルゴリズム（ショアのアルゴリズムなど）の暗号解読への影響を解説してください。"
sleep 15  # Ingest処理に少し時間がかかるので長めに待機
```

### 検証ポイント 📍
以下のログから、Surpriseの計算とingestが発動したか確認してください。

```bash
# Surpriseスコアの計算が行われたか（TS側）
grep "Calculated surprise" /tmp/gateway-r5.log

# 閾値を超えたか（TS側）
grep "Surprise threshold exceeded" /tmp/gateway-r5.log

# Go側で ai.surprise と ai.ingest メソッドが呼ばれたか
cat /tmp/episodic-core.log | grep -E "ai.surprise|ai.ingest"
```

---

## Step 4: episodes/ ディレクトリの確認

実際に Markdown ファイルが生成されたか確認します。
（Step 1のログで出力された `Resolved workspace dir:` のパス配下を探します）

```bash
# 年・月・日のディレクトリを探す（例：workspace-keruvim想定）
find ~/.openclaw/workspace-keruvim/episodes/episodes/ -type f -name "*.md" || find ~/.openclaw/workspace/episodes/episodes/ -type f -name "*.md"

# 見つかった最新のファイルの中身を表示
ls -lt ~/.openclaw/workspace*/episodes/episodes/*/*/*/*.md | head -1 | awk '{print $9}' | xargs cat
```

---

## 全体確認チェックリスト

| # | 確認項目 | 期待値 | 結果 |
|---|---|---|---|
| 1 | `Resolved workspace dir` ログ | `~/.openclaw/workspace-...` な適切なパスを含むこと | |
| 2 | `ai.surprise` は呼ばれたか | 2ターン目送信後に1回以上呼ばれる | |
| 3 | `ai.ingest` は呼ばれたか | ログに出力あり | |
| 4 | `.md` ファイルの生成 | `episodes/YYYY/MM/DD/xxxx.md` が適切なフォルダに生成された | |
| 5 | ファイルの中身 | トピックA (コーヒー) の内容が含まれている | |

---

## レポート形式

テスト結果を以下の形式で報告してください。

```markdown
## Phase 5.5 Round 5 テスト結果

### 環境
- WSL バージョン:
- openclaw バージョン:

### 各ステップの結果
- Step 0 (ビルド・停止): ✅/❌
- Step 1 (Gateway 起動 & Workspaceログ):
  - 出力された Workspace Dir: 
- Step 2 (ターン 1 送信):
  - エラーあり/なし:
- Step 3 (ターン 2 送信 / Ingest発動):
  - Calculated surprise スコア: (ログから抽出)
  - ai.surprise 呼び出し: あり/なし
  - ai.ingest 呼び出し: あり/なし
- Step 4 (episodes ファイル):
  - 生成されたファイルパス:
  - そのファイルの中身（cat 結果）:

### 結論
Phase 5.5 ステータス: ✅ COMPLETE / 🔴 INCOMPLETE
```
