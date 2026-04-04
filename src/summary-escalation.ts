import { normalizeMessageText } from "./large-payload";

export type SummarizationLevel = "normal" | "aggressive" | "fallback";

export type SummaryMessageLike = {
  role: string;
  content: any;
};

const AGGRESSIVE_MESSAGE_LIMIT = 6;
const AGGRESSIVE_LINE_LIMIT = 4;
const AGGRESSIVE_MESSAGE_CHARS = 240;
const FALLBACK_MAX_CHARS = 512 * 4;

function normalizeTextLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

function buildNormalSummary(messages: SummaryMessageLike[]): string {
  return messages
    .map((message) => {
      const text = normalizeMessageText(message.content).trim();
      return text ? `${message.role}: ${text}` : "";
    })
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();
}

export function buildAggressiveSummary(messages: SummaryMessageLike[]): string {
  const lines: string[] = [];

  for (const message of messages) {
    const text = normalizeMessageText(message.content).trim();
    if (!text) continue;

    const filtered = normalizeTextLines(text).filter((line) => {
      if (/^\s*(thinking|reasoning)\b/i.test(line)) return false;
      if (/^\s*\[(DEBUG|TRACE|VERBOSE)\]/i.test(line)) return false;
      return true;
    });

    if (filtered.length === 0) continue;

    const clipped = filtered
      .slice(0, AGGRESSIVE_LINE_LIMIT)
      .join(" ");
    const display = Array.from(clipped).slice(0, AGGRESSIVE_MESSAGE_CHARS).join("");
    if (display.length === 0) continue;

    lines.push(`${message.role}: ${display}`);
    if (lines.length >= AGGRESSIVE_MESSAGE_LIMIT) break;
  }

  if (lines.length > 0) {
    return lines.join("\n").trim();
  }

  return buildFallbackSummary(messages);
}

export function buildFallbackSummary(messages: SummaryMessageLike[]): string {
  const raw = messages
    .map((message) => {
      const text = normalizeMessageText(message.content).trim();
      return text ? `${message.role}: ${text}` : "";
    })
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!raw) {
    return "[Empty segment]";
  }

  const clipped = Array.from(raw).slice(0, FALLBACK_MAX_CHARS).join("");
  if (clipped.length === raw.length) {
    return clipped;
  }

  return `${clipped}\n[episodic-claw fallback: truncated from ~${Math.ceil(raw.length / 4)} tokens]`;
}

export function buildSummaryForLevel(
  messages: SummaryMessageLike[],
  level: SummarizationLevel = "normal"
): string {
  switch (level) {
    case "aggressive":
      return buildAggressiveSummary(messages);
    case "fallback":
      return buildFallbackSummary(messages);
    case "normal":
    default:
      return buildNormalSummary(messages);
  }
}
