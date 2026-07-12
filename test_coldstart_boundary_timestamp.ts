/**
 * [v0.5.0 addendum] Focused tests for cold-start timestamp preservation,
 * forceBoundary chain, and near-64K suffix date header carry-forward.
 *
 * Test coverage:
 * 1. parseJsonlToMessages preserves top-level entry.timestamp
 * 2. forceBoundary → pool → queue chain preserves timestamp formatting
 * 3. near-64K prefix flush retains suffix date header for subsequent queue
 * 4. Boundary metadata isolation — timestamp formatting independent of boundaryNote
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NarrativePool } from "./src/narrative-pool";
import { formatNarrativeTranscript, formatTranscriptMessageLines } from "./src/narrative-transcript";
import { splitIntoChunks, detectRoleLine } from "./src/narrative-queue";
// [v0.5.0 addendum] Import production parser — no inline copy
import { parseJsonlToMessages } from "./src/cold-start-session";

let passed = 0;
let failed = 0;

function test(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

console.log("\n=== Cold-Start & ForceBoundary Timestamp Tests (v0.5.0 addendum) ===");

// ─── [1] parseJsonlToMessages preserves top-level timestamp ──────────────────

console.log("\n[1] parseJsonlToMessages — timestamp preservation");

test("parseJsonlToMessages extracts role, content, and timestamp", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-test-coldstart-"));
  const sessionFile = path.join(tmpDir, "test-session.jsonl");

  const lines = [
    JSON.stringify({
      type: "message",
      timestamp: "2026-07-05T12:00:00Z",
      message: { role: "user", content: "Hello world" },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-07-05T12:02:00Z",
      message: { role: "assistant", content: "Hi there!" },
    }),
    // System message should be skipped
    JSON.stringify({
      type: "message",
      timestamp: "2026-07-05T12:01:00Z",
      message: { role: "system", content: "System prompt" },
    }),
    // Entry without timestamp
    JSON.stringify({
      type: "message",
      message: { role: "user", content: "No timestamp here" },
    }),
  ].join("\n");

  fs.writeFileSync(sessionFile, lines, "utf8");

  const messages = parseJsonlToMessages(sessionFile);

  assert.equal(messages.length, 3, "skips system messages");
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "Hello world");
  assert.equal(messages[0].timestamp, "2026-07-05T12:00:00Z");
  assert.equal(messages[1].timestamp, "2026-07-05T12:02:00Z");
  assert.equal(messages[2].timestamp, undefined, "no-timestamp entry has undefined timestamp");

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("parseJsonlToMessages formatted rawText includes timestamps", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ep-test-coldstart2-"));
  const sessionFile = path.join(tmpDir, "test-session.jsonl");

  const lines = [
    JSON.stringify({
      type: "message",
      timestamp: "2026-07-05T12:00:00Z",
      message: { role: "user", content: "Question" },
    }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-07-05T12:02:00Z",
      message: { role: "assistant", content: "Answer" },
    }),
  ].join("\n");

  fs.writeFileSync(sessionFile, lines, "utf8");

  const messages = parseJsonlToMessages(sessionFile);
  const rawText = formatNarrativeTranscript(
    messages.map(m => ({ role: m.role, text: m.content, timestamp: m.timestamp })),
    { timeZone: "Asia/Jakarta" },
  );

  assert.ok(rawText.includes("[19:00] user: Question"), "first message has WIB time");
  assert.ok(rawText.includes("[19:02] assistant: Answer"), "second message has WIB time");
  assert.ok(rawText.includes("(2026-07-05 Sunday)"), "date header present");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── [2] forceBoundary → pool → queue chain preserves timestamp formatting ──

console.log("\n[2] forceBoundary chain — timestamp formatting preserved");

test("pool.add + forceFlush with timestamped messages preserves formatted rawText", () => {
  const pool = new NarrativePool();

  pool.add([
    { role: "user", content: "Timestamped question", timestamp: "2026-07-05T12:00:00Z" },
    { role: "assistant", content: "Timestamped answer", timestamp: "2026-07-05T12:02:00Z" },
  ], 0, "/ws", "main");

  const item = pool.forceFlush("/ws", "main");

  assert.ok(item !== null, "flush item returned");
  // Pool uses device-local timezone — verify formatter was invoked with timestamp data
  // by checking the rawText contains role-labeled timestamped lines (not legacy format)
  assert.ok(item!.rawText.includes("user: Timestamped question"), "rawText has user line");
  assert.ok(item!.rawText.includes("assistant: Timestamped answer"), "rawText has assistant line");
  assert.ok(item!.rawText.includes("("), "rawText has date header (device-local tz)");
});

test("pool.add + forceFlush with mixed timestamped and missing timestamps", () => {
  const pool = new NarrativePool();

  pool.add([
    { role: "user", content: "Has timestamp", timestamp: "2026-07-05T12:00:00Z" },
    { role: "assistant", content: "No timestamp reply" },
  ], 0, "/ws", "main");

  const item = pool.forceFlush("/ws", "main");

  assert.ok(item !== null, "flush item returned");
  assert.ok(item!.rawText.includes("[19:00] user: Has timestamp"), "timestamped message formatted");
  assert.ok(item!.rawText.includes("assistant: No timestamp reply"), "missing timestamp falls back to legacy");
});

test("pool boundary metadata isolation — timestamp formatting independent of boundaryNote", () => {
  const pool = new NarrativePool();

  pool.add([
    { role: "user", content: "With boundary", timestamp: "2026-07-05T12:00:00Z" },
  ], 0, "/ws", "main", {
    boundaryNote: "Test boundary note",
    boundaryBy: "test-agent",
    boundaryReason: "manual",
    boundaryTitleHint: "Test Title",
    boundaryCreatedAt: "2026-07-05T12:00:00Z",
  });

  const item = pool.forceFlush("/ws", "main");

  assert.ok(item !== null, "flush item returned");
  assert.ok(item!.rawText.includes("[19:00] user: With boundary"), "timestamp formatting works");
  assert.ok(item!.boundaryMeta?.boundaryNote === "Test boundary note", "boundary metadata preserved separately");
});

// ─── [3] near-64K prefix flush — suffix date header carry-forward ────────────

console.log("\n[3] Multi-chunk date header carry-forward — deterministic fixture");

test("multi-chunk timestamped transcript carries date header to later chunks (deterministic)", () => {
  // Design: produce enough tokens to exceed SOFT_TOKEN_TARGET (48K).
  // 800 messages × ~500 chars × ~0.25 tokens/char = ~100K tokens → well over 48K.
  //
  // Day 1 (WIB): UTC 10:00-15:59 Jul 5 → WIB 17:00-22:59 Jul 5 → date key "2026-07-05 Sunday"
  // Day 2 (WIB): UTC 17:00-22:59 Jul 5 → WIB 00:00-05:59 Jul 6 → date key "2026-07-06 Monday"
  const messages: Array<{ role: string; text: string; timestamp?: string }> = [];

  const PADDING = "Padding text to ensure each message contributes enough tokens. ".repeat(8);

  for (let i = 0; i < 400; i++) {
    const h = 10 + Math.floor(i / 67); // 10..15
    messages.push({
      role: "user",
      text: `Day 1 user msg ${i}. ${PADDING}`,
      timestamp: `2026-07-05T${String(h).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
    });
    messages.push({
      role: "assistant",
      text: `Day 1 assistant msg ${i}. ${PADDING}`,
      timestamp: `2026-07-05T${String(h).padStart(2, "0")}:${String((i + 1) % 60).padStart(2, "0")}:00Z`,
    });
  }
  for (let i = 0; i < 400; i++) {
    const h = 17 + Math.floor(i / 67); // 17..22
    messages.push({
      role: "user",
      text: `Day 2 user msg ${i}. ${PADDING}`,
      timestamp: `2026-07-05T${String(h).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
    });
    messages.push({
      role: "assistant",
      text: `Day 2 assistant msg ${i}. ${PADDING}`,
      timestamp: `2026-07-05T${String(h).padStart(2, "0")}:${String((i + 1) % 60).padStart(2, "0")}:00Z`,
    });
  }

  const rawText = formatNarrativeTranscript(messages, { timeZone: "Asia/Jakarta" });
  const msgObjects = messages.map(m => ({
    role: m.role,
    content: m.text,
    timestamp: m.timestamp,
  }));

  const chunks = splitIntoChunks(rawText, "/ws", "main", "live-turn", "size-limit", 0, msgObjects);

  // Deterministic: fixture MUST produce >= 2 chunks
  assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);

  const EXPECTED_DAY1_HEADER = "(2026-07-05 Sunday)";
  const EXPECTED_DAY2_HEADER = "(2026-07-06 Monday)";

  // Unconditional: EVERY chunk that contains timestamped content MUST begin with
  // the applicable effective (YYYY-MM-DD Weekday) header as its first line.
  let hasDay1Content = false;
  let hasDay2Content = false;
  let hasHeaderOnlyChunk = false;

  for (let ci = 0; ci < chunks.length; ci++) {
    const raw = chunks[ci].rawText;
    const lines = raw.split("\n");
    const firstLine = lines[0];
    const hasTimestampedLine = lines.some(l => /^\[\d{2}:\d{2}\]\s(user|assistant):/.test(l));

    if (hasTimestampedLine) {
      // Determine which day's content this chunk has
      const hasDay1 = raw.includes("Day 1 ");
      const hasDay2 = raw.includes("Day 2 ");
      if (hasDay1) hasDay1Content = true;
      if (hasDay2) hasDay2Content = true;

      const expectedHeader = hasDay1 && hasDay2
        ? (raw.indexOf("Day 1 ") < raw.indexOf("Day 2 ") ? EXPECTED_DAY1_HEADER : EXPECTED_DAY2_HEADER)
        : hasDay2 ? EXPECTED_DAY2_HEADER
        : hasDay1 ? EXPECTED_DAY1_HEADER
        : null;

      if (expectedHeader) {
        assert.ok(
          firstLine === expectedHeader,
          `chunk ${ci}: expected header ${expectedHeader} as first line, got ${JSON.stringify(firstLine)}`
        );
      }
    } else {
      // No timestamped content — must NOT be a standalone header-only chunk
      if (/^\(\d{4}-\d{2}-\d{2}\s+\w+\)$/.test(firstLine) && lines.length === 1) {
        hasHeaderOnlyChunk = true;
      }
    }
  }

  assert.ok(hasDay1Content, "at least one chunk contains Day 1 content");
  assert.ok(hasDay2Content, "at least one chunk contains Day 2 content");
  assert.ok(!hasHeaderOnlyChunk, "no standalone header-only chunks");
});

// ─── [4] forceBoundary chain — boundary metadata isolation ──────────────────

console.log("\n[4] forceBoundary chain — boundary metadata isolation");

test("splitIntoChunks preserves boundary metadata alongside timestamped rawText", () => {
  const pool = new NarrativePool();

  pool.add([
    { role: "user", content: "Before boundary", timestamp: "2026-07-05T12:00:00Z" },
    { role: "assistant", content: "After boundary", timestamp: "2026-07-05T12:02:00Z" },
  ], 0, "/ws", "main", {
    boundaryNote: "Episode break",
    boundaryBy: "test-agent",
    boundaryReason: "manual",
    boundaryTitleHint: "Test Episode",
    boundaryCreatedAt: "2026-07-05T12:00:00Z",
  });

  const item = pool.forceFlush("/ws", "main");
  assert.ok(item !== null, "flush item returned");

  const chunks = splitIntoChunks(
    item!.rawText, "/ws", "main", "live-turn", "force-flush", 0,
    item!.messages, item!.boundaryMeta,
  );

  assert.ok(chunks.length >= 1, "at least one chunk");
  assert.ok(chunks[0].boundaryNote === "Episode break", "boundary note propagated");
  assert.ok(chunks[0].boundaryBy === "test-agent", "boundary by propagated");
  assert.ok(chunks[0].rawText.includes("user: Before boundary"), "timestamped text in chunk");
});

// ─── [5] Hard-cap split retains active date header in every segment ─────────

console.log("\n[5] Hard-cap timestamped line — header in every segment");

test("hard-cap split of timestamped line retains date header in every segment", () => {
  // Create a short chunk then a single timestamped line that exceeds HARD_TOKEN_CAP.
  // HARD_TOKEN_CAP = 64000 tokens. Latin text: ~0.25 tokens/char → need ~256000+ chars.
  const PADDING = "x".repeat(260000);
  const shortPrefix = formatNarrativeTranscript([
    { role: "user", text: "Short message before the big one", timestamp: "2026-07-05T10:00:00Z" },
  ], { timeZone: "Asia/Jakarta" });

  const bigLine = formatTranscriptMessageLines(
    { role: "user", text: PADDING, timestamp: "2026-07-05T10:01:00Z" },
    { timeZone: "Asia/Jakarta" },
  )[0]; // e.g. "[17:01] user: xxx..."

  const rawText = shortPrefix + "\n" + bigLine;

  const chunks = splitIntoChunks(rawText, "/ws", "main", "live-turn", "size-limit", 0);

  // The big line exceeds HARD_TOKEN_CAP so there should be multiple chunks
  assert.ok(chunks.length >= 2, `hard-cap split expected >= 2 chunks, got ${chunks.length}`);

  // EVERY chunk that contains timestamped content MUST have the date header as its
  // first line — not just the first segment. This proves the header is injected into
  // every hard-cap segment, not just the first.
  for (let ci = 0; ci < chunks.length; ci++) {
    const raw = chunks[ci].rawText;
    const lines = raw.split("\n");
    const hasTimestampedLine = lines.some(l => /^\[\d{2}:\d{2}\]\s(user|assistant):/.test(l));
    if (hasTimestampedLine) {
      const firstLine = lines[0];
      assert.ok(
        /^\(\d{4}-\d{2}-\d{2}\s+\w+\)$/.test(firstLine),
        `chunk ${ci}: every timestamped segment must start with date header, got: ${JSON.stringify(firstLine)}`
      );
    }
  }

  // The first chunk (shortPrefix) must also start with date header
  assert.ok(
    /^\(\d{4}-\d{2}-\d{2}\s+\w+\)$/.test(chunks[0].rawText.split("\n")[0]),
    `first chunk starts with date header, got: ${JSON.stringify(chunks[0].rawText.split("\n")[0])}`
  );
});

// ─── [6] Forced split — continuation context with date header ────────────────

console.log("\n[6] Forced split — continuation retains date header context");

test("continuation after forced soft split retains date header", () => {
  // Design: total rawText exceeds HARD_TOKEN_CAP (64K) to bypass the early-return
  // single-chunk path and enter the split loop. Within the loop, the first line
  // fills most of SOFT_TOKEN_TARGET (48K) and the second line triggers a soft split.
  //
  // HARD_TOKEN_CAP = 64000 tokens. Latin text: ~0.25 tokens/char.
  // Total must be > 64000 to enter the split loop.
  // First message: ~190000 chars = ~47500 tokens.
  // Second message: ~90000 chars = ~22500 tokens.
  // Total: ~70000 > 64000 → enters loop. 47500 + 22500 = 70000 > 48000 → soft split.
  const PADDING_A = "a".repeat(190000);
  const PADDING_B = "b".repeat(90000);

  const messages = [
    { role: "user", text: PADDING_A, timestamp: "2026-07-05T10:00:00Z" },
    { role: "assistant", text: PADDING_B, timestamp: "2026-07-05T10:01:00Z" },
  ];

  const rawText = formatNarrativeTranscript(messages, { timeZone: "Asia/Jakarta" });
  const msgObjects = messages.map(m => ({
    role: m.role, content: m.text, timestamp: m.timestamp,
  }));

  const chunks = splitIntoChunks(rawText, "/ws", "main", "live-turn", "size-limit", 0, msgObjects);

  // Must split into >= 2 chunks
  assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);

  // Every chunk with timestamped content must start with date header
  for (let ci = 0; ci < chunks.length; ci++) {
    const lines = chunks[ci].rawText.split("\n");
    const hasTimestampedLine = lines.some(l => /^\[\d{2}:\d{2}\]\s(user|assistant):/.test(l));
    if (hasTimestampedLine) {
      assert.ok(
        /^\(\d{4}-\d{2}-\d{2}\s+\w+\)$/.test(lines[0]),
        `chunk ${ci}: must start with date header after split, got: ${JSON.stringify(lines[0])}`
      );
    }
  }
});

test("multiline continuation after split retains date header", () => {
  // One timestamped user message: the first line fills almost 48K tokens, then
  // its unprefixed continuation line forces the soft split. Total is >64K so the
  // queue splitter runs instead of returning the input as one chunk.
  const FIRST_LINE = "c".repeat(190000);
  const CONTINUATION = "d".repeat(90000);

  const messages = [
    { role: "user", text: FIRST_LINE + "\n" + CONTINUATION, timestamp: "2026-07-05T10:00:00Z" },
  ];

  const rawText = formatNarrativeTranscript(messages, { timeZone: "Asia/Jakarta" });
  const msgObjects = messages.map(m => ({
    role: m.role, content: m.text, timestamp: m.timestamp,
  }));

  const chunks = splitIntoChunks(rawText, "/ws", "main", "live-turn", "size-limit", 0, msgObjects);

  // Must split — total exceeds HARD_TOKEN_CAP and continuation crosses SOFT_TOKEN_TARGET
  assert.ok(chunks.length >= 2, `expected >= 2 chunks from multi-line, got ${chunks.length}`);

  const continuationChunk = chunks.find(chunk => chunk.rawText.includes(CONTINUATION));
  assert.ok(continuationChunk, "continuation must be retained in a later chunk");
  assert.match(
    continuationChunk.rawText.split("\n")[0],
    /^\(2026-07-05 Sunday\)$/,
    "chunk beginning with an unprefixed continuation must carry its date header",
  );
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
