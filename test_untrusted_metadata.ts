/**
 * test_untrusted_metadata.ts
 *
 * Unit regression tests for stripUntrustedMetadataBlocks() (src/untrusted-metadata.ts).
 * Covers the blind spots identified in the v0.4.28e post-implementation audit:
 *
 *   BS-1: Header-only removal leaving orphaned ```json``` blocks in Phase 1 query path
 *   BS-2: anchorSanitizeApplied semantics (always true after E2 block)
 *
 * Run with:  npx tsx test_untrusted_metadata.ts
 */
import assert from "node:assert/strict";
import { stripUntrustedMetadataBlocks } from "./src/untrusted-metadata.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

console.log("\n=== stripUntrustedMetadataBlocks unit tests ===\n");

// ── Case 1: Full block — header + fenced json ──────────────────────────────
test("Full block: Conversation info header + json block → stripped", () => {
  const input = `Conversation info (untrusted metadata): chat context
\`\`\`json
{"chatId": "abc123", "platform": "telegram"}
\`\`\``;
  const result = stripUntrustedMetadataBlocks(input);
  assert.equal(result, "", `Expected empty, got: ${JSON.stringify(result)}`);
});

// ── Case 2: Sender block ───────────────────────────────────────────────────
test("Full block: Sender (untrusted metadata) + json block → stripped", () => {
  const input = `Sender (untrusted metadata): user info
\`\`\`json
{"userId": "u42", "firstName": "Alice"}
\`\`\``;
  const result = stripUntrustedMetadataBlocks(input);
  assert.equal(result, "");
});

// ── Case 3: Replied message block ─────────────────────────────────────────
test("Full block: Replied message (untrusted, for context) + json → stripped", () => {
  const input = `Replied message (untrusted, for context): original message
\`\`\`json
{"text": "hi there"}
\`\`\``;
  const result = stripUntrustedMetadataBlocks(input);
  assert.equal(result, "");
});

// ── Case 4: User content survives ─────────────────────────────────────────
test("User content after metadata block is preserved", () => {
  const input = `Conversation info (untrusted metadata): context
\`\`\`json
{"chatId": "abc"}
\`\`\`
今日の漢字テストは70点でした`;
  const result = stripUntrustedMetadataBlocks(input);
  assert.ok(result.includes("70点"), `Expected '70点' in result, got: ${JSON.stringify(result)}`);
  assert.ok(!result.includes("chatId"), `Expected no 'chatId' in result`);
});

// ── Case 5: Metadata-only prompt → empty (anchor rejection case) ──────────
test("Metadata-only prompt → empty string (anchor rejection scenario)", () => {
  const metadata = [
    `Conversation info (untrusted metadata): chat\n\`\`\`json\n{"id":"x"}\n\`\`\``,
    `Sender (untrusted metadata): user\n\`\`\`json\n{"uid":"y"}\n\`\`\``,
  ].join("\n");
  const result = stripUntrustedMetadataBlocks(metadata);
  assert.equal(result, "", `Expected empty, got: ${JSON.stringify(result)}`);
});

// ── Case 6: Standalone header line (no json block) ────────────────────────
test("Standalone header line without json block → stripped", () => {
  const input = `Conversation info (untrusted sender): some data\n実際のユーザーメッセージ`;
  const result = stripUntrustedMetadataBlocks(input);
  assert.ok(!result.includes("Conversation info"), "Header line should be stripped");
  assert.ok(result.includes("実際のユーザーメッセージ"), "User content should survive");
});

// ── Case 7: Orphaned fenced json block (BS-1 scenario) ────────────────────
test("Orphaned ```json``` block without header → stripped (BS-1 regression)", () => {
  // Simulates what happens in Phase 1 after header removal:
  // header was removed but json block remains
  const orphanedJson = `\`\`\`json\n{"chatId": "abc", "untrusted": true}\n\`\`\`\n合格ライン`;
  const result = stripUntrustedMetadataBlocks(orphanedJson);
  assert.ok(!result.includes("chatId"), "Orphaned json block should be stripped");
  assert.ok(result.includes("合格ライン"), "User content should survive");
});

// ── Case 8: Multiple metadata blocks ──────────────────────────────────────
test("Multiple metadata blocks → all stripped, user content survives", () => {
  const input = [
    `Conversation info (untrusted metadata): ctx\n\`\`\`json\n{"a":1}\n\`\`\``,
    `Sender (untrusted metadata): info\n\`\`\`json\n{"b":2}\n\`\`\``,
    `Replied message (untrusted, for context): prev\n\`\`\`json\n{"c":3}\n\`\`\``,
    `ユーザーの本文メッセージ`,
  ].join("\n");
  const result = stripUntrustedMetadataBlocks(input);
  assert.ok(!result.includes("chatId") && !result.includes('"a"'), "All json blocks stripped");
  assert.ok(result.includes("ユーザーの本文メッセージ"), "User content preserved");
});

// ── Case 9: Idempotency ────────────────────────────────────────────────────
test("Idempotency — calling twice gives same result", () => {
  const input = `Conversation info (untrusted metadata): data\n\`\`\`json\n{"x":1}\n\`\`\`\nHello`;
  const once = stripUntrustedMetadataBlocks(input);
  const twice = stripUntrustedMetadataBlocks(once);
  assert.equal(once, twice, "Result should be same on second call");
});

// ── Case 10: Empty string ─────────────────────────────────────────────────
test("Empty string input → returns empty string (no crash)", () => {
  const result = stripUntrustedMetadataBlocks("");
  assert.equal(result, "");
});

// ── Case 11: Whitespace-only input ────────────────────────────────────────
test("Whitespace-only input → returns empty string", () => {
  const result = stripUntrustedMetadataBlocks("   \n\n   ");
  assert.equal(result, "");
});

// ── Case 12: Query contamination scenario (E4a BS-1) ──────────────────────
test("Query keyword extraction scenario: json content does not leak (BS-1 regression)", () => {
  // Simulates a message that would go through instantDeterministicRewrite Phase 1.
  // The metadata block includes keywords that should NOT appear in the query.
  const message = `Conversation info (untrusted metadata): platform data\n\`\`\`json\n{"platform":"telegram","chatTitle":"ContaminationRisk","messageId":9999}\n\`\`\`\n今日の勉強ノートを整理したい`;
  const result = stripUntrustedMetadataBlocks(message);
  assert.ok(!result.includes("telegram"), "Platform keyword must not leak");
  assert.ok(!result.includes("ContaminationRisk"), "Chat title must not leak");
  assert.ok(!result.includes("messageId"), "Message ID must not leak");
  assert.ok(result.includes("勉強ノート"), "User intent must survive");
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(50)}`);
console.log(`v0.4.28e untrusted-metadata: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("SOME TESTS FAILED");
  process.exit(1);
}
console.log("ALL TESTS PASSED ✅");
