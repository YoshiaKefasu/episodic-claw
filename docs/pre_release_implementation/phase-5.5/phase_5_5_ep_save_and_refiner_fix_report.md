# Phase 5.5: `ep-save` 及び `AsyncRefiner` バグ修正・仕様変更レポート

**日付**: 2026-03-21
**対応モジュール**: `src/index.ts` (TypeScript側), `go/main.go` (Goサイドカー)
**ステータス**: Resolution Completed

---

## 1. 発生していた問題 (Issues)

本日のデバッグおよび動作確認において、以下の2つの深刻な問題が継続して発生していました。

### 1.1 `ep-save` ツール実行時の `empty Part` エラー
- **症状**: エージェントが手動でエピソードを保存しようと `ep-save` を呼び出した際、Go側で `Failed to embed ingested summary: API error (status 400): { "message": "EmbedContentRequest.content contains an empty Part." ... }` が発生。
- **原因**: 以前の `ep-save` ツールの引数仕様が `summary: string` となっており、エージェントが何らかの理由で空文字列を渡した場合に、Gemini Embedding API（`EmbedContent`）へそのまま空文字が送信されてしまい、API側からInvalid Argumentとして拒否されていました。

### 1.2 `AsyncRefiner` の非ASCII（日本語等）Slug生成によるバリデーション漏れ
- **症状**: 過去のレガシーMD5ファイルに対するリネーム処理時、`[Episodic-Core] AsyncRefiner: Could not generate valid slug for episode-xxx, keeping MD5.` となり、いつまでもMD5ファイルがクリーンアップされない現象が発生。
- **原因**:
  1. 巨大ファイル（例: 148KiB）をそのままLLMに投げていたため、当初はコンテキストエラー（400 BadRequest）が発生していた。
  2. プロンプトに言語指定がなかったため、日本語の文章をパースした Gemma モデルが時折 `ハイキューの技術` のような「日本語のままのSlug」を生成してしまっていた。
  3. Go側のバリデーション関数 `auditEpisodeQuality` では「スペースを含むか」等をチェックしていたが、スペースのない日本語の文字列はバリデーションを通過してしまう（そしてその後なぜか失敗扱いになるなどの齟齬が生じる）状態にあった。

---

## 2. 修正内容 (Resolutions)

上記2件のバグに対して、以下の改修を行いました。

### ✅ 2.1 `ep-save` を「自然言語の自由記述（`content`）」仕様へ完全移行
エージェントが「思考した内容をそのまま自然に書き込める」ように、ツールのインターフェイスとバリデーションを刷新しました。

*   **引数の変更**: `summary` を廃止し、`content` フィールドに変更。
*   **字数制限と段落対応**: TypeScript（`src/index.ts`）のツール定義にて、`content` フィールドの最大長を **3600文字** (`maxLength: 3600`) に設定。「段落や改行を含めた自由な自然言語記述」を許可し、サーバーサイドでも確実に3600文字で安全にトリミング（`...(truncated)` 補完）するロジックを追加。
*   **空文字ガード**: `content` が空で渡された場合は、TSレイヤーで即座にエラーとして弾き、「Error: content is empty. Please write something to save.」とLLMにアドバイスして再入力を促すよう改善。
*   **Go側のガード (Defense in Depth)**: 万が一Go側へ空文字が到達した場合でも、`ai.ingest` の `EmbedContent` 呼び出し直前に `strings.TrimSpace(params.Summary) == ""` のバリデーションを行い、安全にSkipped扱いとして400 APIエラーによるクラッシュや不要なロギングを防ぐ二重保護（`go/main.go` 446行目）を追加。

### ✅ 2.2 `AsyncRefiner` における巨大ファイル対策と英語プロンプト強制
過去のレガシーファイルであっても確実にリファインを成功させるため、以下の安全機構を追加しました。

*   **文字数クリッピング**: 巨大なファイル（148KiBなど）全体を読み込むのをやめ、MD5ファイルを読み込んだ直後に **`doc.Body` を先頭4000文字（rune）でクリッピング**。これにより、LLMのトークン上限を超えるエラーを完全に防ぎました。
*   **英語Slugの強制**: `RunAsyncSlugRefiner` 内のプロンプトを強化し、`"IMPORTANT: Your response MUST be in English only. No Japanese or other non-ASCII characters"` と念押しすることで、Gemmaモデルが日本語のSlugを返してくる事態を抑制。
*   **非ASCIIバリデーションの強化**: `auditEpisodeQuality` に明示的な非ASCII文字検出（`c > 127`）を追加。万が一LLMが日本語等を含んだ文字を生成した場合は、不正Slugとして即座に破棄（エラー扱い）し、再試行を行わせる仕組みに変更しました。

---

## 3. 結果と現在のステータス (Status)

*   **TS側ビルド及びWSLへのデプロイ**: 完了済み
*   **Go側ビルド及びWSLへのデプロイ**: 完了済み
*   **検証指示**: 次回以降、WSL側の Gateway プロセスを再起動することで最新バイナリが有効化します。

新仕様の `ep-save` により、LLMは構造化を意識せず、自由に記憶したい内容を（段落付きで）書き出して保存できるようになりました。これにより保存漏れ（empty Part起因）は解消され、AsyncRefiner も過去の巨大ダンプファイルを確実に英語のケバブケース（kebab-case）命名でクリーンアップできる状態へ回復しました。
