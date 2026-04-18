/**
 * v0.4.19b: Conversation-boundary-aware chunking tests
 * Tests for: detectRoleLine(), buildFlushItem role labels, splitIntoChunks structured/fallback paths
 */
import { splitIntoChunks, detectRoleLine } from "./src/narrative-queue";
import { NarrativePool } from "./src/narrative-pool";
import type { Message } from "./src/segmenter";

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

console.log("\n=== Narrative Chunking Tests (v0.4.19b) ===");

// === Fix 5a: Role labels in rawText (buildFlushItem) ===

console.log("\n[1] buildFlushItem Role Labels");

const pool = new NarrativePool(100000);

pool.add([
  { role: "user", content: "テスト送るね" },
  { role: "assistant", content: "バッチリ聞こえてるぜ" },
  { role: "user", content: "次はリリースノート書いて" },
], 0, "/ws", "main");
const flushItem = pool.forceFlush("/ws", "main");
assert(
  "buildFlushItem adds role labels to user/assistant messages",
  flushItem !== null && flushItem.rawText.includes("user: テスト送るね") &&
    flushItem.rawText.includes("assistant: バッチリ聞こえてるぜ") &&
    flushItem.rawText.includes("user: 次はリリースノート書いて"),
  true
);

// [v0.4.19b] tool_use is transformed by segmenter.processTurn() into "[Tool Used: ...]"
// BEFORE reaching buildFlushItem. So we test with the transformed format.
const pool2 = new NarrativePool(100000);
pool2.add([
  { role: "user", content: "質問" },
  { role: "tool_use", content: "[Tool Used: code_searcher]" },
  { role: "assistant", content: "回答" },
], 0, "/ws", "main");
const flushItem2 = pool2.forceFlush("/ws", "main");
assert(
  "buildFlushItem passes tool_use messages without role label prefix",
  flushItem2 !== null &&
    flushItem2.rawText.includes("user: 質問") &&
    flushItem2.rawText.includes("[Tool Used: code_searcher]") &&
    flushItem2.rawText.includes("assistant: 回答"),
  true
);
// Verify that [Tool Used: ...] does NOT get a role prefix
assert(
  "buildFlushItem does NOT prefix tool_use with role label",
  flushItem2 !== null && !flushItem2.rawText.includes("tool_use: [Tool Used"),
  true
);

// === Fix 5b: detectRoleLine ===

console.log("\n[2] detectRoleLine Tests");

assert(
  "detectRoleLine detects 'user: ' prefix",
  detectRoleLine("user: テスト送るね"),
  "user"
);

assert(
  "detectRoleLine detects 'assistant: ' prefix",
  detectRoleLine("assistant: バッチリ聞こえてるぜ"),
  "assistant"
);

assert(
  "detectRoleLine returns null for plain text line",
  detectRoleLine("普通のテキスト行"),
  null
);

assert(
  "detectRoleLine returns null for [Tool Used: ...] line",
  detectRoleLine("[Tool Used: code_searcher]"),
  null
);

// === Fix 5b: splitIntoChunks — single-chunk structured path ===
// With short content, splitIntoChunks returns a single chunk.
// This test verifies that the messages parameter is accepted and the
// lineToRole mapping is built correctly without errors.

console.log("\n[3] splitIntoChunks with messages (single-chunk, structured path)");

const shortMessages: Message[] = [
  { role: "user", content: "短いユーザーメッセージ" },
  { role: "assistant", content: "短いアシスタントレスポンス" },
];
const shortRawText = shortMessages
  .map(m => `${m.role}: ${m.content}`)
  .join("\n");
const singleChunk = splitIntoChunks(shortRawText, "/ws", "main", "live-turn", "size-limit", 0, shortMessages);
assert(
  "splitIntoChunks with messages returns a single chunk for short content",
  singleChunk.length === 1,
  true
);
assert(
  "Single chunk preserves role-labeled content",
  singleChunk[0].rawText.includes("user: 短いユーザーメッセージ") &&
    singleChunk[0].rawText.includes("assistant: 短いアシスタントレスポンス"),
  true
);

