/**
 * NarrativeWorker — Async narrative generation worker (v0.4.2 pull-based).
 * Pulls chunks from the Go cache DB via LeaseNext, narrativizes via OpenRouter,
 * and Ack/Retries the cache job. Per-agent continuity state is maintained.
 */

import { estimateTokens, agentWsHash } from "./utils";
import { OpenRouterClient, OpenRouterError } from "./openrouter-client";
import { GeminiDirectClient, GeminiDirectError } from "./gemini-direct-client";
import { EpisodicCoreClient } from "./rpc-client";
import { EpisodicPluginConfig, NarrativeResult } from "./types";

import { stripReasoningTagsFromText } from "./reasoning-tags";
import type { Message } from "./segmenter";
import type { CacheQueueItem } from "./narrative-queue";

// [v0.4.17] Contract-first: minimal role declaration only. Rules moved to user prompt.
// Gemma free models follow user-role instructions more reliably than long system prompts.
const DEFAULT_SYSTEM_PROMPT = `Distill conversation logs into third-person past-tense narrative prose. Output narrative text only.`;

// [v0.4.17] Contract-first user prompt: rules at top, forbidden phrases, output priming.
// English by default; CJK users override via narrativeUserPromptTemplate config pointing to localized .md.
export const DEFAULT_USER_PROMPT_TEMPLATE = (previousEpisode: string | undefined, conversationText: string): string =>
  `HIGHEST PRIORITY. Violating any rule below makes the output invalid.

Exam-style requirements (MUST satisfy ALL):
1. Include at least 3 specific technical anchors from the log (file names, commands, error codes, version numbers, HTTP statuses) naturally woven into the narrative prose.
2. Do NOT produce generic filler like "It is crucial", "Careful consideration", "自然な流れを心がけ" — every sentence must convey concrete information from the log.
3. Output narrative prose only. No checklists, no self-evaluation, no meta-commentary.

Output spec:
Third-person past tense only. Write continuous narrative prose, not bullet points or headings. Use natural paragraph breaks. For longer narratives, separate the text into at least two paragraphs. Start from the very first character with the story.
Greetings, prefaces, explanations, bullet points, numbered lists, headings, Markdown, emoji, signatures are FORBIDDEN.
"Okay" "Let me" "First" "I need to" "Sure" "Here is" "Thank you" and similar planning notes or assistant-tone phrases are FORBIDDEN.
Never copy-paste from the conversation log. Rephrase all content as natural narrative prose.
Do NOT drop technical details: file names, commands, errors, decisions must be preserved.
Do NOT role-play as a conversation participant. Do NOT explain from outside the story.
Do NOT write reasons you cannot comply. Just write the narrative.

Good opening example:
Late that evening at his desk, he pored over the logs searching for the next move.
${previousEpisode ? `\nPrevious episode:\n${previousEpisode}\n` : ""}The text below is raw material, NOT your output.
<<<LOG>>>
${conversationText}
<<<END_LOG>>>

Write narrative text only.`;

const MAX_RETRIES = 12;
const FALLBACK_RETRIES = 3;
const FALLBACK_HEAD_RETRIES = 1;
const FALLBACK_GEMINI_RETRIES = 2;
const FALLBACK_TAIL_RETRIES = 2;
const GEMINI_DIRECT_MODEL = "gemini-3.1-flash-lite-preview";
const RETRY_BASE_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 600_000; // 10min cap
const SAVE_HASH_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1000;
const LEASE_SECONDS = 120;
const MIN_NARRATIVE_TOKENS = 10;
const MIN_COMPRESSION_RATIO = 0.01; // Output must be >= 1% of input tokens
const ECHO_SAMPLE_LENGTH = 80; // Characters to check for verbatim echo
const MIN_ECHO_LENGTH = 20; // Minimum length to bother checking
const MAX_ECHO_SCAN_CHARS = 5000; // Only scan first 5000 chars of input (echoes are near the beginning)

// [v0.4.27b] Content quality gate constants
const MIN_ANCHOR_COUNT_FOR_STRICT = 4; // Raw text must have >=4 anchors for strict coverage check
const MIN_ANCHOR_HITS_REQUIRED = 3; // Narrative must include >=3 of the raw anchors (when strict)
const CONTENT_GATE_REJECTS_BEFORE_FALLBACK = 3; // Consecutive content-gate rejects before forcing phase handoff

// [v0.4.27b] Generic template / lazy narrative phrases — DRY single source of truth.
// Used in applyQualityGates Gate 3b (body-scan, isContentGate=true).
// NOT duplicated in checkNarrativeFormat Gate 3 (firstLine-only, isContentGate=false).
const GENERIC_TEMPLATE_PHRASES = [
  // JP generic template / lazy narrative phrases (from evidence: accurate-natural-flow.md, story-narrative-improvements.md)
  "地の文を整え",
  "自然な流れを心がけ",
  "心がけました",
  "不可欠です",
  "精密な調整",
  "バランスを取",
  "丁寧にまとめ",
  "適切に表現",
  "正確に反映",
  // EN generic academic phrases (from evidence: narrative-fact-balance-precision.md)
  "It is crucial",
  "It is essential",
  "It is important",
  "Proper adjustment",
  "Careful consideration",
];
// [AUDIT NOTE] This is an intentional trade-off (v0.4.12 Phase E), NOT a bug:
// - Echoes always appear near the beginning of input (model echoes the first ~200 tokens)
// - Scanning beyond 5000 chars would catch tail echoes but at 85% more memory cost (192KB copy)
// - False negatives (tail echoes) are low-impact: output is still a narrative, just with some verbatim at the end

