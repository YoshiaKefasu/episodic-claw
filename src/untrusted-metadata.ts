/**
 * Shared helper for stripping Telegram gateway untrusted metadata blocks.
 *
 * The Telegram gateway injects the following patterns into message content:
 *   - "Conversation info (untrusted metadata): ..." followed by a ```json ... ``` block
 *   - "Sender (untrusted metadata): ..." followed by a ```json ... ``` block
 *   - "Replied message (untrusted, for context): ..." followed by a ```json ... ``` block
 *
 * These patterns appear in three independent processing paths:
 *   1. normalizeMessageText()   — large-payload.ts (message ingestion)
 *   2. classifyAndStripAttachment() — retriever.ts (attachment classification)
 *   3. normalizePromptAnchor()  — index.ts (anchor extraction for recall queries)
 *   4. instantDeterministicRewrite() — retriever.ts Phase 1 (query keyword extraction)
 *
 * This module is the single source of truth for metadata strip patterns (DRY).
 * Paths 1-2 import and call stripUntrustedMetadataBlocks().
 * Path 4 uses a lightweight inline .replace() to avoid breaking the map chain.
 */

// Phase 1: Full block removal — header line + fenced json block (multi-line, greedy-safe)
const UNTRUSTED_META_BLOCK_PATTERNS: RegExp[] = [
  /Conversation info \(untrusted metadata\):[\s\S]*?```json[\s\S]*?```/gi,
  /Sender \(untrusted metadata\):[\s\S]*?```json[\s\S]*?```/gi,
  /Replied message \(untrusted,? for context\):[\s\S]*?```json[\s\S]*?```/gi,
  // Fallback: any remaining (untrusted metadata) + json block
  /\(untrusted metadata\):[\s\S]*?```json[\s\S]*?```/gi,
];

// Phase 2: Standalone header lines (when fenced json is already removed or absent)
// Matches: "Conversation info (untrusted ...): any text" as full lines
const UNTRUSTED_META_HEADER_PATTERN =
  /^(Conversation info|Sender|Replied message)\s+\(untrusted[^)]*\):.*$/gim;

/**
 * Strip all untrusted metadata blocks from the given text.
 *
 * Handles:
 *  - Full blocks: header + fenced json (e.g. from Telegram gateway)
 *  - Standalone header lines: remnants after partial removal
 *  - Orphaned fenced json blocks: left behind if header was already stripped
 *
 * Safe to call multiple times (idempotent).
 */
export function stripUntrustedMetadataBlocks(text: string): string {
  let cleaned = text;

  // Phase 1: Remove full header + fenced json blocks
  for (const pattern of UNTRUSTED_META_BLOCK_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }

  // Phase 2: Remove any remaining standalone header lines
  cleaned = cleaned.replace(UNTRUSTED_META_HEADER_PATTERN, "");

  // Phase 3: Remove orphaned fenced json blocks left behind
  cleaned = cleaned.replace(/```json[\s\S]*?```/gi, "");

  // Normalize whitespace left by removals
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return cleaned;
}
