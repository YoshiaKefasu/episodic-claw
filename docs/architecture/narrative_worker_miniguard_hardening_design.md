# NarrativeWorker MiniGuard Hardening 設計（v0.4.28候補）

> Date: 2026-04-23  
> Scope: `src/narrative-worker.ts` を中心に、**軽量・最小差分**で品質ガードを強化する。  
> Target: OpenRouter free系で発生する「短すぎる/抽象すぎる narrative」の流入をさらに抑止。

---

## 0. 結論（先に要点）

この設計を入れると、現行 v0.4.27b に対して NarrativeWorker の頑丈さは **+15〜25%** 改善見込み。  
（ローカル品質ゲート精度・再試行効率・観測性の3軸で改善）

Guardrails AI（Python sidecar）を導入すればさらに伸びるが、まずは TS 単体の MiniGuard 拡張で費用対効果が高い。

---

## 1. 実読ベースの現状確認（Source Evidence）

### Evidence A — 既に強い多段ゲートは存在
- `src/narrative-worker.ts:667-696`
  - Compression / Echo / Format を実行。
- `src/narrative-worker.ts:698-736`
  - Generic phrase gate + Anchor coverage gate を実行（条件付き）。

### Evidence B — Content gate が常時有効ではない経路がある
- `src/narrative-worker.ts:587-605`
  - `primary===openrouter/free` かつ `GEMINI_API_KEY` なしの場合、`contentGateEnabled=false`。
  - つまり内容系 gate が一部スキップされる。

### Evidence C — 下限がまだ緩く、短文通過の余地がある
- `src/narrative-worker.ts:61-63`
  - `MIN_NARRATIVE_TOKENS=10`, `MIN_COMPRESSION_RATIO=0.01`。
  - 入力が短いケースで、情報密度の低い文が通る可能性が残る。

### Evidence D — 既存テスト資産はあるが、意味被覆は限定的
- `test_narrative_quality_gate.ts:20-260`
  - compression/echo/format中心。
  - 「原文イベント被覆の最低保証（意味カバレッジ）」の運用検証は薄い。

---

## 2. 目的 / 非目的

## 2.1 目的
1. one-liner / 抽象テンプレ文の保存率を下げる。
2. 失敗時に「何が悪かったか」を機械判定で返し、次試行を改善する。
3. 既存の retry phase 設計（OpenRouter → Gemini handoff）を壊さず、最小差分で導入する。

## 2.2 非目的
- Python sidecar（Guardrails AI）導入
- 大規模な provider routing 再設計
- Go sidecar への新RPC追加

---

## 3. 設計方針（KISS / YAGNI）

### 3.1 採用方針
- **TSのみ**で完結
- 既存 `applyQualityGates()` を拡張し、別パイプラインを増やさない
- `contentGateEnabled` フラグ設計を尊重（回帰防止）

### 3.2 見送り方針
- 新言語導入（Python）
- 重い依存（外部バリデータ基盤）

---

## 4. 提案アーキテクチャ（MiniGuard v2）

```
LeaseNext
  -> generate (model phase)
    -> sanitizeNarrativeOutput
    -> applyQualityGates_v2
        G1 Compression
        G2 Echo
        G3 Format
        G3b Generic-template body scan
        G4 Anchor coverage
        G5 NEW: Min sentence gate
        G6 NEW: Min CJK-char / min-word floor
        G7 NEW: Corrective-feedback classifier
    -> pass ? saveNarrative : retry/handoff
```

ポイントは **G5/G6/G7の追加**。既存G1〜G4を活かしたまま、弱点だけ塞ぐ。

---

## 5. 変更仕様（詳細）

## 5.1 Gate追加（最小差分）

### Gate 5: Minimum Sentence Gate（新規）
- 条件（デフォルト）:
  - CJK主体: 句点ベースで `>= 3` 文
  - Latin主体: sentence delimiter で `>= 4` 文
- Reject reason:
  - `narrative-content: too-few-sentences`

### Gate 6: Minimum Content Floor（新規）
- 条件（デフォルト）:
  - CJK: 文字数 `>= 120`
  - Latin: 単語数 `>= 80`
- Reject reason:
  - `narrative-content: too-short-content-floor`

> 注: 既存 `MIN_NARRATIVE_TOKENS=10` は互換維持。Gate 6 はその上位条件として作用。

### Gate 7: Corrective Feedback Classifier（新規）
- 失敗理由を分類し、次試行の prompt 末尾に短い補正指示を付加。
- 例:
  - `too-short-content-floor` → 「最低3段落・具体例3つ」
  - `generic-template` → 「一般論禁止、ログ固有語を明示」
  - `low-anchor-coverage` → 「ファイル名/コマンド/数値を3件以上含める」

---

## 5.2 既存ロジックとの整合

