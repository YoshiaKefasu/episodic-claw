/**
 * [v0.5.0 addendum] Tests for narrative-transcript pure formatter.
 * Covers: same-day, midnight crossing, UTC→Asia/Jakarta, missing/invalid, multiline, non-primary.
 */
import { formatNarrativeTranscript, formatTranscriptMessageLines } from "./src/narrative-transcript";
import type { TranscriptMessage } from "./src/narrative-transcript";

let passed = 0;
let failed = 0;

function assert(label: string, actual: any, expected: any) {
  if (actual === expected) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    console.error(`     Expected: ${JSON.stringify(expected)}`);
    console.error(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertIncludes(label: string, actual: string, substr: string) {
  if (actual.includes(substr)) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    console.error(`     Expected to include: ${JSON.stringify(substr)}`);
    console.error(`     Actual: ${JSON.stringify(actual)}`);
    failed++;
  }
}

console.log("\n=== Timestamped Narrative Transcript Tests (v0.5.0 addendum) ===");

// ─── [1] Same-day timestamps → one date header ──────────────────────────────

console.log("\n[1] Same-day timestamps — single date header");

const sameDay: TranscriptMessage[] = [
  { role: "user", text: "Hello", timestamp: "2026-07-05T19:30:00Z" },
  { role: "assistant", text: "Hi there", timestamp: "2026-07-05T19:32:00Z" },
  { role: "user", text: "Help me", timestamp: "2026-07-05T21:10:00Z" },
];
const sameDayResult = formatNarrativeTranscript(sameDay, { timeZone: "Asia/Jakarta" });
// UTC 19:30 → WIB 02:30 next day; UTC 19:32 → WIB 02:32; UTC 21:10 → WIB 04:10
assertIncludes("contains date header", sameDayResult, "(2026-07-06 Monday)");
assertIncludes("first message formatted", sameDayResult, "[02:30] user: Hello");
assertIncludes("second message formatted", sameDayResult, "[02:32] assistant: Hi there");
assertIncludes("third message formatted", sameDayResult, "[04:10] user: Help me");
// Only one date header
assert(
  "exactly one date header",
  (sameDayResult.match(/^\(\d{4}-\d{2}-\d{2}\s+\w+\)$/gm) || []).length,
  1
);

// ─── [2] Midnight crossing → two date headers ───────────────────────────────

console.log("\n[2] Midnight crossing — two date headers");

const midnightCross: TranscriptMessage[] = [
  { role: "user", text: "Late question", timestamp: "2026-07-05T17:00:00Z" },
  { role: "assistant", text: "Late answer", timestamp: "2026-07-05T17:50:00Z" },
  { role: "user", text: "Early question", timestamp: "2026-07-05T18:05:00Z" },
  { role: "assistant", text: "Early answer", timestamp: "2026-07-05T18:07:00Z" },
];
const midnightResult = formatNarrativeTranscript(midnightCross, { timeZone: "Asia/Jakarta" });
// UTC 17:00 → WIB 00:00 Jul 6; UTC 17:50 → WIB 00:50 Jul 6; UTC 18:05 → WIB 01:05 Jul 6
// Wait, let me recalculate. Asia/Jakarta is UTC+7.
// UTC 17:00 Jul 5 → WIB 00:00 Jul 6
// UTC 17:50 Jul 5 → WIB 00:50 Jul 6
// UTC 18:05 Jul 5 → WIB 01:05 Jul 6
// All are Jul 6 in WIB. Let me adjust to actually cross midnight.
const midnightCross2: TranscriptMessage[] = [
  { role: "user", text: "Late question", timestamp: "2026-07-05T16:30:00Z" },
  { role: "assistant", text: "Late answer", timestamp: "2026-07-05T17:50:00Z" },
  { role: "user", text: "Early question", timestamp: "2026-07-05T18:05:00Z" },
  { role: "assistant", text: "Early answer", timestamp: "2026-07-05T18:07:00Z" },
];
// UTC 16:30 → WIB 23:30 Jul 5; UTC 17:50 → WIB 00:50 Jul 6; UTC 18:05 → WIB 01:05 Jul 6
const midnightResult2 = formatNarrativeTranscript(midnightCross2, { timeZone: "Asia/Jakarta" });
const headers2 = (midnightResult2.match(/^\(\d{4}-\d{2}-\d{2}\s+\w+\)$/gm) || []);
assert("two date headers for midnight crossing", headers2.length, 2);
assertIncludes("first header is Jul 5", midnightResult2, "(2026-07-05 Sunday)");
assertIncludes("second header is Jul 6", midnightResult2, "(2026-07-06 Monday)");
assertIncludes("late question at 23:30", midnightResult2, "[23:30] user: Late question");
assertIncludes("early question at 01:05", midnightResult2, "[01:05] user: Early question");

// ─── [3] UTC → Asia/Jakarta conversion ──────────────────────────────────────

console.log("\n[3] UTC → Asia/Jakarta time conversion");

const utcMsg: TranscriptMessage[] = [
  { role: "user", text: "test", timestamp: "2026-07-05T12:00:00Z" },
];
const utcResult = formatNarrativeTranscript(utcMsg, { timeZone: "Asia/Jakarta" });
// UTC 12:00 + 7h = WIB 19:00
assertIncludes("UTC 12:00 becomes WIB 19:00", utcResult, "[19:00] user: test");

// ─── [4] Missing timestamp → legacy role: text ──────────────────────────────

console.log("\n[4] Missing timestamp — legacy role: text");

const missingTs: TranscriptMessage[] = [
  { role: "user", text: "no timestamp here" },
  { role: "assistant", text: "reply without time" },
];
const missingResult = formatNarrativeTranscript(missingTs, { timeZone: "Asia/Jakarta" });
assert("no date header for missing timestamps", missingResult.includes("("), false);
assertIncludes("user legacy format", missingResult, "user: no timestamp here");
assertIncludes("assistant legacy format", missingResult, "assistant: reply without time");

// ─── [5] Invalid timestamp → safe fallback ──────────────────────────────────

console.log("\n[5] Invalid timestamp — safe fallback");

const invalidTs: TranscriptMessage[] = [
  { role: "user", text: "bad time", timestamp: "not-a-date" },
];
const invalidResult = formatNarrativeTranscript(invalidTs, { timeZone: "Asia/Jakarta" });
assert("no date header for invalid timestamp", invalidResult.includes("("), false);
assertIncludes("invalid falls back to legacy", invalidResult, "user: bad time");

// ─── [6] Multi-line message → only first line prefixed ──────────────────────

console.log("\n[6] Multi-line message — only first line prefixed");

const multiLine: TranscriptMessage[] = [
  { role: "assistant", text: "Line one\nLine two\nLine three", timestamp: "2026-07-05T12:00:00Z" },
];
const multiLineResult = formatTranscriptMessageLines(multiLine[0], { timeZone: "Asia/Jakarta" });
assert("multi-line has 3 lines", multiLineResult.length, 3);
assertIncludes("first line has prefix", multiLineResult[0], "[19:00] assistant: Line one");
assert("second line has no prefix", multiLineResult[1].startsWith("["), false);
assert("third line has no prefix", multiLineResult[2].startsWith("["), false);

// ─── [7] Non-primary role retains unlabeled behavior ────────────────────────

console.log("\n[7] Non-primary role — unlabeled behavior");

const nonPrimary: TranscriptMessage[] = [
  { role: "toolResult", text: "tool output text", timestamp: "2026-07-05T12:00:00Z" },
];
const nonPrimaryResult = formatTranscriptMessageLines(nonPrimary[0], { timeZone: "Asia/Jakarta" });
assert("non-primary returns just text", nonPrimaryResult.length, 1);
assert("non-primary has no role prefix", nonPrimaryResult[0].includes("toolResult"), false);
assertIncludes("non-primary preserves text", nonPrimaryResult[0], "tool output text");

// ─── [8] Empty messages → empty string ──────────────────────────────────────

console.log("\n[8] Empty messages — empty string");

const emptyResult = formatNarrativeTranscript([], { timeZone: "Asia/Jakarta" });
assert("empty input returns empty string", emptyResult, "");

// ─── [9] Mixed: some timestamped, some not ──────────────────────────────────

console.log("\n[9] Mixed timestamped and missing timestamps");

const mixed: TranscriptMessage[] = [
  { role: "user", text: "has time", timestamp: "2026-07-05T12:00:00Z" },
  { role: "assistant", text: "no time" },
  { role: "user", text: "has time again", timestamp: "2026-07-05T13:00:00Z" },
];
const mixedResult = formatNarrativeTranscript(mixed, { timeZone: "Asia/Jakarta" });
assertIncludes("timestamped message gets time prefix", mixedResult, "[19:00] user: has time");
assertIncludes("missing timestamp gets legacy format", mixedResult, "assistant: no time");
assertIncludes("second timestamped gets time prefix", mixedResult, "[20:00] user: has time again");
assert("only one date header for same-day mixed", (mixedResult.match(/^\(/gm) || []).length, 1);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
