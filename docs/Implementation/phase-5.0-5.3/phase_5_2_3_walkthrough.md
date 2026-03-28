# OpenClaw WSL プラグイン導入完了

WSL環境（Arch Linux）のOpenClawに `episodic-claw` プラグインを正常にインストールし、信頼設定を行いました。

## 実施内容

1. **プラグイン・メタデータの修正**:
   - [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/index.ts) の `export default` を関数からメタデータオブジェクト形式に修正。
   - [registerTool](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#12-13) の第2引数を `{ names: ["..."] }` の配列形式に修正。
   - ツール定義オブジェクトに `name` フィールドを追加。
2. **WSL環境へのデプロイ**:
   - `~/.openclaw/extensions/episodic-claw` への手動コピーと権限設定（755/644）。
3. **OpenClaw設定の更新 (`openclaw.json`)**:
   - `plugins.allow` に `episodic-claw` を追加し、信頼済みとしてマーク。
   - `plugins.load.paths` にディレクトリを追加し、未インストール警告を解消。
   - `memory` および `contextEngine` スロットにプラグインをアサイン。

## 検証結果

`openclaw plugins list` の実行結果：

```text
│ Episodic     │ episodic │ loaded   │ global:episodic-claw/index.ts                                       │ 1.0.0     │
│ Memory       │ -claw    │          │ D0/D1 hierarchical contextual memory and event stream for OpenClaw. │           │
└──────────────┴──────────┴──────────┴─────────────────────────────────────────────────────────────────────┴───────────┘
```

> [!NOTE]
> `loaded without install/load-path provenance` の警告は解消されました。

## 次のステップ
- [ ] `openclaw chat` または `openclaw inbox` での実際の動作確認。
- [ ] エピソード生成（D0）と要約（D1）の自動サイクル確認。
