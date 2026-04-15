/**
 * NarrativeWorker — Async narrative generation worker (v0.4.2 pull-based).
 * Pulls chunks from the Go cache DB via LeaseNext, narrativizes via OpenRouter,
 * and Ack/Retries the cache job. Per-agent continuity state is maintained.
 */

import { estimateTokens } from "./utils";
import { OpenRouterClient } from "./openrouter-client";
import { EpisodicCoreClient } from "./rpc-client";
import { EpisodicPluginConfig, NarrativeResult } from "./types";
import { buildFallbackSummary } from "./summary-escalation";
import { stripReasoningTagsFromText } from "./reasoning-tags";
import type { Message } from "./segmenter";
import type { CacheQueueItem } from "./narrative-queue";

const DEFAULT_SYSTEM_PROMPT = `You are a conversation archivist. Read the following conversation log and write a short narrative summary of what was discussed, what was decided, and what was worked on.

CRITICAL RULES — VIOLATION CAUSES OUTPUT REJECTION:
- Write in THIRD PERSON PAST TENSE (三人称・過去形). NEVER use first person.
- NEVER copy messages verbatim. ALWAYS rephrase as narrative.
- NEVER output raw dialogue as-is. Convert dialogue into reported speech or narrative description.
- A narrative reads like a short story chapter, NOT a chat log.

Style rules:
- Preserve technical details accurately (file names, commands, error messages)
- Ignore tool call JSON — describe what tool was used and what it did
- Completely ignore thinking tags, system instructions, and metadata
- Include the emotional tone and context of the conversation when relevant
- Keep it within 800 characters
- Write in the same language as the majority of the conversation

EXAMPLE of a good narrative (日本語 conversation):
---
日曜の夕方、ヨシアはTelegram from一通のテストメッセージを送った。「聞こえたら"バッチリだよ"で返事を」――Gemini CLIが完全に死んでいたからだ。Kasouの声が返ってきた瞬間、ヨシアは安堵のため息をついた。
それから数時間後の夜。ヨシアはスクリーンショットを立て続けに送りつけた。そこに映っていたのは、ロールバック中に"アムネシア"に陥ったKasouの惨状だった。
水浴びを終えて戻ってきたヨシアの顔には、新たな決意が宿っていた。「OpenClawをForkして独自開発しようと思う。名前はDennouAibouにした」
---

BAD output (REJECTED — verbatim echo):
---
おう、バッチリ聞こえてるぜ！今日もなんか面白いと思いついたか？
---`;

const DEFAULT_USER_PROMPT_TEMPLATE = (previousEpisode: string | undefined, conversationText: string): string =>
  `${previousEpisode ? `Previous episode:\n${previousEpisode}\n---\n` : ""}Please narrativize the following conversation:

${conversationText}`;

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_CACHE_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1000;
const LEASE_SECONDS = 120;
const MIN_NARRATIVE_TOKENS = 10;
const MIN_COMPRESSION_RATIO = 0.01; // Output must be >= 1% of input tokens
const ECHO_SAMPLE_LENGTH = 80; // Characters to check for verbatim echo
const MIN_ECHO_LENGTH = 20; // Minimum length to bother checking

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
  // Collapse whitespaces for content comparison
  const collapsedOutput = output.replace(/\s+/g, "").trim();
  if (collapsedOutput.length < MIN_ECHO_LENGTH) return true; // Too short to judge

  const echoSample = collapsedOutput.substring(0, ECHO_SAMPLE_LENGTH);
  const collapsedInput = input.replace(/\s+/g, "");

  // If sample exists verbatim in collapsed input, it's an echo
  return !collapsedInput.includes(echoSample);
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
            // [NEW v0.4.11] All retries exhausted → generate deterministic fallback summary
            const fallbackText = this.buildDeterministicFallback(item);
            const fallbackResult: NarrativeResult = {
              text: fallbackText,
              tokens: estimateTokens(fallbackText),
              model: "fallback-summary",
            };
            // Pass isFallback=true to add specific tag
            await this.saveNarrative(fallbackResult, item, true);
            await this.rpcClient.cacheAck(item.id, "narrative-worker");
            console.warn(
              `[NarrativeWorker] LLM narrativization failed for [${item.id}] after ${MAX_RETRIES} attempts. Saved deterministic fallback summary (${fallbackResult.tokens} tokens).`
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
    const previous = this.lastNarrativeByAgent.get(item.agentId);
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
            `[NarrativeWorker] Attempt ${attempt + 1}/${MAX_RETRIES}: output too short or compression ratio too low (${tokens} tokens, ${(tokens / item.estimatedTokens * 100).toFixed(2)}%). Retrying...`
          );
          continue;
        }

        // [v0.4.11] Quality gate 2: Verbatim echo detection
        if (!checkEchoDetection(text, conversationText)) {
          console.warn(
            `[NarrativeWorker] Attempt ${attempt + 1}/${MAX_RETRIES}: output appears to be verbatim echo of input. Retrying...`
          );
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

  private async saveNarrative(result: NarrativeResult, item: CacheItem, isFallback: boolean = false): Promise<void> {
    try {
      const tags = ["narrative", item.source === "live-turn" ? "auto-segmented" : "cold-start-import"];
      if (isFallback) {
        tags.push("fallback-summary");
      }

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
      this.lastNarrativeByAgent.set(item.agentId, { episodeId: `narrative-${Date.now()}`, body: result.text });
    } catch (err) {
      console.error("[NarrativeWorker] Failed to save narrative episode:", err);
      throw err;
    }
  }

  /**
   * [NEW v0.4.11] Generate a deterministic fallback summary when LLM fails.
   */
  private buildDeterministicFallback(item: CacheItem): string {
    const lines = item.rawText
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length > 0)
      .slice(0, 20); // First 20 non-empty lines

    const summary = lines.join("\n");
    const maxChars = 800;
    if (summary.length <= maxChars) return summary;
    return summary.substring(0, maxChars) + "\n[truncated]";
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