### Retry / Handoff
- `contentGateEnabled=true` の phase だけ content系 reject をカウントし、既存早期handoffを維持。  
  （`src/narrative-worker.ts:743-784`）

### `contentGateEnabled=false` phase
- 回帰回避のため、既存方針を維持。
- ただし **G5/G6 は soft-warn のみ記録**（rejectしない）。
  - 目的: 既存保存率を落とさず、改善余地を可視化。

---

## 5.3 設定項目（`config.ts` 拡張案）

`EpisodicPluginConfig` に以下を追加（全部 optional、既存デフォルトで安全に稼働）:

```ts
narrativeGuardMinSentences?: number;      // default: 3 (CJK), 4 (Latin)
narrativeGuardMinCjkChars?: number;       // default: 120
narrativeGuardMinLatinWords?: number;     // default: 80
narrativeGuardEnableCorrectivePrompt?: boolean; // default: true
```

ロード時は clamp を適用し、異常値はデフォルトへフォールバック。

---

## 6. ログ・観測設計

## 6.1 追加ログ（JSON推奨）

- event: `narrative-quality-reject`
  - fields: `itemId`, `phase`, `attempt`, `reason`, `isContentGate`, `contentGateEnabled`

- event: `narrative-quality-softwarn`
  - fields: `itemId`, `phase`, `reason`, `metric`（chars/sentences/words）

- event: `narrative-corrective-feedback-applied`
  - fields: `itemId`, `reasonClass`, `feedbackTemplateId`

## 6.2 運用KPI

1. `narrative-content:*` reject率
2. phase別 pass率（primary / fallback）
3. 保存済み本文の短文率（chars<120）
4. 早期handoff発火率

---

## 7. テスト計画

## 7.1 Unit（追加）

対象: `test_narrative_quality_gate.ts`

1. `too-few-sentences` 判定（JP/EN別）
2. `too-short-content-floor` 判定（JP/EN別）
3. corrective reason classifier の分岐
4. `contentGateEnabled=false` 時に soft-warn になること

## 7.2 Regression

1. 既存 pass ケース（valid narrative）は pass 維持
2. 既存 reject ケース（emoji/list/COT）は reject 維持
3. Gemini fallback の最終保存経路が壊れないこと

## 7.3 Runtime smoke

1. `npm run build:ts`
2. `npm test`
3. 30ターン程度の運用ログで reject reason 分布を確認

---

## 8. ロールアウト手順

### Phase A（観測優先）
- Gate 5/6 を **soft-warn only** で先行投入（1日）
- 実ログ分布を取得

### Phase B（本適用）
- `contentGateEnabled=true` phase に Gate 5/6 を hard reject で有効化
- corrective feedback をON

### Phase C（閾値調整）
- 過検知が高い場合のみ閾値を微調整

---

## 9. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 過検知で保存率低下 | 中 | Phase A で soft-warn観測してから hard化 |
| CJK/Latin混在テキスト誤判定 | 中 | 言語判定を厳密化せず、両基準のゆるい方を採用 |
| retry増加で遅延 | 低〜中 | 既存 early handoff を活用し、max retryは据え置き |

---

## 10. 受け入れ基準（AC）

1. AC-1: Gate 5/6/7 が実装される（既存ゲートを壊さない）
2. AC-2: `contentGateEnabled=false` phase で item-loss を起こさない
3. AC-3: reject / softwarn / corrective-feedback ログが観測できる
4. AC-4: `npm run build:ts` PASS
5. AC-5: `npm test` PASS
6. AC-6: 1日運用で短文抽象 narrative の混入率が有意に低下

---

## 11. Guardrails AI 比較（設計判断）

| 観点 | MiniGuard v2（本設計） | Guardrails AI sidecar |
|---|---|---|
| 導入速度 | 速い（現行TS内） | 中（Python追加） |
| 依存 | ほぼ増えない | 新規ランタイム追加 |
| 保守性 | 高い（単一repo） | 中（多言語運用） |
| 表現力 | 中（必要十分） | 高（高度validator） |

最適解: **まず MiniGuard v2 を入れる。必要なら次段で Guardrails 化。**

---

## 12. 実装対象ファイル（予定）

- `src/narrative-worker.ts`（主変更）
- `src/config.ts`（設定ロード追加）
- `src/types.ts`（config型追加）
- `test_narrative_quality_gate.ts`（テスト追加）

---

## 13. 補足（この設計が向いている理由）

いまの codebase はすでに quality gate の土台が完成している。  
だから「新システムを作る」より、既存の `applyQualityGates` に短文対策と corrective feedback を差し込む方が、
速度・安全性・可読性のバランスが最も良い。

---

## 14. Guardrails AI からの部分移植（"部分的にパクる" 範囲）

