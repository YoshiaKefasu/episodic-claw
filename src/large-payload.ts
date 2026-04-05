/**
 * Large payload externalization helpers.
 *
 * The goal is to keep raw transcript density high by replacing unusually large
 * text blobs with compact, deterministic summaries before they propagate into
 * segmentation, recall queries, or compaction summaries.
 */

const LARGE_PAYLOAD_CHAR_THRESHOLD = 12_000;
const LARGE_PAYLOAD_LINE_THRESHOLD = 300;
const LARGE_PAYLOAD_PREVIEW_LINE_LIMIT = 20;
const LARGE_PAYLOAD_HEAD_LINE_LIMIT = 10;
const LARGE_PAYLOAD_TAIL_LINE_LIMIT = 5;
const LARGE_PAYLOAD_IMPORT_LIMIT = 8;
const LARGE_PAYLOAD_SIGNATURE_LIMIT = 16;

function extractPlainText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && typeof block.text === "string") return block.text;
        if (block && typeof block === "object" && "content" in block) {
          return extractPlainText((block as { content?: unknown }).content);
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (content && typeof content === "object") {
    const record = content as { text?: unknown; content?: unknown };
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return extractPlainText(record.content);
  }
  return String(content ?? "");
}

function looksLikeDirectoryListing(text: string): boolean {
  const lines = text.split(/\r?\n/).slice(0, LARGE_PAYLOAD_PREVIEW_LINE_LIMIT);
  if (lines.length === 0) return false;
  let pathLikeCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[.\/\\]/.test(trimmed) || /^\s*[├└│─]/.test(line) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      pathLikeCount += 1;
    }
  }
  return pathLikeCount > Math.max(1, Math.floor(lines.length * 0.5));
}

function looksLikeCodeOutput(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let signatureCount = 0;
  let importCount = 0;
  for (const line of lines.slice(0, 200)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(export\s+)?(async\s+)?(function|class|interface|type|const\s+\w+\s*=|def\s+\w+\(|struct\s+\w+)/.test(trimmed)) {
      signatureCount += 1;
    }
    if (/^\s*(import\s+|from\s+\S+\s+import\s+|const\s+\w+\s*=\s*require\()/.test(line)) {
      importCount += 1;
    }
  }
  return signatureCount > 0 || importCount > 0;
}

/**
 * Detect whether a text payload is large enough to externalize.
 */
export function isLargePayload(text: string): boolean {
  if (text.length >= LARGE_PAYLOAD_CHAR_THRESHOLD) return true;
  return text.split(/\r?\n/).length >= LARGE_PAYLOAD_LINE_THRESHOLD;
}

/**
 * Summarize large payloads deterministically so they stay searchable but do not
 * dominate downstream token budgets.
 */
export function summarizeLargePayload(text: string): string {
  const lines = text.split(/\r?\n/);
  const charCount = text.length;
  const lineCount = lines.length;

  if (looksLikeDirectoryListing(text)) {
    const preview = lines.slice(0, LARGE_PAYLOAD_PREVIEW_LINE_LIMIT).join("\n");
    return [
      `[Large directory listing: ${lineCount} lines, ${charCount.toLocaleString()} chars]`,
      preview,
      `[...${Math.max(0, lineCount - LARGE_PAYLOAD_PREVIEW_LINE_LIMIT)} more lines omitted for episodic density]`,
    ].join("\n");
  }

  if (looksLikeCodeOutput(text)) {
    const imports = lines
      .filter((line) => /^\s*(import\s+|from\s+\S+\s+import\s+|const\s+\w+\s*=\s*require\()/.test(line))
      .slice(0, LARGE_PAYLOAD_IMPORT_LIMIT)
      .map((line) => line.trim());
    const signatures = lines
      .map((line) => line.trim())
      .filter((line) =>
        /^(export\s+)?(async\s+)?(function|class|interface|type|const\s+\w+\s*=|def\s+\w+\(|struct\s+\w+)/.test(line)
      )
      .slice(0, LARGE_PAYLOAD_SIGNATURE_LIMIT);

    const parts = [`[Large code output: ${lineCount} lines, ${charCount.toLocaleString()} chars]`];
    if (imports.length > 0) {
      parts.push(`Imports: ${imports.join(" | ")}`);
    }
    if (signatures.length > 0) {
      parts.push(`Definitions: ${signatures.join(" | ")}`);
    }
    return parts.join("\n");
  }

  const head = lines.slice(0, LARGE_PAYLOAD_HEAD_LINE_LIMIT).join("\n");
  const tail = lines.slice(-LARGE_PAYLOAD_TAIL_LINE_LIMIT).join("\n");
  return [
    `[Large text output: ${lineCount} lines, ${charCount.toLocaleString()} chars]`,
    head,
    `[...${Math.max(0, lineCount - LARGE_PAYLOAD_HEAD_LINE_LIMIT - LARGE_PAYLOAD_TAIL_LINE_LIMIT)} lines omitted]`,
    tail,
  ].join("\n");
}

function stripToolOutputPatterns(text: string): string {
  if (text.startsWith("toolResult:") || text.startsWith("tool_result:")) {
    return "";
  }
  return text;
}

/**
 * Normalize arbitrary message content to text and externalize if it is large.
 */
export function normalizeMessageText(content: any): string {
  const plain = stripToolOutputPatterns(extractPlainText(content).trim());
  if (!plain) return "";
  return isLargePayload(plain) ? summarizeLargePayload(plain) : plain;
}
