/**
 * NarrativeWorker — Async narrative generation worker (v0.4.2 pull-based).
 * Pulls chunks from the Go cache DB via LeaseNext, narrativizes via OpenRouter,
 * and Ack/Retries the cache job. Per-agent continuity state is maintained.
 */

import { estimateTokens } from "./utils";
import { OpenRouterClient } from "./openrouter-client";
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
const DEFAULT_USER_PROMPT_TEMPLATE = (previousEpisode: string | undefined, conversationText: string): string =>
  `HIGHEST PRIORITY. Violating any rule below makes the output invalid.

Output spec:
Third-person past tense only. One continuous narrative body. Start from the very first character with the story.
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

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
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
  const cotPrefixPat = /^(?:(?:Okay[,.]?\s*)?(?:let me|I need|I should|I'll|first|I have to)[^.]*\.\s*\n?)+/im;
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

  // Gate 2: English planning phrase in first 100 chars (CoT leakage)
  const cotPatterns = [
    /\bOkay\b.*\b(let me|I need|I should|I'll|first)\b/i,
    /\bLet me\b.*\b(parse|understand|analyze|start|think)\b/i,
    /\bFirst,?\s+I\s+(need|should|will|must)\b/i,
    /\bI need to\b.*\b(parse|understand|focus|ensure)\b/i,
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
    "ありがとうございます",
    "以下の通りです",
    "まとめました",
    "今後の展望",
    "要点をまとめ",
    "お手伝いします",
  ];
  for (const phrase of assistantPhrases) {
    if (firstLine.trimStart().startsWith(phrase)) {
      return { pass: false, reason: `narrative-format: assistant-mode phrase "${phrase}" detected` };
    }
  }

  // Gate 4: Emoji / kaomoji
  const emojiPat = /[\p{Emoji_Presentation}\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}≧∇≦]/u;
  if (emojiPat.test(text)) {
    return { pass: false, reason: "narrative-format: emoji or kaomoji detected" };
  }

  // Gate 5: First line doesn't look like narrative start
  // Narrative starts with: CJK character, or proper noun, or time expression
  // Assistant starts with: greeting, explanation, or English planning
  const narrativeStartPat = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}A-Z\u00C0-\u017F"「『]/u;
  if (!narrativeStartPat.test(firstLine.trim())) {
    // Allow lowercase Latin starts (some narratives start with "the", "a")
    if (!/^[a-z]/.test(firstLine.trim())) {
      return { pass: false, reason: "narrative-format: first line doesn't look like narrative start" };
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
          this.lastNarrativeByAgent.set(agentId, { episodeId: result.episodeId, body: result.body });
          console.log(`[NarrativeWorker] Loaded continuity for agent ${agentId}: ${result.episodeId}`);
        }
      } catch (err) {
        // No continuity available yet
      }
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
    const systemPrompt = this.resolveSystemPrompt();
    // Respect narrativePreviousEpisodeRef config — when explicitly false, skip injecting previous episode
    // Use !== false so that undefined (unset) defaults to including previous episode
    const previous = this.config.narrativePreviousEpisodeRef !== false
      ? this.lastNarrativeByAgent.get(item.agentId)
      : undefined;
    const conversationText = item.rawText;
    const userMessage = this.resolveUserPrompt(previous?.body, conversationText);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const rawText = await this.client.chatCompletion({ systemPrompt, userMessage });
        const text = sanitizeNarrativeOutput(rawText);
        const tokens = estimateTokens(text);

        // [v0.4.11] Quality gate 1: Token count & Compression ratio
        if (!checkCompressionRatio(tokens, item.estimatedTokens)) {
          console.warn(
            `[NarrativeWorker] Attempt ${attempt + 1}/${MAX_RETRIES}: compression ratio too low ` +
            `(${tokens}/${item.estimatedTokens} = ${(tokens / item.estimatedTokens * 100).toFixed(2)}% < ${MIN_COMPRESSION_RATIO * 100}%). ` +
            `Retrying for [${item.id}]...`
          );
          await this.sleep(500); // [v0.4.12] Brief pause before retry — free models tend to produce similar output without pause
          continue;
        }

        // [v0.4.11] Quality gate 2: Verbatim echo detection
        if (!checkEchoDetection(text, conversationText)) {
          console.warn(
            `[NarrativeWorker] Attempt ${attempt + 1}/${MAX_RETRIES}: verbatim echo detected for [${item.id}]. ` +
            `First ${Math.min(text.replace(/\s+/g, "").length, ECHO_SAMPLE_LENGTH)} chars match input. Retrying...`
          );
          await this.sleep(500); // [v0.4.12] Brief pause before retry
          continue;
        }

        // [v0.4.17] Quality gate 3: Narrative format check
        const formatCheck = checkNarrativeFormat(text);
        if (!formatCheck.pass) {
          console.warn(
            `[NarrativeWorker] Attempt ${attempt + 1}/${MAX_RETRIES}: ${formatCheck.reason} for [${item.id}]. Retrying...`
          );
          await this.sleep(500);
          continue;
        }

        return {
          text,
          tokens,
          model: this.config.openrouterModel ?? "openrouter/free",
        };
      } catch (err) {
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[NarrativeWorker] Attempt ${attempt + 1}/${MAX_RETRIES} failed for [${item.id}]: ${err instanceof Error ? err.message : String(err)}. Retrying in ${delayMs}ms...`
        );
        await this.sleep(delayMs);
      }
    }

    return null;
  }

  private async saveNarrative(result: NarrativeResult, item: CacheItem): Promise<void> {
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
      // Only update continuity state for successfully narrativized content
      // (fallback summaries no longer reach this path — they are re-queued via cacheRetry)
      this.lastNarrativeByAgent.set(item.agentId, { episodeId: `narrative-${Date.now()}`, body: result.text });
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

