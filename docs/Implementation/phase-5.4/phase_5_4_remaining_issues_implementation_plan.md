# Episodic-Claw プラグインを WSL OpenClaw にインストールする計画

公式ドキュメント（[docs.openclaw.ai/plugin](https://docs.openclaw.ai/plugin)）を精査した結果、前回の試行で失敗した根本原因と正しい手順が判明しました。

## 前回の失敗原因

1. **エントリーポイントの形式が間違っていた** — OpenClaw は `jiti` で **TypeScript ファイルを直接ロード** する。[dist/index.js](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/dist/index.js) ではなく [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/index.ts) が必要
2. **[package.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/package.json) に `openclaw.extensions` フィールドがなかった** — ドキュメントに「[package.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/package.json) must include `openclaw.extensions` with one or more entry files」と明記
3. **[openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json) のスキーマ不一致** — [id](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#220-223) と `kind` フィールドが必須（stock plugins が [id](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#220-223) + `kind` を使用）
4. **配置先ディレクトリが間違っていた** — `/usr/lib/...` ではなく `~/.openclaw/extensions/<id>/` が正しいローカルパス
5. **`plugins.slots` の設定で context engine / memory スロットを指定していなかった**

## 必要な変更

### 1. [package.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/package.json) に `openclaw.extensions` を追加
```json
{
  "openclaw": {
    "extensions": ["src/index.ts"]
  }
}
```

### 2. [openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json) を正しい形式に修正
```json
{
  "id": "episodic-claw",
  "kind": "memory",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
```

### 3. ルートに [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/index.ts) を作成（エントリーポイント）

`~/.openclaw/extensions/episodic-claw/index.ts` が存在する必要がある。  
既存の [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) をそのまま利用するか、ルートの [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/index.ts) から re-export する。

### 4. WSL へのインストール方法

公式コマンドを使用：
```bash
openclaw plugins install "/mnt/d/GitHub/OpenClaw Related Repos/episodic-claw"
```

このコマンドは内部的に `npm pack` → `~/.openclaw/extensions/<id>/` に展開 → config に自動登録を行う。

> [!IMPORTANT]
> もし `openclaw plugins install` がローカルパスでエラーになる場合は、手動コピー + config 設定で代替：
> ```bash
> cp -r "/mnt/d/GitHub/OpenClaw Related Repos/episodic-claw" ~/.openclaw/extensions/episodic-claw
> ```
> そして `openclaw.json` に手動で `plugins.entries` と `plugins.slots` を追加。

### 5. `openclaw.json` の設定

```json
{
  "plugins": {
    "slots": {
      "memory": "episodic-claw",
      "contextEngine": "episodic-claw"
    },
    "entries": {
      "episodic-claw": {
        "enabled": true
      }
    }
  }
}
```

## 実行手順

| Step | 内容 |
|---|---|
| 1 | [package.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/package.json) に `openclaw.extensions` フィールドを追加 |
| 2 | [openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json) を [id](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#220-223) + `kind` + `configSchema` 形式に修正 |
| 3 | ルートに [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/index.ts) エントリーポイントを確保 |
| 4 | WSLで `openclaw plugins install ./` を実行 |
| 5 | 失敗時は手動 `cp -r` + `openclaw.json` 設定 |
| 6 | `openclaw plugins list` で discovery 確認 |
| 7 | `openclaw plugins doctor` で PASS 確認 |

## Verification Plan

```bash
openclaw plugins list | grep episodic
openclaw plugins doctor
```