// Use the canonical queue item type (avoids type duplication with narrative-queue.ts)
// [v0.4.27b] Structured quality gate result — enables content-gate-aware retry logic
type QualityGateResult = {
  pass: boolean;
  reason: string;
  isContentGate: boolean; // true if this is a content-quality gate (vs format/compression)
};

type CacheItem = CacheQueueItem;

type RetryProvider = "openrouter" | "gemini-direct";

type RetryPhase = {
  provider: RetryProvider;
  model: string;
  maxAttempts: number;
  label: string;
  handoffReason?: "fallback_2_of_3";
  /** [v0.4.27b] Enable content quality gates (anchor coverage) for this phase.
   *  Should be true ONLY if a subsequent fallback phase exists — otherwise
   *  content-gate rejects would cause item loss (regression vs. current behavior). */
  contentGateEnabled?: boolean;
};

class EmptyRawTextError extends Error {
  constructor(item: CacheItem) {
    super(`empty_raw_text: itemId=${item.id} agentId=${item.agentId} source=${item.source}`);
    this.name = "EmptyRawTextError";
  }
}

/**
 * Sanitize OpenRouter LLM output to remove OpenClaw agent response format tags
 * and other non-narrative artifacts that leak through when the model echoes
 * conversation content instead of producing a clean summary.
 */