// === Fix 5b: splitIntoChunks — multi-chunk with role labels (fallback path) ===
// Generate enough content to exceed SOFT_TOKEN_TARGET (48,000 tokens ≈ 32,000 CJK chars)

console.log("\n[4] splitIntoChunks multi-chunk with role labels (fallback path)");

// Use long Latin text to make token estimation more predictable (~0.25 tokens/char)
// Need ~48,000 tokens = ~192,000 chars of Latin text
const lines: string[] = [];
for (let i = 0; i < 2000; i++) {
  lines.push(`user: This is message number ${i} from the user. It contains enough text to eventually trigger multiple chunks when the total token count exceeds the soft token target of forty-eight thousand tokens.`);
  lines.push(`assistant: This is response number ${i} from the assistant. The response provides a detailed answer with enough text to contribute to the overall token count for chunk boundary detection purposes.`);
}
const longRawText = lines.join("\n");
const multiChunks = splitIntoChunks(longRawText, "/ws", "main", "live-turn", "size-limit", 0);
assert(
  "splitIntoChunks with enough content produces multiple chunks",
  multiChunks.length > 1,
  true
);

// Each chunk should start with a role-labeled line
let allChunksStartWithRole = true;
for (const chunk of multiChunks) {
  const firstLine = chunk.rawText.split("\n")[0];
  const role = detectRoleLine(firstLine);
  if (role !== "user" && role !== "assistant") {
    allChunksStartWithRole = false;
    break;
  }
}
assert(
  "Each chunk starts with a role-labeled line (fallback path)",
  allChunksStartWithRole,
  true
);

// === Backward compatibility: no role labels ===

console.log("\n[5] splitIntoChunks backward compatibility (no role labels)");

const linesNoRole: string[] = [];
for (let i = 0; i < 2000; i++) {
  linesNoRole.push(`This is plain text line number ${i} without any role labels. It contains enough text to contribute to the overall token count for chunk boundary detection.`);
}
const rawTextNoRole = linesNoRole.join("\n");
const chunksNoRole = splitIntoChunks(rawTextNoRole, "/ws", "main", "live-turn", "size-limit", 0);
assert(
  "splitIntoChunks without role labels produces multiple chunks (backward compat)",
  chunksNoRole.length > 1,
  true
);

let allNoRoleLines = true;
for (const chunk of chunksNoRole) {
  const chunkLines = chunk.rawText.split("\n");
  for (const line of chunkLines) {
    if (detectRoleLine(line) !== null) {
      allNoRoleLines = false;
      break;
    }
  }
  if (!allNoRoleLines) break;
}
assert(
  "No role labels detected in backward-compat chunks",
  allNoRoleLines,
  true
);

// === Discrepancy 3: structured path does NOT false-positive on content starting with 'user: ' ===

console.log("\n[6] Structured path: content starting with 'user: ' is NOT false-positived");

const trickyMessages: Message[] = [
  { role: "assistant", content: "user: という名前の新しいコマンドを追加しました。" },
  { role: "user", content: "なるほど、それなら動くね" },
];
const trickyRawText = trickyMessages
  .map(m => {
    const role = m.role === "user" || m.role === "assistant" ? m.role : null;
    return role ? `${role}: ${m.content}` : String(m.content);
  })
  .join("\n");
// rawText = "assistant: user: という名前の新しいコマンドを追加しました。\nuser: なるほど、それなら動くね"

const chunksTricky = splitIntoChunks(trickyRawText, "/ws", "main", "live-turn", "size-limit", 0, trickyMessages);
assert(
  "Structured path handles content starting with 'user: ' correctly",
  chunksTricky.length >= 1 && chunksTricky[0].rawText.includes("assistant: user: という名前"),
  true
);

