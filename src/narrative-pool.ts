/**
 * NarrativePool — Passive accumulator for conversation messages.
 * Flush triggers are decided by segmenter (surprise / 64K / idle / time-gap / force-flush).
 */

import { extractText } from "./segmenter";
import type { Message } from "./segmenter";
import { PoolFlushItem } from "./types";

export class NarrativePool {
  private buffer: Message[] = [];
  private charCount: number = 0;

  constructor() {}

  /**
   * Add messages to the pool (passive accumulator — always returns null).
   * Flush triggers are decided by segmenter only:
   * surprise / 64K hard cap (HARD_TOKEN_CAP) / idle / time-gap / force-flush.
   */
  add(messages: Message[], surprise: number, agentWs: string, agentId: string): PoolFlushItem | null {
    // Add messages to buffer
    for (const m of messages) {
      const text = extractText(m.content);
      this.buffer.push(m);
      this.charCount += text.length;
    }

    // Flush is triggered by segmenter boundaries only (surprise/64K/idle/time-gap/force-flush).
    return null;
  }

  /**
   * Force flush all buffered messages regardless of size.
   * Optional surpriseOverride lets segmenter preserve boundary surprise
   * when triggering immediate flush (e.g., surprise/time-gap boundary).
   * Returns null if buffer is empty.
   */
  forceFlush(agentWs: string, agentId: string, surpriseOverride: number = 0): PoolFlushItem | null {
    if (this.buffer.length === 0) return null;
    return this.buildFlushItem("force-flush", surpriseOverride, agentWs, agentId);
  }

  /** Current character count in the pool */
  get currentChars(): number {
    return this.charCount;
  }

  /** Clear the internal buffer (called by the segmenter after receiving a flush item) */
  clear(): void {
    this.buffer = [];
    this.charCount = 0;
  }

  private buildFlushItem(reason: PoolFlushItem["reason"], surprise: number, agentWs: string, agentId: string): PoolFlushItem {
    // [v0.4.19b] Role labels for conversation-boundary-aware chunking + narrative model context
    // Format: "role: text" — only for primary conversation roles (user, assistant)
    const rawText = this.buffer
      .map((m) => {
        const text = extractText(m.content);
        if (!text) return "";
        const role = m.role === "user" || m.role === "assistant" ? m.role : null;
        return role ? `${role}: ${text}` : text;
      })
      .filter(Boolean)
      .join("\n");

    return {
      messages: [...this.buffer],
      rawText,
      surprise,
      reason,
      agentWs,
      agentId,
    };
  }
}