export function sanitizeNarrativeOutput(text: string): string {
  // Step 1: Strip <final>, </final>, <thinking>, </thinking> etc.
  let cleaned = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });

  // Step 2: Strip OpenClaw agent response format tags
  cleaned = cleaned
    .replace(/\[\[reply_to_current\]\]/g, "")
    .replace(/\[reply_to_current\]/g, "")
    .replace(/^\s*\[analysis\]\s*/gim, "")
    .replace(/^\s*\[\/analysis\]\s*/gim, "")
    .replace(/^\s*\[output\]\s*/gim, "")
    .replace(/^\s*\[\/output\]\s*/gim, "");

  // Step 2.5 [v0.4.17]: Strip CoT planning prefix (untagged reasoning leakage)
  // Safety net for cases where Axis 1 (prompt) and Axis 2 (exclude=true) are bypassed.
  // Matches consecutive lines starting with planning/meta phrases until a narrative line begins.
  const cotPrefixPat = /^(?:(?:Okay[,.]?\s*)?(?:let me|I need|I should|I'll|first,?\s+I|I have to)[^.]*\.\s*\n?)+/im;
  cleaned = cleaned.replace(cotPrefixPat, "");

  // Step 3: Clean up residual whitespace from tag removal
  cleaned = cleaned
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return cleaned;
}

/**
 * [NEW v0.4.11] Quality gate: check if output meets minimum tokens and compression ratio.
 */
export function checkCompressionRatio(outputTokens: number, inputTokens: number): boolean {
  if (outputTokens < MIN_NARRATIVE_TOKENS) return false;
  const ratio = outputTokens / Math.max(1, inputTokens);
  return ratio >= MIN_COMPRESSION_RATIO;
}

/**
 * [NEW v0.4.11] Quality gate: check if output is a verbatim copy of input parts.
 * Compares by stripping ALL whitespaces to catch echoes with different formatting.
 */
export function checkEchoDetection(output: string, input: string): boolean {
  // Collapse whitespaces in output (small, typically <500 chars)
  const collapsedOutput = output.replace(/\s+/g, "").trim();
  if (collapsedOutput.length < MIN_ECHO_LENGTH) return true; // Too short to judge

  const echoSample = collapsedOutput.substring(0, ECHO_SAMPLE_LENGTH);

  // Only collapse the first MAX_ECHO_SCAN_CHARS of input (avoid 192KB full copy for 48K-token texts)
  // Echoes are always near the beginning of the input
  // [AUDIT NOTE] Whitespace collapse is intentional: CJK text has no whitespace so this is a no-op for CJK.
  // MIN_ECHO_LENGTH=20 means 20 whitespace-collapsed chars ≈ 20 kanji for CJK — unlikely to false-positive.
  // For Latin text, 20 chars ≈ 3-4 words — very unlikely to match by coincidence.
  const inputPrefix = input.substring(0, MAX_ECHO_SCAN_CHARS).replace(/\s+/g, "");
  return !inputPrefix.includes(echoSample);
}

/**
 * [NEW v0.4.17] Quality gate: check if output conforms to narrative format.
 * Detects assistant-mode outputs, CoT leakage, and prohibited formatting.
 * Returns { pass: boolean, reason: string }.
 */
/**
 * [v0.4.27b] Extract concrete "content anchors" from raw conversation text.
 * Anchors are technical details that a quality narrative should preserve:
 * file paths/extensions, HTTP status codes, error codes, numeric values,
 * and identifiable technical tokens.
 * Lightweight regex-based extraction — no NLP dependency.
 */
export function extractContentAnchors(rawText: string): string[] {
  const anchors = new Set<string>();
  const seen = new Set<string>(); // deduplicate (case-insensitive)

  // File paths and extensions: /path/to/file.ext or file.ext
  for (const m of rawText.matchAll(/(?:[\/\\][\w.\-]+){1,5}\.[a-zA-Z]{1,8}|\b[\w\-]+\.(?:ts|js|go|py|rs|json|yaml|yml|toml|md|txt|sql|sh|tsx|jsx|css|html|rb|java|c|cpp|h|hpp|proto|grpc|env|cfg|ini)\b/g)) {
    const a = m[0].toLowerCase();
    if (!seen.has(a) && m[0].length >= 4) {
      seen.add(a);
      anchors.add(m[0]);
    }
  }

  // HTTP status codes: 200, 404, 500, etc.
  for (const m of rawText.matchAll(/\b([45]\d{2}|200|201|204|301|302)\b/g)) {
    const a = m[0];
    if (!seen.has(a)) {
      seen.add(a);
      anchors.add(a);
    }
  }

  // Error codes: ECONNRESET, EPIPE, ENOENT, SIGKILL, etc.
  for (const m of rawText.matchAll(/\b(E[A-Z]{4,}|SIG[A-Z]+|ERR_[A-Z_]+)\b/g)) {
    const a = m[0];
    if (!seen.has(a)) {
      seen.add(a);
      anchors.add(a);
    }
  }

  // Version strings: v0.4.27, 1.2.3, etc.
  for (const m of rawText.matchAll(/\bv?\d+\.\d+(?:\.\d+)?\b/g)) {
    const a = m[0];
    if (!seen.has(a) && a.length >= 3) {
      seen.add(a);
      anchors.add(a);
    }
  }

  // Alphanumeric command/function identifiers: at least 3+ alphanumeric chars with mixed case
  for (const m of rawText.matchAll(/\b([a-z][a-zA-Z0-9]{2,}[A-Z][a-zA-Z0-9]*|[A-Z][a-z]+[A-Z][a-zA-Z0-9]*)\b/g)) {
    const a = m[0];
    const lower = a.toLowerCase();
    // Skip common English words that match camelCase pattern
    if (["the", "and", "for", "not", "but", "are", "was", "has", "had", "can", "all"]
      .some(w => lower === w)) continue;
    if (!seen.has(lower) && a.length >= 4) {
      seen.add(lower);
      anchors.add(a);
    }
  }

  return Array.from(anchors);
}

/**
 * [v0.4.27b] Count how many raw-text anchors appear in the narrative text.
 * Case-insensitive substring matching.
 */
export function countAnchorHits(narrativeText: string, anchors: string[]): number {
  const lower = narrativeText.toLowerCase();
  let hits = 0;
  for (const anchor of anchors) {
    if (lower.includes(anchor.toLowerCase())) {
      hits++;
    }
  }
  return hits;
}

export function checkNarrativeFormat(text: string): { pass: boolean; reason: string } {
  const lines = text.split(/\r?\n/);
  const firstLine = lines[0] ?? "";
  const firstChars = text.substring(0, 100);

  // Gate 1: Line starts with markdown header / list / numbered list
  for (const line of lines) {
    if (/^\s*#{1,6}\s/.test(line)) {
      return { pass: false, reason: "narrative-format: markdown header detected" };
    }
    if (/^\s*[-*]\s/.test(line)) {
      return { pass: false, reason: "narrative-format: bullet list detected" };
    }
    if (/^\s*\d+\.\s/.test(line)) {
      return { pass: false, reason: "narrative-format: numbered list detected" };
    }
  }

  // Gate 2: CoT / Planning phrase detection (English + Japanese)
  const cotPatterns = [
    // --- English (existing) ---
    /\bOkay\b.*\b(let me|I need|I should|I'll|first)\b/i,
    /\bLet me\b.*\b(parse|understand|analyze|start|think)\b/i,
    /\bFirst,?\s+I\s+(need|should|will|must)\b/i,
    /\bI need to\b.*\b(parse|understand|focus|ensure)\b/i,

    // --- [v0.4.21b] Japanese CoT patterns ---
    /では[、。].*(整理|分析|まとめ|考察|見)/,
    /まず[、。].*(理解|確認|分析|見|整理)/,
    /この会話[では].*(注目|重要|焦点|注視)/,
    /要約すると[、。]/,
    /順に[、。].*(見|確認|整理|追う)/,
    /お伝えします[、。]/,
    /^.*を(整理|分析|まとめ|考察)(?:しましょう|して)(?:[、。]|$)/,
  ];
  for (const pat of cotPatterns) {
    if (pat.test(firstChars)) {
      return { pass: false, reason: "narrative-format: CoT planning phrase detected" };
    }
  }

  // Gate 3: Japanese assistant-mode phrases at the start of the first line
  // [v0.4.17] Scoped to the beginning of firstLine (not full text) to avoid False Positives.
  // When a conversation character legitimately says "ありがとうございます" as role-play,
  // the narrative will embed it mid-sentence (e.g. 彼は「ありがとうございます」と答えた)
  // — which does NOT start the line with the phrase. Only assistant-mode outputs
  // start the output with these phrases (e.g. "ありがとうございます！まとめました。").
  const assistantPhrases = [
    // --- Existing ---
    "ありがとうございます",
    "以下の通りです",
    "まとめました",
    "今後の展望",
    "要点をまとめ",
    "お手伝いします",
    // --- [v0.4.21b] Additional ---
    "承知いたしました",
    "かしこまりました",
    "それではまとめ",
    "確認いたします",
    // Note: [v0.4.27b] generic template phrases moved to Gate 3b body-scan
    // (see GENERIC_TEMPLATE_PHRASES below). Not duplicated here per DRY principle.
  ];
  for (const phrase of assistantPhrases) {
    if (firstLine.trimStart().startsWith(phrase)) {
      return { pass: false, reason: `narrative-format: assistant-mode phrase "${phrase}" detected` };
    }
  }

  // Note: [v0.4.27b] Generic template phrase detection moved to applyQualityGates()
  // as a content gate (isContentGate=true) to enable early bailout routing.
  // See GENERIC_TEMPLATE_PHRASES constant and Gate 3b logic there.

  // Gate 4: Emoji / kaomoji
  const emojiPat = /[\p{Emoji_Presentation}\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]|≧∇≦/u;
  if (emojiPat.test(text)) {
    return { pass: false, reason: "narrative-format: emoji or kaomoji detected" };
  }

  // Gate 5: First line doesn't look like narrative start
  // Narrative starts with: CJK character, or proper noun, or time expression
  // Assistant starts with: greeting, explanation, or English planning
  const narrativeStartPat = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}0-9A-Z\u00C0-\u017F"「『]/u;
  if (!narrativeStartPat.test(firstLine.trim())) {
    // Allow lowercase Latin starts (some narratives start with "the", "a")
    if (!/^[a-z]/.test(firstLine.trim())) {
      return { pass: false, reason: "narrative-format: first line doesn't look like narrative start" };
    }
  }

  // Gate 6: Minimum paragraph structure
  // [v0.4.19b] Narrative output with 500+ characters should have at least 2 paragraphs
  // (separated by \n\n). Single-paragraph wall-of-text indicates model failure
  // to structure output — common with free models producing "stream of consciousness".
  const MIN_CHARS_FOR_PARAGRAPH_CHECK = 500;
  const MIN_PARAGRAPH_COUNT = 2;

  if (text.length >= MIN_CHARS_FOR_PARAGRAPH_CHECK) {
    // Count paragraph breaks: sequences of \n\n (possibly with whitespace)
    const paragraphBreaks = text.split(/\n\s*\n/);
    if (paragraphBreaks.length < MIN_PARAGRAPH_COUNT) {
      return { pass: false, reason: `narrative-format: single-paragraph wall-of-text (${text.length} chars, ${paragraphBreaks.length} paragraph(s)). Minimum ${MIN_PARAGRAPH_COUNT} paragraphs required for texts over ${MIN_CHARS_FOR_PARAGRAPH_CHECK} chars.` };
    }
  }

  return { pass: true, reason: "" };
}

export class NarrativeWorker {
  private isProcessing = false;
  private shouldStop = false;
  private pollTimer: NodeJS.Timeout | null = null;
  // Per-agent continuity state
  private lastNarrativeByAgent = new Map<string, { episodeId: string; body: string }>();
  // Known agent IDs to poll (populated by initContinuity)
  private knownAgentIds = new Set<string>();
  // Adaptive idle backoff (v0.4.3): reduce polling frequency when queue is empty
  private consecutiveEmptyPolls = 0;
  private nextPollDelayMs = POLL_INTERVAL_MS;
  private readonly MAX_POLL_DELAY_MS = 15_000; // Cap at 15 seconds
  // [v0.4.19d] Idempotency guard: scoped rawText hash → savedAt timestamp
  // [v0.4.21c] Key format changed to `agentWs:agentId:rawHash` for agent/workspace isolation
  private recentSaveHashes = new Map<string, number>();
  // [v0.4.21b] Debounce counter for save hash persistence (avoid DB write on every save)
  // [v0.4.21d] Per-agent isolation: each agent has its own counter for predictable debounce timing
  private saveHashPersistCounters = new Map<string, number>();
  private readonly SAVE_HASH_PERSIST_INTERVAL = 5; // persist every 5th save
  private geminiClient: GeminiDirectClient | null = null;
  private geminiClientKey = "";
  private geminiMissingKeyWarned = false;

  constructor(
    private client: OpenRouterClient,
    private rpcClient: EpisodicCoreClient,
    private config: EpisodicPluginConfig,
  ) {}

  /**
   * Wake the worker from idle backoff. Called when new items are enqueued.
   */
  wake(): void {
    this.consecutiveEmptyPolls = 0;
    this.nextPollDelayMs = POLL_INTERVAL_MS;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.pollNext();
    }
  }

  /**
   * Start polling the cache queue for items to narrativize.
   */
  start(): void {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.shouldStop = false;
    this.pollNext();
  }

  /**
   * Stop polling and wait for current processing to finish.
   */
  async stop(): Promise<void> {
    this.shouldStop = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    let waited = 0;
    while (this.isProcessing && waited < 15000) {
      await this.sleep(100);
      waited += 100;
    }
  }

  /**
   * Initialize continuity state by loading the latest narrative episode per agent.
   */
  async initContinuity(agents: Array<{ agentWs: string; agentId: string }>): Promise<void> {
    for (const { agentWs, agentId } of agents) {
      this.knownAgentIds.add(agentId);
      try {
        const result = await this.rpcClient.cacheGetLatestNarrative(agentWs, agentId);
        if (result?.found && result.body) {
          // [v0.4.21f] Workspace-isolated key prevents cross-workspace continuity bleed
          this.lastNarrativeByAgent.set(`${agentWsHash(agentWs)}:${agentId}`, { episodeId: result.episodeId, body: result.body });
          console.log(`[NarrativeWorker] Loaded continuity for agent ${agentId}: ${result.episodeId}`);
        }
      } catch (err) {
        // No continuity available yet
      }
      // [v0.4.21b] Restore save hashes from state DB so dedup persists across restarts
      await this.loadSaveHashes(agentWs, agentId);
    }
  }

  private pollNext(): void {
    if (this.shouldStop) {
      this.isProcessing = false;
      return;
    }

    this.processNextFromCache().finally(() => {
      if (!this.shouldStop) {
        this.pollTimer = setTimeout(() => this.pollNext(), this.nextPollDelayMs);
      } else {
        this.isProcessing = false;
      }
    });
  }

  private async processNextFromCache(): Promise<void> {
    try {
      const agentIds = this.knownAgentIds.size > 0 ? Array.from(this.knownAgentIds) : ["main"];
      for (const agentId of agentIds) {
        const item = await this.rpcClient.cacheLeaseNext("narrative-worker", agentId, LEASE_SECONDS);
        if (!item) continue;

        this.consecutiveEmptyPolls = 0;
        this.nextPollDelayMs = POLL_INTERVAL_MS;

        console.log(
          `[NarrativeWorker] Leased chunk [${item.id}] attempt=${item.attempts} lease=${LEASE_SECONDS}s tokens=${item.estimatedTokens} agent=${agentId}`
        );

        try {
          const result = await this.narrativizeWithRetry(item);
          if (result) {
            await this.saveNarrative(result, item);
            await this.rpcClient.cacheAck(item.id, "narrative-worker");
            console.log(`[NarrativeWorker] Successfully narrativized chunk [${item.id}]. (Output: ${result.tokens} tokens)`);
          } else {
            // [v0.4.12] Quality gate exhausted → re-queue with backoff instead of saving fallback
            // Fallback summary would pollute: context (lastNarrativeByAgent), vector store, and UX
            // rawText is preserved in PebbleDB (Ack deleteAfter=false) for manual requeue later
            await this.rpcClient.cacheRetry(item.id, "narrative-worker", "Quality gate exhausted: all retries failed", MAX_CACHE_ATTEMPTS);
            console.warn(
              `[NarrativeWorker] Quality gate: all ${MAX_RETRIES} LLM attempts exhausted for [${item.id}]. Re-queued for later retry (${item.attempts}/${MAX_CACHE_ATTEMPTS}).`
            );
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await this.rpcClient.cacheRetry(item.id, "narrative-worker", errMsg, MAX_CACHE_ATTEMPTS);
          console.log(`[NarrativeWorker] Returned chunk [${item.id}] to queue. attempts increased error=${errMsg}`);
        }
        return;
      }

      this.consecutiveEmptyPolls++;
      this.nextPollDelayMs = Math.min(this.MAX_POLL_DELAY_MS, this.nextPollDelayMs * 2);

      if (this.consecutiveEmptyPolls > 0 && this.consecutiveEmptyPolls % 20 === 0) {
        console.log(`[NarrativeWorker] Idle backoff: ${this.consecutiveEmptyPolls} empty polls, next in ${this.nextPollDelayMs}ms`);
      }
    } catch (err) {
      console.warn("[NarrativeWorker] Poll error:", err);
    }
  }

  private async narrativizeWithRetry(item: CacheItem): Promise<NarrativeResult | null> {
    if (item.rawText.trim().length === 0) {
      console.warn(
        `[NarrativeWorker] Skipping LLM call for [${item.id}] agent=${item.agentId} source=${item.source} reason=empty_raw_text`
      );
      throw new EmptyRawTextError(item);
    }

    const phases = this.getRetryPhases();

    for (let phaseIndex = 0; phaseIndex < phases.length; phaseIndex++) {
      const phase = phases[phaseIndex];
      if (phase.handoffReason) {
        console.log(JSON.stringify({
          source: "episodic-claw",
          event: "narrative-phase-handoff",
          phaseHandoffReason: phase.handoffReason,
          provider: phase.provider,
          geminiModel: phase.provider === "gemini-direct" ? phase.model : "",
          itemId: item.id,
        }));
      }

      console.log(`[NarrativeWorker] Phase "${phase.label}": trying provider=${phase.provider} model=${phase.model}, maxAttempts=${phase.maxAttempts}`);

      const result = phase.provider === "gemini-direct"
        ? await this.narrativizeWithGeminiModel(item, phase.model, phase.maxAttempts, phase.label, phase.contentGateEnabled)
        : await this.narrativizeWithModel(item, phase.model, phase.maxAttempts, phase.label, phase.contentGateEnabled);
      if (result) return result;

      if (phaseIndex < phases.length - 1) {
        console.warn(
          `[NarrativeWorker] Phase "${phase.label}" exhausted for [${item.id}]. Falling back to next model...`
        );
      }
    }

    return null;
  }

  /**
   * [v0.4.19d] Determine retry model sequence.
   * [v0.4.27b] Content gate enabled only when fallback phase exists (prevents item-loss regression).
   * - If primary model is "openrouter/free" (default):
   *   - With GEMINI_API_KEY: primary (content gate) → gemini-direct (no content gate)
   *   - Without GEMINI_API_KEY: primary only, content gate disabled (preserve current behavior)
   * - If primary model is custom: primary + openrouter/free fallback + gemini-direct (if available)
   */
  private getRetryPhases(): RetryPhase[] {
    const primary = this.config.openrouterModel ?? "openrouter/free";
    const fallback = "openrouter/free";
    const hasGeminiApiKey = !!process.env.GEMINI_API_KEY;

    if (primary === fallback) {
      // [v0.4.27b] Default: openrouter/free with optional Gemini fallback
      // Content gate ONLY enabled when there's a Gemini fallback — otherwise
      // content-gate rejects would cause item loss (worse than current behavior)
      const phases: RetryPhase[] = [
        { provider: "openrouter", model: primary, maxAttempts: MAX_RETRIES, label: "primary",
          contentGateEnabled: hasGeminiApiKey },
      ];
      if (hasGeminiApiKey) {
        phases.push({
          provider: "gemini-direct",
          model: GEMINI_DIRECT_MODEL,
          maxAttempts: FALLBACK_GEMINI_RETRIES,
          label: "fallback-gemini-content",
          handoffReason: "fallback_2_of_3",
          // Gemini is last-resort — no content gate to prevent item loss
        });
      }
      return phases;
    }

    // Custom primary model: multiple fallback phases
    const phases: RetryPhase[] = [
      { provider: "openrouter", model: primary, maxAttempts: MAX_RETRIES, label: "primary",
        contentGateEnabled: true }, // Has fallback phases
      { provider: "openrouter", model: fallback, maxAttempts: FALLBACK_HEAD_RETRIES, label: "fallback-openrouter-head",
        contentGateEnabled: true }, // Has more fallback phases
    ];

    if (hasGeminiApiKey) {
      phases.push({
        provider: "gemini-direct",
        model: GEMINI_DIRECT_MODEL,
        maxAttempts: FALLBACK_GEMINI_RETRIES,
        label: "fallback-gemini-direct",
        handoffReason: "fallback_2_of_3",
        // Gemini is last-resort — no content gate to prevent item loss
      });
      phases.push({ provider: "openrouter", model: fallback, maxAttempts: FALLBACK_TAIL_RETRIES, label: "fallback-openrouter-tail" });
      return phases;
    }

    if (!this.geminiMissingKeyWarned) {
      this.geminiMissingKeyWarned = true;
      console.warn("[NarrativeWorker] GEMINI_API_KEY missing. Gemini direct handoff disabled; using OpenRouter fallback only.");
    }
    phases.push({ provider: "openrouter", model: fallback, maxAttempts: FALLBACK_RETRIES - FALLBACK_HEAD_RETRIES, label: "fallback" });
    return phases;
  }

  private getGeminiClient(): GeminiDirectClient | null {
    const apiKey = process.env.GEMINI_API_KEY?.trim() || "";
    if (!apiKey) return null;

    if (this.geminiClient && this.geminiClientKey === apiKey) {
      return this.geminiClient;
    }

    this.geminiClient = new GeminiDirectClient(apiKey, 30_000);
    this.geminiClientKey = apiKey;
    return this.geminiClient;
  }

  /**
   * Run all quality gates on generated narrative text.
   * [v0.4.27b] Returns structured QualityGateResult to enable content-gate-aware retry routing.
   * When contentGateEnabled=false, content-quality gates (Gate 4) are skipped entirely
   * to preserve current behavior and prevent item-loss regression.
   */
  private async applyQualityGates(
    text: string,
    item: CacheItem,
    label: string,
    attempt: number,
    maxAttempts: number,
    conversationText: string,
    contentGateEnabled: boolean,
  ): Promise<QualityGateResult> {
    const tokens = estimateTokens(text);

    // [v0.4.11] Quality gate 1: Token count & Compression ratio
    if (!checkCompressionRatio(tokens, item.estimatedTokens)) {
      console.warn(
        `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts}: compression ratio too low ` +
        `(${tokens}/${item.estimatedTokens} = ${(tokens / item.estimatedTokens * 100).toFixed(2)}% < ${MIN_COMPRESSION_RATIO * 100}%). ` +
        `Retrying for [${item.id}]...`
      );
      await this.sleep(500);
      return { pass: false, reason: "compression-ratio", isContentGate: false };
    }

    // [v0.4.11] Quality gate 2: Verbatim echo detection
    if (!checkEchoDetection(text, conversationText)) {
      console.warn(
        `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts}: verbatim echo detected for [${item.id}]. ` +
        `First ${Math.min(text.replace(/\s+/g, "").length, ECHO_SAMPLE_LENGTH)} chars match input. Retrying...`
      );
      await this.sleep(500);
      return { pass: false, reason: "verbatim-echo", isContentGate: false };
    }

    // [v0.4.17] Quality gate 3: Narrative format check
    const formatCheck = checkNarrativeFormat(text);
    if (!formatCheck.pass) {
      console.warn(
        `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts}: ${formatCheck.reason} for [${item.id}]. Retrying...`
      );
      await this.sleep(500);
      return { pass: false, reason: formatCheck.reason, isContentGate: false };
    }

    // [v0.4.27b] Quality gate 3b: Generic template phrase body-scan (content quality).
    // Unlike Gate 3 assistant-mode phrases (firstLine only), generic template phrases
    // like "It is crucial", "自然な流れを心がけ" typically appear mid-text.
    // This is a content gate (isContentGate=true) to enable early bailout routing.
    // Only active when contentGateEnabled=true to prevent item-loss regression.
    if (contentGateEnabled) {
      const bodyScanText = text.substring(0, 300).toLowerCase();
      for (const phrase of GENERIC_TEMPLATE_PHRASES) {
        if (bodyScanText.includes(phrase.toLowerCase())) {
          const reason = `narrative-content: generic-template phrase "${phrase}" detected in body`;
          console.warn(
            `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts}: ${reason} for [${item.id}]. Retrying...`
          );
          await this.sleep(500);
          return { pass: false, reason, isContentGate: true };
        }
      }
    }

    // [v0.4.27b] Quality gate 4: Anchor Coverage (content quality)
    // Only active when contentGateEnabled=true AND raw text has enough anchors for strict check.
    // When disabled (no fallback phase exists), skip entirely to preserve current behavior.
    if (contentGateEnabled) {
      const anchors = extractContentAnchors(conversationText);
      if (anchors.length >= MIN_ANCHOR_COUNT_FOR_STRICT) {
        const hits = countAnchorHits(text, anchors);
        if (hits < MIN_ANCHOR_HITS_REQUIRED) {
          const reason = `narrative-content: low-anchor-coverage (${hits}/${anchors.length} anchors present, need >=${MIN_ANCHOR_HITS_REQUIRED})`;
          console.warn(
            `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts}: ${reason} for [${item.id}]. Retrying...`
          );
          await this.sleep(500);
          return { pass: false, reason, isContentGate: true };
        }
        console.log(
          `[NarrativeWorker] ${label} anchor coverage: ${hits}/${anchors.length} anchors present (>=${MIN_ANCHOR_HITS_REQUIRED} required) for [${item.id}]`
        );
      }
    }

    return { pass: true, reason: "", isContentGate: false };
  }

  /**
   * [v0.4.19d] Attempt narrative generation with a specific model for a fixed number of attempts.
   * [v0.4.27b] Content gate early bailout: after CONTENT_GATE_REJECTS_BEFORE_FALLBACK consecutive
   * content-gate rejects, return null early to force phase handoff instead of wasting remaining attempts.
   */
  private async narrativizeWithModel(
    item: CacheItem,
    model: string,
    maxAttempts: number,
    label: string,
    contentGateEnabled: boolean = false,
  ): Promise<NarrativeResult | null> {
    const systemPrompt = this.resolveSystemPrompt();
    // [v0.4.21f] Workspace-isolated key prevents cross-workspace continuity bleed
    const previous = this.config.narrativePreviousEpisodeRef !== false
      ? this.lastNarrativeByAgent.get(`${agentWsHash(item.agentWs)}:${item.agentId}`)
      : undefined;
    const conversationText = item.rawText;
    const userMessage = this.resolveUserPrompt(previous?.body, conversationText);
    // [v0.4.27b] Track content-gate rejects across attempts for early bailout.
    // Not reset on non-content rejects (format/compression) — 3 cumulative content-rejects
    // still signals this model can't produce anchors, so early handoff is warranted.
    let contentRejectCount = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const rawText = await this.client.chatCompletion(
          { systemPrompt, userMessage },
          { modelOverride: model },
        );
        const text = sanitizeNarrativeOutput(rawText);
        const gateResult = await this.applyQualityGates(text, item, label, attempt, maxAttempts, conversationText, contentGateEnabled);
        if (!gateResult.pass) {
          // [v0.4.27b] Content gate early bailout: if this model consistently fails
          // content quality checks, stop wasting attempts and hand off to next phase
          if (gateResult.isContentGate) {
            contentRejectCount++;
            if (contentRejectCount >= CONTENT_GATE_REJECTS_BEFORE_FALLBACK) {
              console.warn(
                `[NarrativeWorker] ${label}: ${contentRejectCount} content-gate rejects for [${item.id}]. ` +
                `Forcing early handoff to next phase (attempt ${attempt + 1}/${maxAttempts}).`
              );
              return null; // triggers phase handoff in narrativizeWithRetry
            }
          }
          continue;
        }

        return {
          text,
          tokens: estimateTokens(text),
          model,
        };
      } catch (err) {
        const delayMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        const errorClass = err instanceof OpenRouterError ? err.openRouterErrorClass : "unknown";
        console.warn(
          `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts} failed [${errorClass}] for [${item.id}]: ${err instanceof Error ? err.message : String(err)}. Retrying in ${delayMs}ms...`
        );
        await this.sleep(delayMs);
      }
    }

    return null;
  }

  private async narrativizeWithGeminiModel(
    item: CacheItem,
    model: string,
    maxAttempts: number,
    label: string,
    contentGateEnabled: boolean = false,
  ): Promise<NarrativeResult | null> {
    const geminiClient = this.getGeminiClient();
    if (!geminiClient) {
      return null;
    }

    const systemPrompt = this.resolveSystemPrompt();
    const previous = this.config.narrativePreviousEpisodeRef !== false
      ? this.lastNarrativeByAgent.get(`${agentWsHash(item.agentWs)}:${item.agentId}`)
      : undefined;
    const conversationText = item.rawText;
    const userMessage = this.resolveUserPrompt(previous?.body, conversationText);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const rawText = await geminiClient.generateNarrative(
          { systemPrompt, userMessage },
          { modelOverride: model },
        );
        const text = sanitizeNarrativeOutput(rawText);
        const gateResult = await this.applyQualityGates(text, item, label, attempt, maxAttempts, conversationText, contentGateEnabled);
        if (!gateResult.pass) continue;
        // [v0.4.27b] Note: no content-gate early bailout here because Gemini phases
        // have contentGateEnabled=false (last-resort, must save something). If that
        // changes, add contentRejectCount tracking same as narrativizeWithModel.

        return {
          text,
          tokens: estimateTokens(text),
          model,
        };
      } catch (err) {
        const delayMs = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS);
        const errorClass = err instanceof GeminiDirectError ? err.geminiErrorClass : "unknown";
        console.warn(
          `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts} failed [${errorClass}] for [${item.id}]: ${err instanceof Error ? err.message : String(err)}. Retrying in ${delayMs}ms...`
        );
        await this.sleep(delayMs);
      }
    }

    return null;
  }

  /**
   * [v0.4.19d] Fast hash for rawText deduplication.
   * Uses first 500 chars + length — collision probability < 10^-9 for dedup purposes.
   */
  private hashRawText(rawText: string): string {
    const prefix = rawText.slice(0, 500);
    let hash = 0;
    for (let i = 0; i < prefix.length; i++) {
      hash = ((hash << 5) - hash + prefix.charCodeAt(i)) | 0;
    }
    return `${hash}_${rawText.length}`;
  }

  /** [v0.4.19d] Prune expired entries from the save hash map. */
  private pruneSaveHashes(): void {
    const now = Date.now();
    for (const [key, ts] of this.recentSaveHashes) {
      if (now - ts > SAVE_HASH_TTL_MS) {
        this.recentSaveHashes.delete(key);
      }
    }
  }

  // ─── [v0.4.21b] Save hash persistence ─────────────────────────────────

  /** [v0.4.21b] Persist recentSaveHashes to state DB so they survive restarts.
   *  [v0.4.21c] Only persists entries for the calling agent (scoped key filtering).
   *  Debounced: only writes every SAVE_HASH_PERSIST_INTERVAL saves to reduce DB I/O.
   *  In-memory map is the primary guard; DB is a restart-recovery backup.
   */
  private persistSaveHashes(agentWs: string, agentId: string): void {
    if (!agentWs || !agentId) return;
    // [v0.4.21e] Per-agent counter with hash identity: isolate debounce timing across agents
    const agentKey = `${agentWsHash(agentWs)}:${agentId}`;
    const count = (this.saveHashPersistCounters.get(agentKey) ?? 0) + 1;
    this.saveHashPersistCounters.set(agentKey, count);
    if (count % this.SAVE_HASH_PERSIST_INTERVAL !== 0) return;
    // [v0.4.21e] Filter to only this agent's entries (scoped key uses hash identity)
    const prefix = `${agentWsHash(agentWs)}:${agentId}:`;
    const entries = Array.from(this.recentSaveHashes.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, timestamp]) => ({ key: key.slice(prefix.length), timestamp })); // DB stores rawHash only
    this.rpcClient.setNarrativeSaveHashes(agentWs, agentId, entries)
      .catch((err) => console.warn("[NarrativeWorker] Failed to persist save hashes:", err));
  }

  /** [v0.4.21b] Load persisted save hashes from state DB into memory.
   *  [v0.4.21c] Restored entries are scoped with agentWs:agentId: prefix
   *  to maintain agent/workspace isolation in the in-memory Map.
   */
  private async loadSaveHashes(agentWs: string, agentId: string): Promise<void> {
    if (!agentWs || !agentId) return;
    try {
      const loaded = await this.rpcClient.getNarrativeSaveHashes(agentWs, agentId);
      if (loaded.length > 0) {
        const now = Date.now();
        const prefix = `${agentWsHash(agentWs)}:${agentId}:`;
        let restoredCount = 0;
        for (const h of loaded) {
          // Only restore entries that haven't expired
          if (now - h.timestamp <= SAVE_HASH_TTL_MS) {
            // [v0.4.21c] Add scoped prefix so in-memory Map is agent-isolated
            this.recentSaveHashes.set(`${prefix}${h.key}`, h.timestamp);
            restoredCount++;
          }
        }
        console.log(`[NarrativeWorker] Restored ${restoredCount} save hashes from state DB for agent ${agentId}`);
      }
    } catch (err) {
      console.warn("[NarrativeWorker] Failed to load save hashes from state DB:", err);
    }
  }

  private async saveNarrative(result: NarrativeResult, item: CacheItem): Promise<void> {
    // [v0.4.19d] Idempotency guard: skip duplicate saves within TTL window
    // [v0.4.21c] Scoped key: agentWs:agentId:rawHash to prevent cross-agent dedup
    const rawHash = this.hashRawText(item.rawText);
    const scopedKey = `${agentWsHash(item.agentWs)}:${item.agentId}:${rawHash}`;
    const now = Date.now();

    this.pruneSaveHashes();
    if (this.recentSaveHashes.has(scopedKey)) {
      const savedAt = this.recentSaveHashes.get(scopedKey)!;
      const ageMin = ((now - savedAt) / 60000).toFixed(1);
      console.warn(
        `[NarrativeWorker] Duplicate save detected for [${item.id}] (scopedHash=${scopedKey}, ` +
        `previously saved ${ageMin}min ago). Skipping batchIngest.`
      );
      // [v0.4.21c] Ack is handled by caller (processNextFromCache) — removed from here to prevent double-ack
      return;
    }

    try {
      const tags = ["narrative", item.source === "live-turn" ? "auto-segmented" : "cold-start-import"];

      await this.rpcClient.batchIngest(
        [
          {
            summary: result.text,
            tags,
            topics: [],
            edges: [],
            surprise: item.surprise ?? 0,
            depth: 0,
            tokens: result.tokens,
          },
        ],
        item.agentWs,
        item.agentId,
      );
      // Record hash to prevent duplicate saves within TTL (scoped per agent/workspace)
      this.recentSaveHashes.set(scopedKey, now);
      // [v0.4.21b] Persist save hashes to state DB so they survive restarts
      this.persistSaveHashes(item.agentWs, item.agentId);
      // Only update continuity state for successfully narrativized content
      // (fallback summaries no longer reach this path — they are re-queued via cacheRetry)
      // [v0.4.21f] Workspace-isolated key prevents cross-workspace continuity bleed
      this.lastNarrativeByAgent.set(`${agentWsHash(item.agentWs)}:${item.agentId}`, { episodeId: `narrative-${now}`, body: result.text });
    } catch (err) {
      console.error("[NarrativeWorker] Failed to save narrative episode:", err);
      throw err;
    }
  }

  private resolveSystemPrompt(): string {
    const custom = this.config.narrativeSystemPrompt;
    if (custom && custom.trim().length > 0) return custom.trim();
    return DEFAULT_SYSTEM_PROMPT;
  }

  private resolveUserPrompt(previousEpisode: string | undefined, conversationText: string): string {
    const custom = this.config.narrativeUserPromptTemplate;
    if (custom && custom.trim().length > 0) {
      return custom
        .replace("{previousEpisode}", previousEpisode || "")
        .replace("{conversationText}", conversationText);
    }
    return DEFAULT_USER_PROMPT_TEMPLATE(previousEpisode, conversationText);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
