/**
 * Pure reusable transcript formatter for narrative LLM input.
 *
 * Converts normalized {role, text, timestamp?} messages into a human-readable
 * transcript with device-local date headers and [HH:mm] role prefixes.
 *
 * No imports from callers — this module is a leaf dependency:
 *
 *   narrative-pool ─┐
 *   narrative-queue ├─> narrative-transcript (pure)
 *   rpc-client      ┘
 *
 * Tests inject `Asia/Jakarta` via the timeZone option for deterministic assertions.
 */

export type TranscriptMessage = {
  role: string;
  text: string;
  timestamp?: string;
};

/**
 * Primary roles that receive timestamped [HH:mm] prefix formatting.
 * Non-primary roles (e.g., toolResult) retain unlabeled behavior.
 */
const PRIMARY_ROLES = new Set(["user", "assistant"]);

/**
 * Format a single message into its exact timestamped role lines.
 *
 * Returns an array of lines (first line = `[HH:mm] role: text` or legacy `role: text`),
 * but does NOT emit date headers. Callers use this for line-to-role mapping.
 *
 * For multi-line content, only the first line receives the prefix.
 */
export function formatTranscriptMessageLines(
  message: TranscriptMessage,
  opts?: { timeZone?: string },
): string[] {
  const { role, text, timestamp } = message;
  const isPrimary = PRIMARY_ROLES.has(role);

  // Missing/invalid timestamp or non-primary role → preserve legacy behavior
  if (!timestamp || !isPrimary) {
    if (isPrimary) {
      // Missing timestamp but primary role → legacy `role: text` (no time prefix)
      return [role + ": " + text];
    }
    // Non-primary role → just text (no role prefix at all)
    return text.split("\n");
  }

  // Parse and validate the ISO timestamp
  const date = safeParseTimestamp(timestamp);
  if (!date) {
    // Invalid timestamp → legacy `role: text`
    return [role + ": " + text];
  }

  // Format in the specified or runtime-resolved time zone
  const localTime = formatLocalTime(date, opts?.timeZone);
  const prefix = `[${localTime}] ${role}`;

  // Multi-line: only first line gets the prefix
  const lines = text.split("\n");
  if (lines.length === 1) {
    return [prefix + ": " + text];
  }

  return [prefix + ": " + lines[0], ...lines.slice(1)];
}

/**
 * Format a full ordered list of messages into a narrative transcript with date headers.
 *
 * Emits `(YYYY-MM-DD Weekday)` headers when the local calendar date changes.
 * Timestamped primary messages get `[HH:mm] role: text`.
 * Missing/invalid timestamps produce legacy `role: text`.
 */
export function formatNarrativeTranscript(
  messages: TranscriptMessage[],
  opts?: { timeZone?: string },
): string {
  if (messages.length === 0) return "";

  const allLines: string[] = [];
  let lastDateKey: string | null = null;

  for (const msg of messages) {
    const lines = formatTranscriptMessageLines(msg, opts);
    if (lines.length === 0) continue;

    // Determine if we need a date header for this message
    if (msg.timestamp && PRIMARY_ROLES.has(msg.role)) {
      const date = safeParseTimestamp(msg.timestamp);
      if (date) {
        const dateKey = formatLocalDateKey(date, opts?.timeZone);
        if (dateKey !== lastDateKey) {
          const header = `(${formatLocalDateHeader(date, opts?.timeZone)})`;
          allLines.push(header);
          lastDateKey = dateKey;
        }
      }
    }

    allLines.push(...lines);
  }

  return allLines.join("\n");
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Safely parse an ISO timestamp string. Returns null for invalid input.
 */
function safeParseTimestamp(ts: string): Date | null {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * Format a Date as HH:mm in the given time zone.
 */
function formatLocalTime(date: Date, timeZone?: string): string {
  return date.toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timeZone || undefined,
  });
}

/**
 * Format a Date as YYYY-MM-DD in the given time zone (used as date-change key).
 * Uses Intl.DateTimeFormat.formatToParts for guaranteed YYYY-MM-DD output
 * regardless of Node/ICU locale conventions.
 */
function formatLocalDateKey(date: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timeZone || undefined,
  }).formatToParts(date);
  const y = parts.find(p => p.type === "year")?.value ?? "1970";
  const m = parts.find(p => p.type === "month")?.value ?? "01";
  const d = parts.find(p => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/**
 * Format a Date as "YYYY-MM-DD Weekday" for the date header.
 */
function formatLocalDateHeader(date: Date, timeZone?: string): string {
  const dateKey = formatLocalDateKey(date, timeZone);
  const weekday = date.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: timeZone || undefined,
  });
  return `${dateKey} ${weekday}`;
}
