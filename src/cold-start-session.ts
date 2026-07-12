/**
 * [v0.5.0 addendum] Pure leaf module for parsing cold-start JSONL session files.
 *
 * Extracted from rpc-client.ts to avoid ESM/CJS `createRequire(__filename)`
 * incompatibility when importing from test files via tsx.
 *
 * Only imports `fs` — no RPC, no module-scope side effects.
 */
import * as fs from "fs";

/**
 * parseJsonlToMessages reads a .jsonl session file and extracts user/assistant messages.
 * Handles both string and array-of-objects content formats.
 * Preserves top-level entry.timestamp for timestamped transcript.
 */
export function parseJsonlToMessages(sessionFile: string): Array<{ role: string; content: string; timestamp?: string }> {
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
  const messages: Array<{ role: string; content: string; timestamp?: string }> = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message" || entry.message?.role === "system") continue;

      const role = entry.message.role;
      const rawContent = entry.message.content;
      let text = "";

      if (typeof rawContent === "string") {
        text = rawContent;
      } else if (Array.isArray(rawContent)) {
        text = rawContent
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      }

      if (text.trim()) {
        messages.push({ role, content: text, timestamp: entry.timestamp });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}
