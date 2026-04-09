/**
 * NarrativeWorker — Async narrative generation worker.
 * Queues conversation segments, sends them to OpenRouter for narrativization,
 * and falls back to raw log saving on failure.
 * KISS: Single concurrent request, FIFO queue, exponential backoff retry.
 */

import { estimateTokens } from "./utils";
import { OpenRouterClient } from "./openrouter-client";
import { EpisodicCoreClient } from "./rpc-client";
import { EpisodicPluginConfig, PoolFlushItem, NarrativeResult } from "./types";
import { buildFallbackSummary } from "./summary-escalation";
import type { Message } from "./segmenter";

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

export class NarrativeWorker {
  private queue: PoolFlushItem[] = [];
  private isProcessing = false;
  private lastFullEpisode = ""; // Previous episode full text for context continuity

  constructor(
    private client: OpenRouterClient,
    private rpcClient: EpisodicCoreClient,
    private config: EpisodicPluginConfig,
  ) {}

  /**
   * Enqueue a conversation segment for narrativization.
   * Fire-and-forget: processing happens asynchronously.
   */
  async enqueue(item: PoolFlushItem): Promise<void> {
    this.queue.push(item);
    if (!this.isProcessing) {
      this.processNext().catch((err) => {
        console.error("[NarrativeWorker] Unhandled error in processNext:", err);
      });
    }
  }

  /**
   * Drain the queue — wait until all queued items are processed.
   * Used for graceful shutdown (session_end / gateway_stop).
   */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.isProcessing) {
      await this.sleep(100);
    }
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        const result = await this.narrativizeWithRetry(item);
        if (result) {
          await this.saveNarrative(result, item);
          this.lastFullEpisode = result.text;
        } else {
          await this.saveRawFallback(item);
        }
      } catch (err) {
        console.error("[NarrativeWorker] Failed to process item:", err);
        await this.saveRawFallback(item);
      }
    }

    this.isProcessing = false;
  }

  private async narrativizeWithRetry(item: PoolFlushItem): Promise<NarrativeResult | null> {
    const systemPrompt = this.resolveSystemPrompt();
    const userMessage = this.resolveUserPrompt(item);

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
          `[NarrativeWorker] Narrativize attempt ${attempt + 1}/${MAX_RETRIES} failed: ${err instanceof Error ? err.message : String(err)}. Retrying in ${delayMs}ms...`
        );
        await this.sleep(delayMs);
      }
    }

    return null; // All retries exhausted
  }

  private async saveNarrative(result: NarrativeResult, item: PoolFlushItem): Promise<void> {
    try {
      const tags = ["narrative", item.reason === "force-flush" ? "manual-save" : "auto-segmented"];
      await this.rpcClient.batchIngest(
        [
          {
            summary: result.text,
            tags,
            topics: [],
            edges: [],
            surprise: item.surprise,
            depth: 0,
            tokens: result.tokens,
          },
        ],
        item.agentWs,
        item.agentId,
      );
      console.log(
        `[NarrativeWorker] Saved narrative episode for ${item.agentId} (${result.tokens} tokens, model: ${result.model})`
      );
    } catch (err) {
      console.error("[NarrativeWorker] Failed to save narrative episode:", err);
      await this.saveRawFallback(item);
    }
  }

  private async saveRawFallback(item: PoolFlushItem): Promise<void> {
    try {
      const fallbackText = buildFallbackSummary(item.messages);
      const tags = ["fallback", "auto-segmented"];
      await this.rpcClient.batchIngest(
        [
          {
            summary: fallbackText,
            tags,
            topics: [],
            edges: [],
            surprise: item.surprise,
            depth: 0,
            tokens: estimateTokens(fallbackText),
          },
        ],
        item.agentWs,
        item.agentId,
      );
      console.warn(
        `[NarrativeWorker] Fallback: saved raw summary for ${item.agentId} (${item.reason})`
      );
    } catch (err) {
      console.error("[NarrativeWorker] Fallback save also failed:", err);
    }
  }

  private resolveSystemPrompt(): string {
    const custom = this.config.narrativeSystemPrompt;
    if (custom && custom.trim().length > 0) return custom.trim();
    return DEFAULT_SYSTEM_PROMPT;
  }

  private resolveUserPrompt(item: PoolFlushItem): string {
    const custom = this.config.narrativeUserPromptTemplate;
    const conversationText = item.messages
      .map((m) => {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        return `${m.role}: ${text}`;
      })
      .join("\n");

    if (custom && custom.trim().length > 0) {
      const previousRef = this.config.narrativePreviousEpisodeRef ?? true;
      const previousEpisode = previousRef && this.lastFullEpisode ? this.lastFullEpisode : "";
      return custom
        .replace("{previousEpisode}", previousEpisode)
        .replace("{conversationText}", conversationText);
    }

    const previousRef = this.config.narrativePreviousEpisodeRef ?? true;
    const previousEpisode = previousRef && this.lastFullEpisode ? this.lastFullEpisode : undefined;
    return DEFAULT_USER_PROMPT_TEMPLATE(previousEpisode, conversationText);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