この章は、Guardrails AI の実装思想を MiniGuard に移植する具体設計。

### 14.1 移植する要素（採用）

1. **Validator Chain 実行モデル**
   - Guardrails の `Guard().use(...)` と同様に、複数バリデータを順序実行する。
   - MiniGuard 側は既存 `applyQualityGates()` を分解し、`validators[]` で実行。

2. **on_fail アクション分岐**
   - Guardrails の `OnFailAction` 発想を移植し、以下を採用:
   - `REASK` / `HANDOFF` / `SOFTWARN` / `FAIL`

3. **理由別 Re-ask（補正再試行）**
   - 失敗理由に応じて補正指示を変える。
   - 例: `too-short-content-floor` は長さ強制、`low-anchor-coverage` は具体アンカー強制。

4. **Validation Trace 出力**
   - 各バリデータの pass/fail を JSON ログで残す。
   - 運用時に「どの gate が効いているか」を可視化。

### 14.2 移植しない要素（不採用）

1. Python sidecar / Flask server
2. Guardrails Hub 依存（外部validator配布）
3. スキーマ駆動の全面置換（現行 NarrativeWorker を保持）

---

## 15. ライセンス対応方針（Apache-2.0）

Guardrails 本家は Apache-2.0。したがって、**コード断片を直接流用する場合**は次を必須とする。

1. 由来をコメントで明記（source URL + 変更した旨）
2. リポジトリ配布物に Apache-2.0 ライセンス文言を保持
3. 必要時は NOTICE 相当の追記

### 本設計での安全運用

- 基本は **挙動/設計思想のみ移植**（クリーンルーム実装）
- どうしてもコードを借りる場合は「1関数単位」で出典明記

---

## 16. 具体インターフェース案（TypeScript）

```ts
type OnFailAction = "REASK" | "HANDOFF" | "SOFTWARN" | "FAIL";

type GuardDecision = {
  pass: boolean;
  reason: string;
  onFail: OnFailAction;
  isContentGate: boolean;
  feedbackHint?: string;
};

type GuardValidator = (ctx: {
  text: string;
  rawText: string;
  phaseLabel: string;
  contentGateEnabled: boolean;
}) => GuardDecision;

type GuardRunResult = {
  pass: boolean;
  decision?: GuardDecision;
};
```

`applyQualityGates()` は最終的にこの `GuardRunResult` を返し、
既存 `contentRejectCount` / early handoff ロジック（`src/narrative-worker.ts:743-784`）へ接続する。

---

## 17. 実装タスク追記（v0.4.28）

1. `src/narrative-worker.ts`
   - `GuardValidator[]` 実行器を追加
   - 既存 G1〜G4 を validator 化
   - G5/G6/G7（短文床・文数床・補正フィードバック）を追加

2. `src/config.ts` / `src/types.ts`
   - Guard 関連設定の追加と clamp

3. `test_narrative_quality_gate.ts`
   - validator chain 実行順テスト
   - on_fail 分岐テスト（REASK/HANDOFF/SOFTWARN）
   - corrective feedback 文面選択テスト

4. ドキュメント
   - 本ファイルを仕様ソースとして維持
   - 参考スナップショットは `docs/references/guardrails_ai_partial_transplant_notes_2026-04-23.md` を参照

---

## 18. 言語出力ガード（Guardrails CorrectLanguage 思想の部分移植）

ユーザー要求:
> `openclaw.plugin.json` の `configSchema` で指定した言語に、Narrative 出力を確実に合わせる。

### 18.1 背景エビデンス

1. Guardrails Hub `CorrectLanguage` は **expected language + threshold + on_fail** で出力言語を検証する設計。
   - 参照: `https://guardrailsai.com/hub/validator/scb-10x/correct_language`
2. `correct_language_validator` README でも同じパラメータ設計（`expected_language_iso`, `threshold`, `on_fail`）。
   - 参照: `https://github.com/scb-10x/correct_language_validator`
3. 現行 `openclaw.plugin.json` には narrative 言語を強制する `configSchema` キーが未定義。
   - `openclaw.plugin.json:22-239`
4. リポジトリ内には軽量言語判定器 `src/lang-detect.ts`（`eld`ベース）が既にある。
   - `src/lang-detect.ts:1-56`

---

### 18.2 設計方針

- Python / HuggingFace 翻訳モデルは導入しない（重い依存を回避）。
- Guardrails の「検証 + on_fail」思想だけを移植。
- まずは **strict reject/reask** を中心に実装し、誤言語保存を防ぐ。

---

### 18.3 `configSchema` 追加仕様（提案）

`openclaw.plugin.json` の `configSchema.properties` に以下を追加:

