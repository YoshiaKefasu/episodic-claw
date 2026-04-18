/**
 * NarrativePool — Buffers conversation messages and flushes when size limit is reached.
 * KISS: Simple char-count tracking, returns PoolFlushItem when flush is needed.
 */

import { extractText } from "./segmenter";
import type { Message } from "./segmenter";
import { PoolFlushItem } from "./types";

export class NarrativePool {
  private buffer: Message[] = [];
  private charCount: number = 0;
  private maxPoolChars: number;

  constructor(maxPoolChars: number) {
    this.maxPoolChars = Math.max(1000, maxPoolChars);
  }

  /**
   * Add messages to the pool. Returns a PoolFlushItem if maxPoolChars is exceeded.
   * The caller is responsible for clearing the buffer after receiving the item.
   */
  add(messages: Message[], surprise: number, agentWs: string, agentId: string): PoolFlushItem | null {
    // Add messages to buffer
    for (const m of messages) {
      const text = extractText(m.content);
      this.buffer.push(m);
      this.charCount += text.length;
    }

    // Check if flush is needed
    if (this.charCount >= this.maxPoolChars) {
      return this.buildFlushItem("size-limit", surprise, agentWs, agentId);
    }

    return null;
  }

  /**
   * Force flush all buffered messages regardless of size.
   * Returns null if buffer is empty.
   */
  forceFlush(agentWs: string, agentId: string): PoolFlushItem | null {
    if (this.buffer.length === 0) return null;
    return this.buildFlushItem("force-flush", 0, agentWs, agentId);
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
