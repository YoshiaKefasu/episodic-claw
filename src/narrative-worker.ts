/**
 * NarrativeWorker — Async narrative generation worker (v0.4.2 pull-based).
 * Pulls chunks from the Go cache DB via LeaseNext, narrativizes via OpenRouter,
 * and Ack/Retries the cache job. Per-agent continuity state is maintained.
 */

import { estimateTokens, agentWsHash } from "./utils";
import { OpenRouterClient, OpenRouterError } from "./openrouter-client";
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
// [AUDIT NOTE] This is an intentional trade-off (v0.4.12 Phase E), NOT a bug:
// - Echoes always appear near the beginning of input (model echoes the first ~200 tokens)
// - Scanning beyond 5000 chars would catch tail echoes but at 85% more memory cost (192KB copy)
// - False negatives (tail echoes) are low-impact: output is still a narrative, just with some verbatim at the end

// Use the canonical queue item type (avoids type duplication with narrative-queue.ts)
type CacheItem = CacheQueueItem;

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
  ];
  for (const phrase of assistantPhrases) {
    if (firstLine.trimStart().startsWith(phrase)) {
      return { pass: false, reason: `narrative-format: assistant-mode phrase "${phrase}" detected` };
    }
  }

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
    const models = this.getRetryModels();

    for (const { model, maxAttempts, label } of models) {
      console.log(`[NarrativeWorker] Phase "${label}": trying model=${model}, maxAttempts=${maxAttempts}`);

      const result = await this.narrativizeWithModel(item, model, maxAttempts, label);
      if (result) return result;

      if (model !== models[models.length - 1].model) {
        console.warn(
          `[NarrativeWorker] Phase "${label}" exhausted for [${item.id}]. Falling back to next model...`
        );
      }
    }

    return null;
  }

  /**
   * [v0.4.19d] Determine retry model sequence.
   * - If primary model is "openrouter/free" (default), single phase with MAX_RETRIES.
   * - If primary model is custom, two phases: primary (MAX_RETRIES) + fallback (FALLBACK_RETRIES).
   */
  private getRetryModels(): Array<{ model: string; maxAttempts: number; label: string }> {
    const primary = this.config.openrouterModel ?? "openrouter/free";
    const fallback = "openrouter/free";

    if (primary === fallback) {
      // Default: openrouter/free only → single phase
      return [{ model: primary, maxAttempts: MAX_RETRIES, label: "primary" }];
    }

    // Custom model: primary (12 attempts) + fallback (3 attempts)
    return [
      { model: primary, maxAttempts: MAX_RETRIES, label: "primary" },
      { model: fallback, maxAttempts: FALLBACK_RETRIES, label: "fallback" },
    ];
  }

  /**
   * [v0.4.19d] Attempt narrative generation with a specific model for a fixed number of attempts.
   */
  private async narrativizeWithModel(
    item: CacheItem,
    model: string,
    maxAttempts: number,
    label: string,
  ): Promise<NarrativeResult | null> {
    const systemPrompt = this.resolveSystemPrompt();
    // [v0.4.21f] Workspace-isolated key prevents cross-workspace continuity bleed
    const previous = this.config.narrativePreviousEpisodeRef !== false
      ? this.lastNarrativeByAgent.get(`${agentWsHash(item.agentWs)}:${item.agentId}`)
      : undefined;
    const conversationText = item.rawText;
    const userMessage = this.resolveUserPrompt(previous?.body, conversationText);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const rawText = await this.client.chatCompletion(
          { systemPrompt, userMessage },
          { modelOverride: model },
        );
        const text = sanitizeNarrativeOutput(rawText);
        const tokens = estimateTokens(text);

        // [v0.4.11] Quality gate 1: Token count & Compression ratio
        if (!checkCompressionRatio(tokens, item.estimatedTokens)) {
          console.warn(
            `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts}: compression ratio too low ` +
            `(${tokens}/${item.estimatedTokens} = ${(tokens / item.estimatedTokens * 100).toFixed(2)}% < ${MIN_COMPRESSION_RATIO * 100}%). ` +
            `Retrying for [${item.id}]...`
          );
          await this.sleep(500);
          continue;
        }

        // [v0.4.11] Quality gate 2: Verbatim echo detection
        if (!checkEchoDetection(text, conversationText)) {
          console.warn(
            `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts}: verbatim echo detected for [${item.id}]. ` +
            `First ${Math.min(text.replace(/\s+/g, "").length, ECHO_SAMPLE_LENGTH)} chars match input. Retrying...`
          );
          await this.sleep(500);
          continue;
        }

        // [v0.4.17] Quality gate 3: Narrative format check
        const formatCheck = checkNarrativeFormat(text);
        if (!formatCheck.pass) {
          console.warn(
            `[NarrativeWorker] ${label} attempt ${attempt + 1}/${maxAttempts}: ${formatCheck.reason} for [${item.id}]. Retrying...`
          );
          await this.sleep(500);
          continue;
        }

        return {
          text,
          tokens,
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