```json
"narrativeExpectedLanguage": {
  "type": "string",
  "enum": ["auto", "ja", "en", "zh", "ko", "id"],
  "default": "auto",
  "description": "Expected output language for narrative generation. When set to a specific ISO code, outputs in other languages are rejected and retried."
},
"narrativeLanguageThreshold": {
  "type": "number",
  "minimum": 0,
  "maximum": 1,
  "default": 0.75,
  "description": "Minimum confidence required to accept detected language match."
},
"narrativeLanguageOnFail": {
  "type": "string",
  "enum": ["reask", "handoff", "softwarn", "exception"],
  "default": "reask",
  "description": "Action when generated narrative language does not match expected language."
}
```

補足:
- `auto` は現行挙動（強制なし）と互換。
- `reask` をデフォルトにし、保存前で再試行して誤言語を落とす。

---

### 18.4 型 / 設定ロード拡張

`src/types.ts` に追加:

```ts
narrativeExpectedLanguage?: "auto" | "ja" | "en" | "zh" | "ko" | "id";
narrativeLanguageThreshold?: number;
narrativeLanguageOnFail?: "reask" | "handoff" | "softwarn" | "exception";
```

`src/config.ts` で clamp / default:
- `narrativeExpectedLanguage`: default `"auto"`
- `narrativeLanguageThreshold`: `clampUnitInterval(..., 0.75)`
- `narrativeLanguageOnFail`: 不正値は `"reask"`

---

### 18.5 NarrativeWorker 組み込み位置

`applyQualityGates()` に **Language Gate（G0）** を追加（最初に評価）。

実行順:
1. G0 Language（新規）
2. G1 Compression
3. G2 Echo
4. G3 Format
5. G3b Generic Template
6. G4 Anchor Coverage
7. G5/G6/G7（本設計の追加）

理由:
- 明確な誤言語は早期に落とした方がトークン無駄が少ない。

---

### 18.6 Language Gate 判定ロジック（軽量）

1. `narrativeExpectedLanguage === "auto"` → PASS。
2. `detectLanguage(text)` 実行（`src/lang-detect.ts`）。
3. `detected !== expected` の場合 on_fail を適用。
4. `unknown` の場合:
   - 文字数が短すぎるなら `reask`（判定不安定）
   - 十分長いのに `unknown` なら `handoff` 可能

> 注: 現行 `detectLanguage` は confidence を返さない。  
> v0.4.28 では `detectLanguageDetailed(): { lang, confidence }` を追加し、`narrativeLanguageThreshold` を有効化する。

---

### 18.7 on_fail マッピング（Guardrails発想）

| on_fail | 動作 | 保存可否 |
|---|---|---|
| `reask` | 同phaseで補正指示付き再試行（"Output ONLY in <lang>") | 不可 |
| `handoff` | phase早期終了して次phaseへ | 不可 |
| `softwarn` | 警告のみ記録して通す（移行期間用） | 可 |
| `exception` | 例外扱いで `cacheRetry` へ | 不可 |

推奨:
- 本番は `reask`。
- 初期導入日は `softwarn` で観測してから `reask` へ切替。

---

### 18.8 補正再試行メッセージ（テンプレ）

`narrativeLanguageOnFail=reask` 時に、再試行用プロンプト末尾へ追加:

```text
Language correction requirement:
- Your previous output language was detected as "{detected}".
- Rewrite the full narrative strictly in "{expected}".
- Keep all technical anchors and factual details unchanged.
```

---

### 18.9 ログ仕様

追加ログ:
- `event: narrative-language-guard`
  - `expected`, `detected`, `confidence`, `onFail`, `phase`, `attempt`, `itemId`
- `event: narrative-language-reask`
  - `expected`, `detected`, `itemId`

KPI:
1. language mismatch 率
2. language reask 後の回復率
3. 誤言語保存率（最終保存時）

---

### 18.10 テスト計画（追加）

1. `expected=ja`, output=en → `reask` 発火
2. `expected=en`, output=ja → `reask` 発火
3. `expected=auto` → 常にPASS
4. `onFail=softwarn` で保存継続
5. `onFail=handoff` で phase 切替
6. `unknown` 判定時の分岐（短文/長文）

---

### 18.11 リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 短文で言語判定が不安定 | 中 | `unknown` は短文時 reask、長文化後に再判定 |
| CJK混在文の誤判定 | 中 | 初期は `softwarn` で観測、閾値調整後に `reask` 固定 |
| retry増加 | 低〜中 | mismatch時のみ発火、最大再試行は既存上限内 |

---

### 18.12 受け入れ基準（Language Guard）

1. `configSchema` で指定した言語が runtime に反映される
2. 期待言語 mismatch で保存前に確実にガードが発火する
3. `softwarn` / `reask` / `handoff` の分岐がテストで保証される
4. 1日運用で誤言語保存率が有意に低下する
