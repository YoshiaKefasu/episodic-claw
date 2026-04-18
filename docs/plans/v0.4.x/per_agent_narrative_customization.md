# 実装プラン: Per-Agent Narrative Customization（エージェント別物語化カスタマイズ）

---

## 0. このドキュメントの位置づけ

- 目的: OpenClaw の複数エージェント（A, B, C）がそれぞれ別々の設定・プロンプト・一人称・言語で物語化できるようにする。あわせて、チャンク最初のメッセージのタイムスタンプに基づく出力プライミングと、rawText への role ラベル付与を実装する
- 深刻度: **MEDIUM-HIGH** — 現状は全エージェントが同一プロンプト・同一一人称で物語化される。Episodic-Claw の名前（エピソード記憶）に照らしても、一人称主観視点の方が記憶として馴染みやすい
- 発見元: v0.4.17/v0.4.18 の物語化品質改善協議（2026-04-17〜04-20）。Google Gemma 公式推奨の Few-Shot + 出力プライミング戦略に基づく
- 前提プラン: [v0.4.17](v0.4.17_narrative_output_control_overhaul.md)（contract-first プロンプト）+ [v0.4.18](v0.4.18_narrative_format_gate_false_positive_fixes.md)（偽陽性修正）
- ソースコード検証: **済**（narrative-worker.ts, config.ts, types.ts, narrative-pool.ts, narrative-queue.ts, segmenter.ts, openclaw.plugin.json, index.ts）
- 実装時期: **後程**（v0.4.19 以降の適切なタイミングで実装）

---

## 1. 問題定義

### 1.1 現状のアーキテクチャ

```
openclaw.json
├── agents.list: [{ id: "kasou" }, { id: "main" }, { id: "dennouaibou" }]
└── episodic-claw.config:
    ├── narrativeSystemPrompt: "/path/to/one_prompt.md"     ← 全エージェント共通
    ├── narrativeUserPromptTemplate: "/path/to/one_user.md" ← 全エージェント共通
    └── (一人称、言語等のエージェント個別設定なし)
```

`NarrativeWorker` は単一の `EpisodicPluginConfig` を使い回すため、3つのエージェントが全く同じプロンプト・同じ一人称・同じ言語で物語化される。

### 1.2 4つの課題

| # | 課題 | 現状 | 期待される動作 |
|---|------|------|----------------|
| 1 | **全エージェント同一プロンプト** | Kasou も Main も DennouAibou も同じ .md ファイルで物語化 | 各エージェントが独自の system/user prompt を持てる |
| 2 | **一人称のバリエーションなし** | 全員「彼は〜した」三人称、または固定の一人称 | Kasou=僕、Main=私、DennouAibou=俺、英語=I — 自動調整 |
| 3 | **タイムスタンプが出力に反映されない** | rawText に日付が含まれず、モデルが「いつ起きたか」を推測 | チャンク最初のメッセージのタイムスタンプ → 出力プライミング「2026年4月16日の7時に——僕は」 |
| 4 | **rawText に role が含まれない** | `extractText(m.content)` だけで `m.role` が失われる | `user: テスト送るね\nassistant: バッチリ聞こえてるぜ` のように role ラベル付与 |

### 1.3 課題間の依存関係

```
課題4 (role ラベル) ─→ 課題2 (一人称) の前提
                      「assistant: ...」の行 = エージェント自身の発言 → 一人称の対象が特定できる

課題3 (タイムスタンプ) ─→ 課題2 (一人称) と統合
                      「2026年4月16日の7時に——僕は」= タイムスタンプ + 一人称 の出力プライミング

課題1 (per-agent prompt) ─→ 課題2 (一人称) の設定場所
                      エージェント別設定の中に firstPersonPronoun を含める
```

**実装順序**: 4 → 3 → 1+2（統合）

---

## 2. 課題4: rawText への role ラベル付与

### 2.1 現状のデータフロー

```
Message { role, content, timestamp? }
    ↓ narrative-pool.ts buildFlushItem()
    .map(m => extractText(m.content))    ← role も timestamp も捨てられる
    .join("\n")
    ↓
rawText: "テスト送るね\nバッチリ聞こえてるぜ\nバグを見つけた"
         → 「誰が言ったか」が全く分からない
```

### 2.2 変更内容

`narrative-pool.ts` の `buildFlushItem()` で、`extractText(m.content)` の代わりに `role: text` 形式のラベル付きテキストを生成する。

**現行**:
```typescript
private buildFlushItem(reason: PoolFlushItem["reason"], surprise: number, agentWs: string, agentId: string): PoolFlushItem {
  const rawText = this.buffer
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join("\n");
  // ...
}
```

