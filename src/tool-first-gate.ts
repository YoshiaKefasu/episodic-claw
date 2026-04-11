/**
 * Tool-first recall conditional execution filter (v0.4.6).
 *
 * Implements the fast-path gate pipeline:
 *   novelty -> intent -> fingerprint -> negative cache
 *
 * All checks are memory-only, no network I/O.
 * Target: p95 <= 3.0ms on 2010-era CPU.
 *
 * Per-agent isolation: gate state (fingerprints, negative cache, turn counter)
 * is scoped by agentId to prevent cross-agent leakage.
 */

import { createHash } from "crypto";
import type {
  ToolFirstRecallConfig,
  ToolFirstGateResult,
  ToolFirstSkipReason,
  NegativeCacheEntry,
} from "./types";
import type { Message } from "./segmenter";
import { extractText } from "./segmenter";
import { stripReasoningTagsFromText } from "./reasoning-tags";

// ─── Novelty gate ────────────────────────────────────────────────────────────
// Low-information messages that should skip recall entirely.

const NOVELTY_SKIP_PATTERNS = [
  // Japanese
  /^[\s\u3000]*(ok|Okay|了解|りょ|はい|ええ|うん|うーん|ふむ|なるほど|ありがとう|thanks|thx|てきとう|okです|ok!|ok！|わかった|はい！|了解！|OK!|OK！)[\s\u3000]*$/i,
  // English
  /^[\s]*(ok|okay|sure|yes|yeah|nope|no|thanks|thx|got it|gotcha|i see|uh|hmm|wow|nice|cool|great|alright|right|ok!|ok!)[\s]*$/i,
  // Minimal punctuation / emoji only
  /^[\s\p{Extended_Pictographic}\p{Punctuation}]*$/u,
  // Very short acknowledgments
  /^(笑|w+|ｗ+|草|ok|yes|no)[\s\u3000]*$/i,
];

function noveltyCheck(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false; // empty = fail novelty (delegate to empty_query)
  for (const pattern of NOVELTY_SKIP_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }
  return true;
}

// ─── Intent gate ─────────────────────────────────────────────────────────────
// Check if the message has memory-reference intent: past reference, ongoing task, comparison, re-confirmation.

const INTENT_SIGNAL_PATTERNS = [
  // Past reference
  /\b(before|earlier|previously|past|last time|ago|yesterday|before|以前|前に|前回|この前|さっき|前)\b/i,
  // Ongoing task / continuity
  /\b(continue|still|remain|unfinished|ongoing|resume|progress|まだ|続き|継続|そのまま|引き続き|続けて|進捗)\b/i,
  // Comparison / re-confirmation
  /\b(compare|vs|versus|difference|same|again|recheck|verify|確認|比べ|比較|再|もう一度|再度|同じ|再確認)\b/i,
  // Memory-specific verbs
  /\b(remember|recall|forgot|memory|stored|saved|wrote|note|覚え|記憶|思い出|忘|保存|書い|メモ)\b/i,
  // Question patterns (often implies recall need)
  /\b(what.*was|who.*was|when.*did|how.*did|why.*did|did.*said|did.*do|何だっ|誰だっ|いつだっ|どうだっ|なぜだっ|覚えて|覚えてる)\b/i,
];

