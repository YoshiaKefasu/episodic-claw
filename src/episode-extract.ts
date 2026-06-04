// src/episode-extract.ts — Read episode markdown body for the snapshot worker.
//
// Purpose: take the raw text from a SourcePath file and return the body
// (frontmatter excluded), capped at 6000 chars so a single episode
// summary call never blows past the LLM context window. This is purely
// a read-and-cap helper; the LLM guardrail/chain lives elsewhere.

import * as fs from "fs";

/**
 * Snapshot input cap. LLM prompts that pass the guardrail chain must
 * stay under ~8K tokens; 6000 chars leaves headroom for prompt framing,
 * guardrail rejections, and a single ReAsk suffix.
 */
export const EPISODE_SNAPSHOT_TEXT_CAP = 6000;

/**
 * Strip a leading YAML frontmatter block delimited by "---" lines.
 * Returns the body text after the closing "---". If the file is empty
 * or has no frontmatter, the whole content (or empty string) is
 * returned. Conservative: when in doubt, return the original content.
 */
export function stripFrontmatter(raw: string): string {
  if (!raw) return "";
  // frontmatter must start with "---" on the very first line
  if (!raw.startsWith("---")) return raw;

  // Find the closing "---" line. Allow trailing whitespace and \r.
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2 || lines[0].trim() !== "---") return raw;

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n");
    }
  }
  // No closing delimiter — treat the whole content as body
  return raw;
}

/**
 * Read a SourcePath file and return the body, frontmatter excluded,
 * capped at EPISODE_SNAPSHOT_TEXT_CAP characters. Returns an empty
 * string when the file is missing or unreadable (worker treats this
 * as a soft no-op and proceeds to the per-item delete step).
 */
export function readEpisodeBody(sourcePath: string, cap: number = EPISODE_SNAPSHOT_TEXT_CAP): string {
  let raw: string;
  try {
    raw = fs.readFileSync(sourcePath, "utf8");
  } catch {
    return "";
  }
  const body = stripFrontmatter(raw).trim();
  if (!body) return "";
  if (body.length <= cap) return body;
  return body.slice(0, cap);
}
