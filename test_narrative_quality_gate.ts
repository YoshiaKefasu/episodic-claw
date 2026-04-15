import { sanitizeNarrativeOutput, checkCompressionRatio, checkEchoDetection } from "./src/narrative-worker";

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

console.log("\n=== Narrative Quality Gate Tests (v0.4.11) ===");

// --- checkCompressionRatio ---
console.log("\n[1] checkCompressionRatio Tests");

assert(
  "1.07% should pass compression ratio gate (normal narrative)",
  checkCompressionRatio(512, 47960),
  true
);

assert(
  "0.27% should fail compression ratio gate (4/14 fail case)",
  checkCompressionRatio(129, 47960),
  false
);

assert(
  "4% should pass compression ratio gate (small input)",
  checkCompressionRatio(80, 2000),
  true
);

assert(
  "7.5% should pass compression ratio gate (very small input)",
  checkCompressionRatio(15, 200),
  true
);

assert(
  "fails if exactly at 0.99%",
  checkCompressionRatio(99, 10000),
  false
);

assert(
  "passes if exactly at 1.0%",
  checkCompressionRatio(100, 10000),
  true
);


// --- checkEchoDetection ---
console.log("\n[2] checkEchoDetection Tests");

assert(
  "Verbatim echo from the start should be detected",
  checkEchoDetection(
    "おう、バッチリ聞こえてるぜ！(≧∇≦)b\nTelegramからでもメッセージ届いてる",
    "assistant: おう、バッチリ聞こえてるぜ！(≧∇≦)b\nTelegramからでもメッセージ届いてるってことは..."
  ),
  false // echo detected -> false (check failed)
);

assert(
  "Middle-part verbatim echo should be detected",
  checkEchoDetection(
    "これでどんな環境でも、僕らの「魂の共鳴（Pneuma Sync）」は止まらないな！今後とも頼むぜ！",
    "おう、バッチリ聞こえてるぜ！\nこれで場所を問わず...これでどんな環境でも、僕らの「魂の共鳴（Pneuma Sync）」は止まらないな！今後とも頼むぜ！"
  ),
  false // echo detected
);

assert(
  "Narrative output should NOT be flagged as echo",
  checkEchoDetection(
    "日曜の夕方、ヨシアはTelegramから一通のテストメッセージを送った。",
    "user: 聞こえたらバッチリだよで返事を\nassistant: おう、バッチリ聞こえてるぜ！"
  ),
  true // no echo -> true (check passed)
);

assert(
  "Very short output (<20 chars) should pass through to token gate",
  checkEchoDetection("短い", "長い入力テキストがここに入ります。"),
  true
);

assert(
  "Whitespaces should be normalized during comparison",
  checkEchoDetection(
    "おう、バッチリ  聞こえてるぜ！今日もなんか面白いこと思いついたか？Telegramからでもメッセージ届いてるぜ！", // > 20 chars
    "おう、バッチリ聞こえてるぜ！今日もなんか面白いこと思いついたか？Telegramからでもメッセージ届いてるぜ！"
  ),
  false // should still be detected as echo after normalization
);


// --- sanitizeNarrativeOutput (Regression) ---
console.log("\n[3] sanitizeNarrativeOutput Regression");

assert(
  "v0.4.9 regression: strips <final> tags",
  sanitizeNarrativeOutput("<final>物語の本文</final>"),
  "物語の本文"
);


console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
