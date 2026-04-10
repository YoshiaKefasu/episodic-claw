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
import type { Message } from "./segmenter";
import type { CacheQueueItem } from "./narrative-queue";

const DEFAULT_SYSTEM_PROMPT = `You are a conversation archivist. Read the following conversation log and write a short narrative summary of what was discussed, what was decided, and what was worked on.

Rules:
- Preserve technical details accurately (file names, commands, error messages)
- Ignore tool call JSON — describe what tool was used and what it did
- Completely ignore thinking tags, system instructions, and metadata
- Include the emotional tone and context of the conversation when relevant
- Keep it within 800 characters`;

const DEFAULT_USER_PROMPT_TEMPLATE = (previousEpisode: string | undefined, conversationText: string): string =>
  `${previousEpisode ? `Previous episode:\n${previousEpisode}\n---\n` : ""}Please narrativize the following conversation:

${conversationText}`;

const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_CACHE_ATTEMPTS = 20;
const POLL_INTERVAL_MS = 1000;
const LEASE_SECONDS = 120;

// Use the canonical queue item type (avoids type duplication with narrative-queue.ts)
type CacheItem = CacheQueueItem;

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
   * Idempotent: safe to call multiple times.
   * Clears any pending poll timer and schedules an immediate poll.
   */
  wake(): void {
    this.consecutiveEmptyPolls = 0;
    this.nextPollDelayMs = POLL_INTERVAL_MS;
    // Always clear the pending timer and poll immediately — don't wait for idle backoff
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
      this.pollNext();
    }
  }

  /**
   * Start polling the cache queue for items to narrativize.
   * Fire-and-forget: runs in the background until stop() is called.
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
    // Wait for current narrativization to finish (up to 15s)
    let waited = 0;
    while (this.isProcessing && waited < 15000) {
      await this.sleep(100);
      waited += 100;
    }
  }

  /**
   * Initialize continuity state by loading the latest narrative episode per agent.
   * Also populates the knownAgentIds set for multi-agent polling.
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
        // No continuity available yet — that's fine
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
      // Poll each known agent ID (multi-agent support)
      const agentIds = this.knownAgentIds.size > 0 ? Array.from(this.knownAgentIds) : ["main"];
      for (const agentId of agentIds) {
        const item = await this.rpcClient.cacheLeaseNext("narrative-worker", agentId, LEASE_SECONDS);
        if (!item) continue; // No items for this agent, try next

        // Got an item — reset idle backoff
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
            await this.rpcClient.cacheRetry(item.id, "narrative-worker", "Narrativization returned empty", MAX_CACHE_ATTEMPTS);
            console.log(`[NarrativeWorker] Returned chunk [${item.id}] to queue after empty result.`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await this.rpcClient.cacheRetry(item.id, "narrative-worker", errMsg, MAX_CACHE_ATTEMPTS);
          console.log(`[NarrativeWorker] Returned chunk [${item.id}] to queue. attempts increased error=${errMsg}`);
        }
        // Process one item per poll cycle to avoid starvation
        return;
      }

      // All agents returned empty — increase backoff for next poll
      this.consecutiveEmptyPolls++;
      this.nextPollDelayMs = Math.min(this.MAX_POLL_DELAY_MS, this.nextPollDelayMs * 2);

      // Log idle backoff state periodically (every ~5 minutes worth of polls at cap)
      if (this.consecutiveEmptyPolls > 0 && this.consecutiveEmptyPolls % 20 === 0) {
        console.log(`[NarrativeWorker] Idle backoff: ${this.consecutiveEmptyPolls} empty polls, next in ${this.nextPollDelayMs}ms`);
      }
    } catch (err) {
      // Polling error — just retry after interval
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
        const text = await this.client.chatCompletion({ systemPrompt, userMessage });
        return {
          text,
          tokens: estimateTokens(text),
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
      // Update continuity state
      this.lastNarrativeByAgent.set(item.agentId, { episodeId: `narrative-${Date.now()}`, body: result.text });
    } catch (err) {
      console.error("[NarrativeWorker] Failed to save narrative episode:", err);
      throw err; // Let caller handle via cache retry
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