**変更後**:
```typescript
private buildFlushItem(reason: PoolFlushItem["reason"], surprise: number, agentWs: string, agentId: string): PoolFlushItem {
  const rawText = this.buffer
    .map((m) => {
      const text = extractText(m.content);
      if (!text) return "";
      return `${m.role}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
  // ...
}
```

**出力例**:
```
user: テスト送るね
assistant: バッチリ聞こえてるぜ
user: バグを見つけた。segmentation faultだ
assistant: 修正します。原因はlambdaのnull参照ですね
user: ありがとう、マージしておく
```

### 2.3 影響範囲

role ラベルの追加により、以下が影響を受ける：

| コンポーネント | 影響 | 対応 |
|---|---|---|
| `checkEchoDetection()` | `user: ` / `assistant: ` プレフィクスがオウム返し検出に影響 | `MAX_ECHO_SCAN_CHARS` は5000文字のまま。role ラベルは短いプレフィクスなので、 whitespace collapse 後の照合には影響しない（1行あたり+10文字程度） |
| `sanitizeNarrativeOutput()` | `cotPrefixPat` が `user: Okay, let me...` にマッチしなくなる | Gate 2（CoT planning phrase）は先頭100文字を検査。`user: ` プレフィクスがあっても `Okay` は101文字目以降にずれる可能性あり。`firstChars` を150文字に拡張するか、プレフィクスをスキップする |
| `estimateTokens()` | rawText が+10文字/行増加 | 48Kトークン制限に対する影響は1%未満 |
| `checkNarrativeFormat()` | Gate 5 の `narrativeStartPat` が `user:` で始まる行に遭遇 | rawText は `<<<LOG>>>...<<<END_LOG>>>` の中に埋め込まれるため、物語出力自体には role ラベルが含まれない。影響なし |
| LLM への入力 | モデルが `user:` / `assistant:` ラベルを見る | **これは改善** — モデルが「誰が言ったか」を理解でき、一人称視点の構築に役立つ |

### 2.4 同一箇所の変更点: archiver.ts

`archiver.ts` L188 は既に role ラベル付きフォーマットを使用している：
```typescript
const rawText = unprocessed.map(m => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n");
```
→ `narrative-pool.ts` も同じフォーマットに統一する。`join("\n\n")` vs `join("\n")` の差異は、archiver が legacy path であるため意図的に残す。

### 2.5 checkEchoDetection / sanitizeNarrativeOutput の調整

role ラベル付与後、rawText の先頭が `user: ` になるため：

1. `checkEchoDetection()`: オウム返し検出は output と input の whitespace-collapse 後の照合。output に role ラベルは含まれない（モデルが物語として出力するため）ので、影響なし
2. `sanitizeNarrativeOutput()` の `cotPrefixPat`: モデルの出力（物語テキスト）に role ラベルは含まれないため、影響なし
3. `checkNarrativeFormat()` Gate 2: `firstChars = text.substring(0, 100)` は **物語出力** の先頭100文字。rawText に role ラベルがあっても、物語出力には含まれない。影響なし

**結論**: role ラベル付与による品質ゲートへの追加調整は不要。モデルが `user: ` / `assistant: ` ラベルを見て「誰が言ったか」を理解できるようになるだけで、出力形式は変わらない。

---

## 3. 課題3: タイムスタンプ由来の出力プライミング

### 3.1 現状

`Message { role, content, timestamp?: string }` に `timestamp` は存在するが、`buildFlushItem()` → `splitIntoChunks()` → `CacheQueueItem` の経路で失われる。

現在の `CacheQueueItem` が持つ時刻は `createdAt`（チャンク作成時刻）のみ。これは「最後の時刻」に見える。

### 3.2 変更内容

チャンクの**最初のメッセージ**のタイムスタンプを `firstMessageAt` として伝播させる。

#### 3.2.1 PoolFlushItem に firstMessageAt 追加

**types.ts**:
```typescript
export interface PoolFlushItem {
  messages: Message[];
  rawText: string;
  surprise: number;
  reason: "surprise-boundary" | "size-limit" | "force-flush";
  agentWs: string;
  agentId: string;
  firstMessageAt?: string;  // ← NEW: 最初のメッセージの ISO 8601 タイムスタンプ
}
```

#### 3.2.2 buildFlushItem() で firstMessageAt 取得

**narrative-pool.ts**:
```typescript
private buildFlushItem(reason: PoolFlushItem["reason"], surprise: number, agentWs: string, agentId: string): PoolFlushItem {
  const rawText = this.buffer
    .map((m) => {
      const text = extractText(m.content);
      if (!text) return "";
      return `${m.role}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");

  // ← NEW: 最初の timestamp 付きメッセージのタイムスタンプを取得
  const firstMessageAt = this.buffer.find(m => m.timestamp)?.timestamp;

  return {
    messages: [...this.buffer],
    rawText,
    surprise,
    reason,
    agentWs,
    agentId,
    firstMessageAt,  // ← NEW
  };
}
```

#### 3.2.3 CacheQueueItem に firstMessageAt 追加

**narrative-queue.ts**:
```typescript
export interface CacheQueueItem {
  // ... 既存フィールド ...
  firstMessageAt?: string;  // ← NEW: 最初のメッセージの ISO 8601 タイムスタンプ
}
```

`splitIntoChunks()` の各 `CacheQueueItem` 生成箇所に `firstMessageAt` を伝播。最初のチャンクのみが `PoolFlushItem.firstMessageAt` を受け取り、2番目以降のチャンクは `undefined`（タイムスタンプなしで生成）。

### 3.3 タイムスタンプ → 出力プライミングの生成

**narrative-worker.ts** に新規関数を追加:

```typescript
/**
 * ISO 8601 タイムスタンプと一人称代名詞から、出力プライミング行を生成する。
 * この行がユーザープロンプトの末尾に追加され、モデルの最初のトークンを
 * 物語モードに固定する（Prefix Scheduling / Output Priming）。
 *
 * @param isoTimestamp ISO 8601 形式のタイムスタンプ（例: "2026-04-16T19:30:00+09:00"）
 * @param pronoun 一人称代名詞（例: "僕", "私", "俺", "I"）
 * @returns 出力プライミング文字列（例: "2026年4月16日の19時に——僕は"）
 */
function formatTimestampForPriming(isoTimestamp: string | undefined, pronoun: string): string {
  if (!isoTimestamp) {
    // タイムスタンプなしの場合: 一人称だけでプライミング
    // 日本語: "僕は——" / 英語: "I—"
    if (/^[A-Za-z]/.test(pronoun)) return `${pronoun}—`;
    return `${pronoun}は——`;
  }

  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) {
    // パース失敗: フォールバック
    if (/^[A-Za-z]/.test(pronoun)) return `${pronoun}—`;
    return `${pronoun}は——`;
  }

  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = d.getHours();

  // プローンの文字種で言語を推定
  if (/^[A-Za-z]/.test(pronoun)) {
    // 英語系
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `On ${monthName(month)} ${day}, at ${displayHour} ${ampm} — ${pronoun}`;
  }

  // CJK 系 — 日本語フォーマット（中国語・韓国語も漢数字が通じる）
  return `${year}年${month}月${day}日の${hour}時に——${pronoun}は`;
}

function monthName(m: number): string {
  return ['January','February','March','April','May','June',
          'July','August','September','October','November','December'][m - 1] ?? '';
}
```

**出力例**:

| タイムスタンプ | 一人称 | プライミング |
|---|---|---|
| `2026-04-16T19:30:00+09:00` | 僕 | `2026年4月16日の19時に——僕は` |
| `2026-04-16T19:30:00+09:00` | 私 | `2026年4月16日の19時に——私は` |
| `2026-04-16T19:30:00+09:00` | 俺 | `2026年4月16日の19時に——俺は` |
| `2026-04-16T07:00:00+09:00` | I | `On April 16, at 7 AM — I` |
| `2026-04-16T22:00:00+09:00` | I | `On April 16, at 10 PM — I` |
| (なし) | 僕 | `僕は——` |
| (なし) | I | `I—` |

### 3.4 なぜこれが強力なのか

1. **最初のトークンが物語の冒頭に固定される** — モデルは「続き」を書くしかない。「Okay, let me...」で始めるのが物理的に不可能
2. **時間的文脈が自動的に確立** — 「いつ起きたか」が常に明示される
3. **assistant-mode を構造的に排除** — 「僕は——」の続きとして箇条書き・見出し・挨拶を書くことは不自然
4. **CoT漏れを構造的に防止** — 推論前置きが「2026年4月16日の19時に——僕は」の後に来ることはない
5. **previousEpisode との接続も自然** — 前回の物語の末尾→今回の冒頭が日付で繋がる

これ1行で、v0.4.17 の品質ゲート5個のうち3個（Gate 1 Markdown, Gate 2 CoT, Gate 3 assistant-mode）の発動を大幅に減らせる。

### 3.5 ユーザープロンプトでのプライミング配置

DEFAULT_USER_PROMPT_TEMPLATE の末尾を変更:

**現行**:
```
...
Write narrative text only.
```

**変更後**:
```
...
Write narrative text only. Continue from:

{priming}
```

`{priming}` は `formatTimestampForPriming(item.firstMessageAt, pronoun)` の戻り値。
モデルは `{priming}` の続きを書くことになる。

カスタムプロンプト（.md ファイル）にも `{priming}` プレースホルダーを追加する。
`resolveUserPrompt()` で `{priming}` → priming 文字列に置換する。

---

## 4. 課題1+2: Per-Agent Override + 一人称バリエーション

### 4.1 設計方針

- **グローバルがデフォルト、エージェント別が上書き** — `agents.kasou` に書かれたフィールドだけが上書きされる。省略したフィールドはグローバル設定を引き継ぐ
- **後方互換** — `agents` フィールドがない場合、現状と全く変わらない動作
- **OpenClaw本体の変更不要** — プラグイン設定の中だけで完結

### 4.2 設定スキーマ

openclaw.json の例:

```jsonc
{
  "episodic-claw": {
    "config": {
      // === グローバルデフォルト（全エージェントに適用）===
      "openrouterConfig": { "model": "google/gemma-4-31b-it:free", "temperature": 0.7 },
      "narrativeSystemPrompt": "/home/kasou/.openclaw/prompts/episodic_claw_narrative_system.md",
      "narrativeUserPromptTemplate": "/home/kasou/.openclaw/prompts/episodic_claw_narrative_user.md",

      // === エージェント別上書き ===
      "agents": {
        "kasou": {
          "firstPersonPronoun": "僕",
          "narrativeSystemPrompt": "/home/kasou/.openclaw/prompts/kasou_system.md",
          "narrativeUserPromptTemplate": "/home/kasou/.openclaw/prompts/kasou_user.md"
        },
        "main": {
          "firstPersonPronoun": "私"
          // narrativeSystemPrompt 省略 → グローバルデフォルトを使用
        },
        "dennouaibou": {
          "firstPersonPronoun": "俺",
          "narrativeUserPromptTemplate": "/home/kasou/.openclaw/prompts/dennouaibou_user.md"
        }
      }
    }
  }
}
```

### 4.3 型定義

**types.ts** に追加:

```typescript
/**
 * Per-agent narrative configuration override.
 * Fields set here override the global defaults in EpisodicPluginConfig.
 * Omitted fields fall through to the global default.
 */
export interface AgentNarrativeConfig {
  /** First-person pronoun for narrative output.
   *  Japanese: 私/僕/俺, Chinese: 我, Korean: 나/저, English: I
   *  Default: "I" (English) — overridden by per-agent setting */
  firstPersonPronoun?: string;

  /** Per-agent system prompt (inline text or path to .md/.txt file).
   *  Overrides global narrativeSystemPrompt for this agent.
   *  Omit to use global default. */
  narrativeSystemPrompt?: string;

  /** Per-agent user prompt template (inline text or path to .md/.txt file).
   *  Variables: {previousEpisode}, {conversationText}, {priming}
   *  Overrides global narrativeUserPromptTemplate for this agent.
   *  Omit to use global default. */
  narrativeUserPromptTemplate?: string;

  /** Per-agent OpenRouter model.
   *  Overrides global openrouterModel for this agent.
   *  Omit to use global default. */
  openrouterModel?: string;

  /** Per-agent narrative temperature (0..1).
   *  Overrides global narrativeTemperature for this agent.
   *  Omit to use global default. */
  narrativeTemperature?: number;

  /** Per-agent reasoning config.
   *  Overrides global openrouterReasoning for this agent.
   *  Omit to use global default. */
  openrouterReasoning?: OpenRouterReasoningConfig;
}
```

`EpisodicPluginConfig` に追加:

```typescript
export interface EpisodicPluginConfig {
  // ... 既存フィールド ...

  /** Per-agent narrative config overrides.
   *  Key: agentId (e.g. "kasou", "main", "dennouaibou")
   *  Value: fields to override (omit fields to use global default) */
  agents?: Map<string, AgentNarrativeConfig>;
}
```

### 4.4 config.ts 変更

`loadConfig()` で `rawConfig.agents` をパース:

```typescript
export function loadConfig(rawConfig: any): EpisodicPluginConfig {
  // ... 既存フィールド ...

  // Per-agent overrides
  const agents: Map<string, AgentNarrativeConfig> = new Map();
  if (rawConfig?.agents && typeof rawConfig.agents === "object") {
    for (const [agentId, agentRaw] of Object.entries(rawConfig.agents)) {
      if (typeof agentRaw !== "object" || agentRaw === null) continue;
      const a = agentRaw as Record<string, unknown>;
      agents.set(agentId, {
        firstPersonPronoun: typeof a.firstPersonPronoun === "string" ? a.firstPersonPronoun : undefined,
        narrativeSystemPrompt: resolvePrompt(typeof a.narrativeSystemPrompt === "string" ? a.narrativeSystemPrompt : undefined),
        narrativeUserPromptTemplate: resolvePrompt(typeof a.narrativeUserPromptTemplate === "string" ? a.narrativeUserPromptTemplate : undefined),
        openrouterModel: typeof a.openrouterModel === "string" ? a.openrouterModel : undefined,
        narrativeTemperature: typeof a.narrativeTemperature === "number" ? a.narrativeTemperature : undefined,
        openrouterReasoning: a.openrouterReasoning ? normalizeOpenRouterReasoning(a.openrouterReasoning as OpenRouterReasoningConfig) : undefined,
      });
    }
  }

  return {
    // ... 既存フィールド ...
    agents: agents.size > 0 ? agents : undefined,
  };
}
```

### 4.5 narrative-worker.ts 変更

#### 4.5.1 ResolvedAgentConfig 型と resolveAgentConfig() 関数

```typescript
interface ResolvedAgentConfig {
  systemPrompt: string;
  userPromptTemplate: string;       // テンプレート（{previousEpisode}, {conversationText}, {priming} を含む）
  firstPersonPronoun: string;
  model: string;
  temperature: number;
  reasoning: { enabled: boolean; effort?: string; maxTokens?: number; exclude?: boolean } | undefined;
}

private resolveAgentConfig(agentId: string): ResolvedAgentConfig {
  const override = this.config.agents?.get(agentId);

  const systemPrompt = override?.narrativeSystemPrompt?.trim()
    || this.config.narrativeSystemPrompt?.trim()
    || DEFAULT_SYSTEM_PROMPT;

  const userPromptTemplate = override?.narrativeUserPromptTemplate?.trim()
    || this.config.narrativeUserPromptTemplate?.trim()
    || "";  // "" = DEFAULT_USER_PROMPT_TEMPLATE 関数を使用

  const firstPersonPronoun = override?.firstPersonPronoun
    || "I";  // 英語デフォルト

  const model = override?.openrouterModel
    || this.config.openrouterModel
    || "openrouter/free";

  const temperature = override?.narrativeTemperature
    ?? this.config.narrativeTemperature
    ?? 0.4;

  const reasoning = override?.openrouterReasoning
    ?? this.config.openrouterReasoning;

  return { systemPrompt, userPromptTemplate, firstPersonPronoun, model, temperature, reasoning };
}
```

#### 4.5.2 narrativizeWithRetry() の変更

現行の `narrativizeWithRetry()` は `this.resolveSystemPrompt()` と `this.resolveUserPrompt()` を呼ぶ。これを `resolveAgentConfig(item.agentId)` に切り替える。

```typescript
private async narrativizeWithRetry(item: CacheItem): Promise<NarrativeResult | null> {
  const agentCfg = this.resolveAgentConfig(item.agentId);
  const systemPrompt = agentCfg.systemPrompt;
  const pronoun = agentCfg.firstPersonPronoun;

  // Respect narrativePreviousEpisodeRef config
  const previous = this.config.narrativePreviousEpisodeRef !== false
    ? this.lastNarrativeByAgent.get(item.agentId)
    : undefined;
  const conversationText = item.rawText;

  // 出力プライミングの生成
  const priming = formatTimestampForPriming(item.firstMessageAt, pronoun);

  // ユーザープロンプトの構築
  const userMessage = this.resolveUserPrompt(
    agentCfg.userPromptTemplate,
    previous?.body,
    conversationText,
    priming
  );

  // ... 既存のリトライループ（品質ゲート含む） ...
}
```

#### 4.5.3 resolveUserPrompt() の変更

`{priming}` プレースホルダーを追加で置換:

```typescript
private resolveUserPrompt(
  customTemplate: string,
  previousEpisode: string | undefined,
  conversationText: string,
  priming: string
): string {
  if (customTemplate && customTemplate.trim().length > 0) {
    return customTemplate
      .replace("{previousEpisode}", previousEpisode || "")
      .replace("{conversationText}", conversationText)
      .replace("{priming}", priming);
  }
  return DEFAULT_USER_PROMPT_TEMPLATE(previousEpisode, conversationText, priming);
}
```

#### 4.5.4 DEFAULT_USER_PROMPT_TEMPLATE の変更

`priming` パラメータを追加:

```typescript
const DEFAULT_USER_PROMPT_TEMPLATE = (
  previousEpisode: string | undefined,
  conversationText: string,
  priming: string
): string =>
  `HIGHEST PRIORITY. Violating any rule below makes the output invalid.

Output spec:
First-person past tense only. One continuous narrative body. Start from the very first character with the story.
Greetings, prefaces, explanations, bullet points, numbered lists, headings, Markdown, emoji, signatures are FORBIDDEN.
"Okay" "Let me" "First" "I need to" "Sure" "Here is" "Thank you" and similar planning notes or assistant-tone phrases are FORBIDDEN.
Never copy-paste from the conversation log. Rephrase all content as natural narrative prose.
Do NOT drop technical details: file names, commands, errors, decisions must be preserved.
Do NOT explain from outside the story. You ARE the agent — write from your perspective.
Do NOT write reasons you cannot comply. Just write the narrative.

Good opening example:
Late that evening at my desk, I pored over the logs searching for the next move.
${previousEpisode ? `\nPrevious episode:\n${previousEpisode}\n` : ""}The text below is raw material, NOT your output.
<<<LOG>>>
${conversationText}
<<<END_LOG>>>

Write narrative text only. Continue from:

${priming}`;
```

**注意**: DEFAULT は **first-person past tense**（一人称過去形）に変更。
三人称から一人称への転換は、エピソード記憶の定義（Endel Tulving, 1972:「自分自身が経験した出来事の記憶」）に合致する。

カスタムプロンプトで三人称を維持したいユーザーは、`narrativeUserPromptTemplate` に「Third-person past tense」を明記することで上書き可能。

### 4.6 checkNarrativeFormat() Gate 5 の一人称対応

**現行**:
```typescript
const narrativeStartPat = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}0-9A-Z\u00C0-\u017F"「『]/u;
```

一人称開始（「僕は」「私は」「俺は」「I 」）を許容する必要がある。

**変更後**:
```typescript
// 一人称代名詞で始まる物語を許容
// 「僕は」「私は」「俺は」「I 」等
const firstPersonStarts = ["僕は", "私は", "俺は", "我が", "我は", "나는", "저는", "我"];
const trimmedFirstLine = firstLine.trim();
const startsWithFirstPerson = firstPersonStarts.some(p => trimmedFirstLine.startsWith(p))
  || /^[AI]\s/.test(trimmedFirstLine);  // "I " or "A " (rare but valid)

const narrativeStartPat = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}0-9A-Z\u00C0-\u017F"「『]/u;
if (!narrativeStartPat.test(trimmedFirstLine) && !startsWithFirstPerson) {
  if (!/^[a-z]/.test(trimmedFirstLine)) {
    return { pass: false, reason: "narrative-format: first line doesn't look like narrative start" };
  }
}
```

### 4.7 openclaw.plugin.json の configSchema 追加

```json
"agents": {
  "type": "object",
  "description": "Per-agent narrative configuration overrides. Key: agentId. Value: fields to override (omit fields to use global default).",
  "additionalProperties": {
    "type": "object",
    "properties": {
      "firstPersonPronoun": {
        "type": "string",
        "description": "First-person pronoun for narrative output. Japanese: 私/僕/俺, Chinese: 我, Korean: 나/저, English: I. Default: I"
      },
      "narrativeSystemPrompt": {
        "type": "string",
        "description": "Per-agent system prompt (inline text or path to .md/.txt). Overrides global narrativeSystemPrompt."
      },
      "narrativeUserPromptTemplate": {
        "type": "string",
        "description": "Per-agent user prompt template. Variables: {previousEpisode}, {conversationText}, {priming}. Overrides global narrativeUserPromptTemplate."
      },
      "openrouterModel": {
        "type": "string",
        "description": "Per-agent OpenRouter model ID. Overrides global openrouterConfig.model."
      },
      "narrativeTemperature": {
        "type": "number",
        "minimum": 0,
        "maximum": 1,
        "description": "Per-agent narrative temperature. Overrides global openrouterConfig.temperature."
      },
      "openrouterReasoning": {
        "type": "object",
        "description": "Per-agent reasoning config. Overrides global openrouterConfig.reasoning.",
        "additionalProperties": false,
        "properties": {
          "enabled": { "type": "boolean" },
          "effort": { "type": "string", "enum": ["none", "minimal", "low", "medium", "high", "xhigh"] },
          "maxTokens": { "type": "integer", "minimum": 1 },
          "exclude": { "type": "boolean" }
        }
      }
    }
  }
}
```

---

## 5. 参加者を名前で呼ぶ（将来拡張）

### 5.1 現状の限界

`Message` インターフェースにはユーザー名フィールドが存在しない。OpenClaw 本体が plugin に `username` / `displayName` を渡していない。

### 5.2 部分対応（本プラン範囲内）

role ラベル付与（§2）により、モデルは `user:` / `assistant:` ラベルを見て「誰が言ったか」を理解できる。一人称視点では：

- `assistant:` の行 = エージェント自身の発言 → 一人称で語る対象
- `user:` の行 = 相手の発言 → 三人称で語る対象（「彼は〜した」「彼女から〜が届いた」）

これだけでも、一人称物語の構築に大きく役立つ。

### 5.3 完全対応（将来 — OpenClaw 本体変更が必要）

`Message` インターフェースに `senderName?: string` を追加し、OpenClaw 本体が Discord / Telegram のユーザー名を plugin に渡すようにする。

その場合の rawText:
```
user(Yoshia): テスト送るね
assistant(Kasou): バッチリ聞こえてるぜ
user(Yoshia): バグを見つけた
```

プロンプトには「相手の名前が分かる場合は名前で書け（例: ヨシアは〜した）」という指示を追加する。

**本プランでは実装しない** — OpenClaw 本体の変更が必要なため。role ラベル付与（§2）を先行実装し、ユーザー名は将来拡張とする。

---

## 6. 変更まとめ

| # | 変更ファイル | 内容 | 課題 |
|---|------------|------|------|
| 1 | `src/types.ts` | `AgentNarrativeConfig` インターフェース追加、`EpisodicPluginConfig` に `agents` Map と `PoolFlushItem.firstMessageAt` 追加 | 1+2+3 |
| 2 | `src/config.ts` | `loadConfig()` で `rawConfig.agents` をパース。`resolvePrompt()` の再利用 | 1+2 |
| 3 | `src/narrative-pool.ts` | `buildFlushItem()` に role ラベル付与 + `firstMessageAt` 取得 | 3+4 |
| 4 | `src/narrative-queue.ts` | `CacheQueueItem` に `firstMessageAt` 追加、伝播 | 3 |
| 5 | `src/narrative-worker.ts` | `resolveAgentConfig()` 追加、`formatTimestampForPriming()` 追加、`resolveUserPrompt()` に `{priming}` 対応、`DEFAULT_USER_PROMPT_TEMPLATE` を一人称対応 + priming パラメータ追加、`checkNarrativeFormat()` Gate 5 を一人称対応 | 1+2+3 |
| 6 | `openclaw.plugin.json` | `agents` フィールドの configSchema 追加 | 1+2 |
| 7 | `prompts/*.md` | 各言語版カスタムプロンプトに `{priming}` プレースホルダー追加 + 一人称版更新 | 1+2 |
| 8 | `test_narrative_quality_gate.ts` | 一人称開始テスト、プライミング生成テスト追加 | 2+3 |
| 9 | `test_config_pipeline.ts` | per-agent override テスト追加 | 1+2 |

**変更しないもの**:

| ファイル | 理由 |
|----------|------|
| `openrouter-client.ts` | モデル・温度の上書きは `NarrativeWorker` 側で制御する。クライアントは不変 |
| `reasoning-tags.ts` | 変更なし |
| `segmenter.ts` | `buildFlushItem()` の変更は `narrative-pool.ts` で実施。segmenter 自体は変更なし |
| `index.ts` | `resolveAgentConfig()` は `NarrativeWorker` 内部で完結する。plugin API の変更なし |
| Go sidecar | 変更なし。`firstMessageAt` は TS→TS の伝播であり、Go 側の CacheQueueItem スキーマには影響しない |

---

## 7. 受け入れ基準

| # | 確認項目 | 確認方法 |
|---|----------|----------|
| 1 | `agents` 設定なしの場合、現状と全く同じ動作をする | テスト |
| 2 | `agents.kasou.firstPersonPronoun = "僕"` 設定時、Kasou の物語が「僕は〜した」で始まる | テスト |
| 3 | `agents.kasou.narrativeSystemPrompt` 設定時、Kasou だけがカスタム system prompt を使う | テスト |
| 4 | `agents.main` に `narrativeSystemPrompt` 未設定時、グローバルデフォルトが使われる | テスト |
| 5 | `PoolFlushItem.firstMessageAt` に最初のメッセージのタイムスタンプが入る | テスト |
| 6 | `CacheQueueItem.firstMessageAt` が `PoolFlushItem` から伝播される | テスト |
| 7 | `formatTimestampForPriming()` が ISO → 自然言語プライミングに変換する | テスト |
| 8 | rawText に `user: ` / `assistant: ` ラベルが含まれる | テスト |
| 9 | `checkNarrativeFormat()` Gate 5 が一人称開始（「僕は」「私は」「I 」）を許容する | テスト |
| 10 | `npm run build:ts` PASS | コマンド実行 |
| 11 | `npm test` 全PASS | コマンド実行 |
| 12 | `go test ./...` PASS | コマンド実行 |

---

## 8. テスト

### 8.1 test_config_pipeline.ts に追加するテストケース

```typescript
// === Per-Agent Override ===

test("agents config is empty by default", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.agents, undefined);
});

test("agents config parses single agent override", () => {
  const cfg = loadConfig({
    agents: {
      kasou: { firstPersonPronoun: "僕" }
    }
  });
  assert.ok(cfg.agents);
  assert.equal(cfg.agents!.get("kasou")?.firstPersonPronoun, "僕");
});

test("agents config parses multiple agents", () => {
  const cfg = loadConfig({
    agents: {
      kasou: { firstPersonPronoun: "僕", narrativeSystemPrompt: "test system" },
      main: { firstPersonPronoun: "私" },
      dennouaibou: { firstPersonPronoun: "俺" }
    }
  });
  assert.equal(cfg.agents!.size, 3);
  assert.equal(cfg.agents!.get("kasou")?.narrativeSystemPrompt, "test system");
  assert.equal(cfg.agents!.get("main")?.narrativeSystemPrompt, undefined);
  assert.equal(cfg.agents!.get("dennouaibou")?.firstPersonPronoun, "俺");
});

test("agents config resolves .md prompt files", () => {
  const cfg = loadConfig({
    agents: {
      kasou: { narrativeSystemPrompt: "/tmp/test_prompt.md" }
    }
  });
  // resolvePrompt() should try to read the file
  // (exact behavior depends on whether the file exists)
});

test("per-agent temperature override", () => {
  const cfg = loadConfig({
    narrativeTemperature: 0.4,
    agents: {
      kasou: { narrativeTemperature: 0.8 }
    }
  });
  assert.equal(cfg.agents!.get("kasou")?.narrativeTemperature, 0.8);
});
```

### 8.2 test_narrative_quality_gate.ts に追加するテストケース

```typescript
// === First-person narrative start (Gate 5 update) ===

assert(
  "First-person '僕は' start should pass Gate 5",
  checkNarrativeFormat("僕はログを追いながら次の手を探っていた。").pass,
  true
);

assert(
  "First-person '私は' start should pass Gate 5",
  checkNarrativeFormat("私は画面に向かって返信を送った。").pass,
  true
);

assert(
  "First-person '俺は' start should pass Gate 5",
  checkNarrativeFormat("俺はコードの不具合を見つけた。").pass,
  true
);

assert(
  "First-person 'I ' start should pass Gate 5",
  checkNarrativeFormat("I looked through the logs searching for the next move.").pass,
  true
);

assert(
  "Third-person '彼は' start should still pass Gate 5",
  checkNarrativeFormat("彼はログを追いながら次の手を探っていた。").pass,
  true
);

// === formatTimestampForPriming ===

assert(
  "formatTimestampForPriming Japanese 僕",
  formatTimestampForPriming("2026-04-16T19:30:00+09:00", "僕"),
  "2026年4月16日の19時に——僕は"
);

assert(
  "formatTimestampForPriming English I",
  formatTimestampForPriming("2026-04-16T07:00:00+09:00", "I"),
  "On April 16, at 7 AM — I"
);

assert(
  "formatTimestampForPriming no timestamp 僕",
  formatTimestampForPriming(undefined, "僕"),
  "僕は——"
);

assert(
  "formatTimestampForPriming no timestamp I",
  formatTimestampForPriming(undefined, "I"),
  "I—"
);

// === Role label in rawText ===

// (This tests narrative-pool.ts buildFlushItem, not checkNarrativeFormat)
// Verify rawText includes role labels
// Test would need to instantiate NarrativePool and check output

// === resolveAgentConfig ===

// Verify agent override resolution
// Test would need to instantiate NarrativeWorker with agents config and verify
// resolveAgentConfig("kasou") returns kasou-specific settings
// resolveAgentConfig("unknown") returns global defaults
```

### 8.3 test_narrative_quality_gate.ts に追加する Gate 5 偽陽性回帰テスト

```typescript
// 回帰テスト: v0.4.18 で追加した数字始まり + v0.4.19 で追加する一人称始まり
assert(
  "Digit-starting '2026年の冬' should pass Gate 5",
  checkNarrativeFormat("2026年の冬、彼はログを追っていた。").pass,
  true
);

assert(
  "First-person with timestamp priming should pass Gate 5",
  checkNarrativeFormat("2026年4月16日の19時に——僕はログを追いながら次の手を探っていた。").pass,
  true
);
```

---

## 9. リスク評価

- **リスク**: **低〜中**
- **後方互換性**: ✅ `agents` フィールドなし → 現状と同じ動作。`firstMessageAt` なし → プライミングなしでフォールバック。role ラベルなし → 影響なし（新規 rawText にのみ適用）
- **偽陽性リスク**: Gate 5 の一人称開始許容により、「私は〜します」（アシスタント応答）が通る可能性あり。ただし Gate 3 が「お手伝いします」等を先頭行で検出するため、二重防御。
- **一人称 vs 三人称**: DEFAULT を一人称に変更することで、三人称を好むユーザーには Breaking Change。**対策**: カスタムプロンプトで `Third-person past tense only` を明記すれば三人称に戻せる。また v0.4.17 以前のカスタムプロンプト（.md ファイル）は `resolveUserPrompt()` で優先されるため、既存ユーザーは影響を受けない。
- **ロールバック**: 各課題は独立してロールバック可能
  - 課題4: `buildFlushItem()` の role ラベルを削除
  - 課題3: `firstMessageAt` 伝播を削除、プライミングを削除
  - 課題1+2: `agents` Map を無視、`resolveAgentConfig()` を固定値に戻す

---

## 10. 実装順序

```
Phase 1: 課題4 (role ラベル付与)
  → narrative-pool.ts の buildFlushItem() のみ変更
  → 最小リスク。品質ゲートへの影響なし（§2.5 で検証済み）
  → モデルが「誰が言ったか」を理解できるようになる

Phase 2: 課題3 (タイムスタンプ伝播 + 出力プライミング)
  → types.ts + narrative-pool.ts + narrative-queue.ts + narrative-worker.ts
  → firstMessageAt の伝播パス構築
  → formatTimestampForPriming() の実装
  → プライミングなしだと効果なし（Phase 3 と統合して完成）

Phase 3: 課題1+2 (per-agent override + 一人称バリエーション)
  → types.ts + config.ts + narrative-worker.ts + openclaw.plugin.json
  → resolveAgentConfig() の実装
  → DEFAULT_USER_PROMPT_TEMPLATE の一人称対応
  → checkNarrativeFormat() Gate 5 の一人称対応
  → カスタムプロンプトの更新

Phase 4: テスト + 回帰確認
  → 新テストケースの追加
  → npm test + go test + TS build
  → コードレビュー
```

---

## 11. カスタムプロンプトの更新指針

Phase 3 実装後に、各言語版のカスタムプロンプト（.md ファイル）を更新する。

### 11.1 日本語版（あなた向け）

**system** (`episodic_claw_narrative_system.md`):
```markdown
会話記録を一人称・過去形の日本語の地の文へ編纂する。返答は本文のみ。
```

**user** (`episodic_claw_narrative_user.md`):
```markdown
最優先命令。以下を1つでも破る出力は失敗。

出力仕様:
一人称・過去形の地の文で書く。一つの連続した本文だけを書く。最初の一文字から物語を始める。
挨拶、前置き、説明、箇条書き、番号、見出し、Markdown、絵文字、署名は禁止。
「Okay」「Let me」「First」「I need to」「ありがとうございます」「以下」「まとめました」「今後の展望」などの作業メモや応答者口調は禁止。
会話ログのコピペは禁止。内容は自然な地の文に言い換える。
ファイル名、コマンド、エラー、決定事項などの技術情報は落とさない。
物語の外から説明しない。あなた自身がその体験をしているかのように語る。
守れない理由も書かない。本文だけを書く。

良い書き出し例:
夜更けの作業机では、僕はログを追いながら次の手を探っていた。

【前回の物語（文脈の接続用）】
{previousEpisode}

以下は記録された会話ログです。これは素材であり、出力ではない。
<<<LOG>>>
{conversationText}
<<<END_LOG>>>

本文だけを書け。続きから:

{priming}
```

**注意**: `僕` をハードコードせず、エージェント別設定の `firstPersonPronoun` が `{priming}` に反映される。ただし「良い書き出し例」の中の一人称は、ユーザーが各 .md ファイルで自分のエージェントに合わせて手動調整する。

### 11.2 中国語版

**system**:
```markdown
将对话记录编纂为第一人称、过去时的中文叙事散文。仅输出正文。
```

**user**:
```markdown
最高优先级。违反以下任何规则即为失败。

输出规范:
第一人称、过去时。写一个连续的正文。从第一个字开始讲故事。
问候、前言、解释、项目符号、编号列表、标题、Markdown、表情符号、签名均禁止。
"Okay" "Let me" "First" "I need to" "好的" "以下" "总结" 等工作备忘或助手语气禁止。
禁止复制粘贴对话日志。将所有内容改写为自然的叙事散文。
不要丢失技术细节：文件名、命令、错误、决定必须保留。
不要从故事外部解释。以你自身的视角叙述。
不要写无法遵守的理由。只写正文。

好的开头示例:
深夜的办公桌前，我翻阅着日志，寻找着下一步的线索。

【上一段故事（上下文衔接用）】
{previousEpisode}

以下是对话日志素材，不是你的输出。
<<<LOG>>>
{conversationText}
<<<END_LOG>>>

只写正文。从以下继续:

{priming}
```

### 11.3 韓国語版

**system**:
```markdown
대화 기록을 1인칭 과거형 한국어 서술 산문으로 편찬한다. 본문만 출력한다.
```

**user**:
```markdown
최우선 명령. 아래 규칙 중 하나라도 위반하면 실패.

출력 사양:
1인칭 과거형. 하나의 연속된 본문만 쓴다. 첫 글자부터 이야기를 시작한다.
인사, 서문, 설명, 글머리 기호, 번호 매기기, 제목, 마크다운, 이모지, 서명은 금지.
"Okay" "Let me" "First" "I need to" "감사합니다" "다음과 같습니다" "요약했습니다" 등의 작업 메모나 어시스턴트 어조는 금지.
대화 로그의 복사 붙여넣기 금지. 모든 내용을 자연스러운 서술 산문으로 바꿔 쓴다.
기술적 세부사항을 잃지 않는다: 파일명, 명령어, 오류, 결정사항은 보존한다.
이야기 밖에서 설명하지 않는다. 자신의 관점에서 서술한다.
준수할 수 없는 이유를 쓰지 않는다. 본문만 쓴다.

좋은 시작 예시:
심야 작업 책상에서, 나는 로그를 뒤지며 다음 수를 찾고 있었다.

【이전 에피소드(문맥 연결용)】
{previousEpisode}

아래는 대화 로그 원본이며, 출력이 아니다.
<<<LOG>>>
{conversationText}
<<<END_LOG>>>

본문만 쓴다. 다음에서 계속:

{priming}
```

### 11.4 英語版（DEFAULT — コード内ハードコード）

§4.5.4 の DEFAULT_USER_PROMPT_TEMPLATE を参照。`firstPersonPronoun = "I"` がデフォルト。

---

## 12. 観測項目（実装後 24h）

1. `[NarrativeWorker]` ログの `narrative-format:` 出力回数（プライミング導入による変化 — 減少が期待される）
2. 成功した物語化の出力の先頭100文字（一人称で始まっているかの確認）
3. タイムスタンプの有無とプライミング生成のフォールバック率
4. `resolveAgentConfig()` のオーバーライド発動率（per-agent 設定が使われているか）
5. rawText の role ラベルがモデルに正しく伝わっているか（物語出力で assistant 発言が一人称、user 発言が三人称で語られているか）

---

## 13. Pro Engineer Review

> Perspective: Google / IBM Production Engineering
> Principles applied: YAGNI · KISS · DRY · SOLID

### 🎯 Core Problem (1 sentence)

> 複数エージェントが同一プロンプト・同一一人称で物語化されるため、エージェントの人格差が反映されず、タイムスタンプもユーザー識別も失われた rawText ではモデルが「誰がいつ何を言ったか」を理解できず、assistant-mode 崩れや CoT 漏れの温床になっている。

### 🔍 Principle Filter

| Check | Result | Note |
|-------|--------|------|
| YAGNI — Per-agent model override needed now? | ✅ Yes | 異モデル（Gemma vs GPT）の使い分けに必要 |
| YAGNI — Per-agent reasoning override needed now? | ⚠️ Defer | 全エージェント同一で困っていないなら後回し |
| KISS — Is there a simpler solution than agents Map? | ❌ No | エージェント別設定のMap構造が最も自然 |
| KISS — Is formatTimestampForPriming over-engineered? | ✅ No | ISO → 自然言語変換は最小限の実装 |
| DRY — Any duplication to eliminate? | ✅ resolveAgentConfig() | 現在の resolveSystemPrompt/resolveUserPrompt の責務を統合 |
| SOLID — resolveAgentConfig violates SRP? | ⚠️ Mild | 設定解決とプロンプト選択の2責務。ただしKISS観点で1関数に統合する方が実用的 |

### ⚡ Quick Wins

- [ ] role ラベル付与（§2）— buildFlushItem() 1箇所の変更でモデルの理解力が向上
- [ ] `firstMessageAt` 伝播（§3.2）— 3ファイルにフィールド追加だけ。プライミング生成は後から
- [ ] `agents` Map と `resolveAgentConfig()`（§4）— 設定の受信・解決。モデル呼び出しへの適用は後から

### ⚠️ 注意事項

- `DEFAULT_USER_PROMPT_TEMPLATE` を一人称に変更することは、三人称を前提に書かれた既存の `previousEpisode` との視点不一致を生む可能性がある。**対策**: previousEpisode は「前回の物語」としてそのまま渡す。モデルは前回が三人称でも、今回を一人称で書くように指示される。視点の切り替わりは「日付プライミング」で明確に区切られるため、自然に処理される
- `formatTimestampForPriming()` はタイムゾーンの扱いに注意。ISO 8601 タイムスタンプにタイムゾーンが含まれれば `new Date()` が正しくローカル時刻に変換するが、タイムゾーンなしの ISO 文字列（`2026-04-16T19:30:00`）は UTC として解釈される。OpenClaw がどちらの形式で送ってくるかに依存する

---

## ✅ PassOff — 実装完了確認

> Date: (実装後に記入)
> Status: ⏳ PENDING
