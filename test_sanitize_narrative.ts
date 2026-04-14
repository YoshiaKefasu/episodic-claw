import { sanitizeNarrativeOutput } from "./src/narrative-worker";

let passed = 0;
let failed = 0;

function assert(label: string, actual: string, expected: string) {
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

console.log("\n=== sanitizeNarrativeOutput Tests ===");

// Case 1: <final> tag removal
assert(
  "strips <final>...</final> wrapper",
  sanitizeNarrativeOutput("<final>物語の本文です。</final>"),
  "物語の本文です。"
);

// Case 2: [[reply_to_current]] removal
assert(
  "strips [[reply_to_current]]",
  sanitizeNarrativeOutput("[[reply_to_current]] おう、バッチリいるぜ！"),
  "おう、バッチリいるぜ！"
);

// Case 3: [analysis] line-start removal
assert(
  "strips [analysis] at line start",
  sanitizeNarrativeOutput("[analysis]\nこの質問は技術的に重要で..."),
  "この質問は技術的に重要で..."
);

// Case 4: multiple tags mixed
assert(
  "strips multiple mixed tags",
  sanitizeNarrativeOutput("<final>\n[[reply_to_current]] テスト\n[analysis]\n内容\n</final>"),
  "テスト\n内容"
);

// Case 5: clean text passthrough
assert(
  "passes through clean narrative text",
  sanitizeNarrativeOutput("Yosiaはその日、新しいプラグインの開発に取り組んでいた。"),
  "Yosiaはその日、新しいプラグインの開発に取り組んでいた。"
);

// Case 6: empty string
assert(
  "handles empty string",
  sanitizeNarrativeOutput(""),
  ""
);

// Case 7: [reply_to_current] (single bracket)
assert(
  "strips [reply_to_current] (single bracket)",
  sanitizeNarrativeOutput("[reply_to_current] 物語化で完了よ！"),
  "物語化で完了よ！"
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