function intentCheck(text: string): boolean {
  for (const pattern of INTENT_SIGNAL_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  // Fallback: if the text has substantive content (>10 non-whitespace chars and not a novelty skip),
  // treat it as having potential memory-reference intent.
  // This is intentionally permissive — the fingerprint and negative cache gates handle the rest.
  const nonWhitespace = text.replace(/\s/g, "");
  return nonWhitespace.length > 10;
}

// ─── Fingerprint gate ────────────────────────────────────────────────────────

type FingerprintRecord = {
  fingerprint: string;
  lastSeenTurn: number;
};

// ─── Per-agent gate state ────────────────────────────────────────────────────
// Isolated fingerprint cache, negative cache, and turn counter per agent.

type AgentGateState = {
  recentFingerprints: FingerprintRecord[];
  negativeCache: Map<string, NegativeCacheEntry>;
  turnCounter: number;
  lastFingerprint: string | null;
  lastQuery: string | null;
};

function createAgentState(): AgentGateState {
  return {
    recentFingerprints: [],
    negativeCache: new Map(),
    turnCounter: 0,
    lastFingerprint: null,
    lastQuery: null,
  };
}

// ─── Main gate class ─────────────────────────────────────────────────────────

export class ToolFirstRecallGate {
  /** Per-agent isolated state */
  private agentStates: Map<string, AgentGateState> = new Map();

  constructor(
    private config: ToolFirstRecallConfig,
    /** Max recent fingerprints to keep per agent (sliding window) */
    private recentWindow = 20,
  ) {}

  /**
   * Get or create gate state for a specific agent.
   */
  private getAgentState(agentId: string): AgentGateState {
    let state = this.agentStates.get(agentId);
    if (!state) {
      state = createAgentState();
      this.agentStates.set(agentId, state);
    }
    return state;
  }

  /**
   * Advance the turn counter for a specific agent.
   */
  advanceTurn(agentId: string = "__default__"): void {
    const state = this.getAgentState(agentId);
    state.turnCounter++;
  }

  /**
   * Record a no-hit result for the given query fingerprint and agent.
   * Triggers exponential backoff.
   */
  recordNoHit(agentId: string, fingerprint: string): void {
    const state = this.getAgentState(agentId);
    const existing = state.negativeCache.get(fingerprint);
    const entry: NegativeCacheEntry = existing
      ? { ...existing, noHitCount: existing.noHitCount + 1, lastSeenTurn: state.turnCounter }
      : { fingerprint, noHitCount: 1, backoffUntilTurn: 0, lastSeenTurn: state.turnCounter };

    // Calculate backoff: cycle through [3, 6, 12] based on noHitCount
    const backoffIndex = Math.min(entry.noHitCount - 1, this.config.backoffTurns.length - 1);
    const backoffTurns = this.config.backoffTurns[Math.max(0, backoffIndex)];
    entry.backoffUntilTurn = state.turnCounter + backoffTurns;

    state.negativeCache.set(fingerprint, entry);

    // LRU eviction
    if (state.negativeCache.size > this.config.negativeCacheMaxSize) {
      const firstKey = state.negativeCache.keys().next().value;
      if (firstKey) state.negativeCache.delete(firstKey);
    }
  }

  /**
   * Record a hit result — clear the negative cache entry for this fingerprint and agent.
   */
  recordHit(agentId: string, fingerprint: string): void {
    const state = this.getAgentState(agentId);
    state.negativeCache.delete(fingerprint);
  }

  /**
   * Run the full gate pipeline with messages. Returns pass/fail with reason.
   * Uses buildQuery to construct the query from messages (reuse existing parse/rewrite logic).
   *
   * @param agentId - agent identifier for state isolation
   * @param messages - current conversation messages
   * @param buildQuery - function to build the recall query from messages
   * @returns gate result
   */
  evaluate(agentId: string, messages: Message[], buildQuery: (msgs: Message[]) => string): ToolFirstGateResult {
    const t0 = performance.now();

    // Check if enabled
    if (!this.config.enabled) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=disabled agentId=${agentId} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "disabled" };
    }

    this.advanceTurn(agentId);
    const state = this.getAgentState(agentId);

    // Build query using the provided function (reuse existing parse/rewrite logic)
    const query = buildQuery(messages);

    if (!query || !query.trim()) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=empty_query agentId=${agentId} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "empty_query" };
    }

    // Get the latest user message for novelty/intent checks
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    const lastUserText = lastUserMsg
      ? stripReasoningTagsFromText(extractText(lastUserMsg.content), { mode: "strict", trim: "both" })
      : "";

    // Gate 1: Novelty
    if (!noveltyCheck(lastUserText)) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=novelty_fail agentId=${agentId} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "novelty_fail" };
    }

    // Gate 2: Intent
    if (!intentCheck(lastUserText)) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=intent_fail agentId=${agentId} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "intent_fail" };
    }

    // Gate 3: Fingerprint dedup
    const fingerprint = createHash("sha1")
      .update(query.slice(0, this.config.maxFingerprintChars))
      .digest("hex");
    const queryHash = fingerprint;

    // Check negative cache first
    const negEntry = state.negativeCache.get(fingerprint);
    if (negEntry && negEntry.backoffUntilTurn > state.turnCounter) {
      const remaining = negEntry.backoffUntilTurn - state.turnCounter;
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=negative_cache_backoff agentId=${agentId} fp=${fingerprint.substring(0, 8)} remaining=${remaining} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "negative_cache_backoff" };
    }

    // Check recent fingerprint dedup
    const recentDup = state.recentFingerprints.find(f => f.fingerprint === fingerprint);
    if (recentDup && (state.turnCounter - recentDup.lastSeenTurn) <= 2) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=fingerprint_dup agentId=${agentId} fp=${fingerprint.substring(0, 8)} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "fingerprint_dup" };
    }

    // Update recent fingerprints
    state.recentFingerprints.push({ fingerprint, lastSeenTurn: state.turnCounter });
    if (state.recentFingerprints.length > this.recentWindow) {
      state.recentFingerprints.shift();
    }

    state.lastFingerprint = fingerprint;
    state.lastQuery = query;

    const ms = performance.now() - t0;
    console.log(`[Episodic Memory] tool_first_gate pass agentId=${agentId} fp=${fingerprint.substring(0, 8)} query="${query.substring(0, 60)}${query.length > 60 ? "..." : ""}" filter_eval_ms=${ms.toFixed(2)}`);
    return { pass: true, query, queryHash };
  }

  /**
   * Run the full gate pipeline using a pre-built query string.
   * Used in the ep-recall execute path where the query is already determined.
   * Filter order: novelty -> intent -> fingerprint -> negative cache.
   * All checks are memory-only, no network I/O.
   *
   * @param agentId - agent identifier for state isolation
   * @param query - pre-built query string
   * @returns gate result (pass with queryHash, or skip reason)
   */
  evaluateForQuery(agentId: string, query: string): ToolFirstGateResult {
    const t0 = performance.now();

    if (!this.config.enabled) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=disabled agentId=${agentId} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "disabled" };
    }

    if (!query || !query.trim()) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=empty_query agentId=${agentId} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "empty_query" };
    }

    this.advanceTurn(agentId);
    const state = this.getAgentState(agentId);

    // Gate 1: Novelty (use query text since no message context in execute path)
    if (!noveltyCheck(query)) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=novelty_fail agentId=${agentId} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "novelty_fail" };
    }

    // Gate 2: Intent (use query text since no message context in execute path)
    if (!intentCheck(query)) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=intent_fail agentId=${agentId} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "intent_fail" };
    }

    const fingerprint = createHash("sha1")
      .update(query.slice(0, this.config.maxFingerprintChars))
      .digest("hex");
    const queryHash = fingerprint;

    // Check negative cache
    const negEntry = state.negativeCache.get(fingerprint);
    if (negEntry && negEntry.backoffUntilTurn > state.turnCounter) {
      const remaining = negEntry.backoffUntilTurn - state.turnCounter;
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=negative_cache_backoff agentId=${agentId} fp=${fingerprint.substring(0, 8)} remaining=${remaining} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "negative_cache_backoff" };
    }

    // Check fingerprint dedup
    const recentDup = state.recentFingerprints.find(f => f.fingerprint === fingerprint);
    if (recentDup && (state.turnCounter - recentDup.lastSeenTurn) <= 2) {
      const ms = performance.now() - t0;
      console.log(`[Episodic Memory] tool_first_gate skip_reason=fingerprint_dup agentId=${agentId} fp=${fingerprint.substring(0, 8)} filter_eval_ms=${ms.toFixed(2)}`);
      return { pass: false, skipReason: "fingerprint_dup" };
    }

    // Update recent fingerprints
    state.recentFingerprints.push({ fingerprint, lastSeenTurn: state.turnCounter });
    if (state.recentFingerprints.length > this.recentWindow) {
      state.recentFingerprints.shift();
    }

    state.lastFingerprint = fingerprint;
    state.lastQuery = query;

    const ms = performance.now() - t0;
    console.log(`[Episodic Memory] tool_first_gate pass agentId=${agentId} fp=${fingerprint.substring(0, 8)} query="${query.substring(0, 60)}${query.length > 60 ? "..." : ""}" filter_eval_ms=${ms.toFixed(2)}`);
    return { pass: true, query, queryHash };
  }

  /**
   * Get the current turn counter for a specific agent (for testing).
   */
  getTurnCounter(agentId: string = "__default__"): number {
    return this.getAgentState(agentId).turnCounter;
  }

  /**
   * Get negative cache size for a specific agent (for testing).
   */
  getNegativeCacheSize(agentId: string = "__default__"): number {
    return this.getAgentState(agentId).negativeCache.size;
  }

  /**
   * Check if a fingerprint is currently in backoff for a specific agent (for testing).
   */
  isInBackoff(agentId: string, fingerprint: string): boolean {
    const state = this.getAgentState(agentId);
    const entry = state.negativeCache.get(fingerprint);
    return !!entry && entry.backoffUntilTurn > state.turnCounter;
  }

  /**
   * Reset all state for all agents (for testing).
   */
  reset(): void {
    this.agentStates.clear();
  }

  /**
   * Reset state for a specific agent (for testing).
   */
  resetAgent(agentId: string): void {
    this.agentStates.delete(agentId);
  }
}