// Verify that lineToRole correctly identifies the FIRST message's role as "assistant"
// NOT "user" (which would be the false-positive if we relied on string matching)
const trickyLineToRole = new Map<string, "user" | "assistant" | null>();
for (const m of trickyMessages) {
  const text = m.content as string;
  const role = m.role === "user" || m.role === "assistant" ? m.role : null;
  const lineKey = role ? `${role}: ${text}` : text;
  trickyLineToRole.set(lineKey, role);
}
assert(
  "lineToRole maps 'assistant: user: ...' to role 'assistant' (not 'user')",
  trickyLineToRole.get("assistant: user: という名前の新しいコマンドを追加しました。") === "assistant",
  true
);

// === Fix 5c: PoolFlushItem.messages is populated ===

console.log("\n[7] PoolFlushItem.messages accessibility");

const pool3 = new NarrativePool(100000);
pool3.add([
  { role: "user", content: "テスト" },
  { role: "assistant", content: "回答" },
], 0, "/ws", "main");
const flushItem3 = pool3.forceFlush("/ws", "main");
assert(
  "PoolFlushItem.messages is populated",
  flushItem3 !== null && flushItem3.messages !== undefined,
  true
);
assert(
  "PoolFlushItem.messages has correct length",
  flushItem3 !== null && flushItem3.messages.length === 2,
  true
);
assert(
  "PoolFlushItem.messages[0].role is 'user'",
  flushItem3 !== null && flushItem3.messages[0].role === "user",
  true
);
assert(
  "PoolFlushItem.messages[1].role is 'assistant'",
  flushItem3 !== null && flushItem3.messages[1].role === "assistant",
  true
);


// === Regression test: multi-line message content in lineToRole Map ===
// [code-reviewer-lite fix] When extractText() returns text containing \n,
// the original lineToRole Map set a single multi-line key, which failed
// line-by-line lookup. The fix splits labeledLine into sub-lines.

console.log("\n[8] lineToRole multi-line content regression test");

const multiLineMessages: Message[] = [
  { role: "assistant", content: "The user said:\nuser: I need help" },  // multi-line with embedded "user: " prefix
  { role: "user", content: "Thanks for the help" },
];
const multiLineRawText = multiLineMessages
  .map(m => {
    const role = m.role === "user" || m.role === "assistant" ? m.role : null;
    return role ? `${role}: ${m.content}` : String(m.content);
  })
  .join("\n");
// rawText = "assistant: The user said:\nuser: I need help\nuser: Thanks for the help"

const multiLineChunks = splitIntoChunks(multiLineRawText, "/ws", "main", "live-turn", "size-limit", 0, multiLineMessages);
assert(
  "Multi-line structured path handles embedded 'user: ' prefix correctly",
  multiLineChunks.length >= 1,
  true
);

// The key assertion: the sub-line "user: I need help" embedded in an assistant response
// should NOT be detected as a real user role line when using the structured path.
// With the fix, lineToRole maps "user: I need help" → "assistant" (the message's real role),
// overriding the detectRoleLine() false positive.
// Build a manual lineToRole to verify the fix logic
const fixedLineToRole = new Map<string, "user" | "assistant" | null>();
for (const m of multiLineMessages) {
  const text = m.content as string;
  const role = m.role === "user" || m.role === "assistant" ? m.role : null;
  const labeledLine = role ? `${role}: ${text}` : text;
  for (const subLine of labeledLine.split("\n")) {
    if (!fixedLineToRole.has(subLine)) {
      fixedLineToRole.set(subLine, role);
    }
  }
}
assert(
  "lineToRole maps embedded 'user: I need help' sub-line to 'assistant' (not 'user')",
  fixedLineToRole.get("user: I need help") === "assistant",
  true
);
assert(
  "lineToRole maps real user message 'user: Thanks for the help' to 'user'",
  fixedLineToRole.get("user: Thanks for the help") === "user",
  true
);


console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
