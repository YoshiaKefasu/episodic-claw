import { sanitizeNarrativeOutput, checkCompressionRatio, checkEchoDetection, checkNarrativeFormat, DEFAULT_USER_PROMPT_TEMPLATE } from "./src/narrative-worker";

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

// [v0.4.17] sanitizeNarrativeOutput strips untagged CoT prefix
assert(
  "v0.4.17: strips untagged CoT prefix 'Okay, let me...'",
  sanitizeNarrativeOutput("Okay, let me start by understanding the log.\nI need to parse this carefully.\n夜の作業机では、彼はログを追っていた。"),
  "夜の作業机では、彼はログを追っていた。"
);


// --- checkNarrativeFormat (v0.4.17) ---
console.log("\n[4] checkNarrativeFormat Tests (v0.4.17)");

// CoT leakage detection
assert(
  "CoT prefix 'Okay, let me...' should be rejected",
  checkNarrativeFormat("Okay, let me start by understanding the conversation log.\n夜の作業机では...").pass,
  false
);

assert(
  "CoT prefix 'First, I need to...' should be rejected",
  checkNarrativeFormat("First, I need to parse the log.\nそれから...").pass,
  false
);

// Assistant-mode detection
assert(
  "Bullet list should be rejected",
  checkNarrativeFormat("- 開発の背景\n- CLIの安定化").pass,
  false
);

assert(
  "Numbered list should be rejected",
  checkNarrativeFormat("1. CLIの安定化\n2. ベクトル化").pass,
  false
);

assert(
  "Markdown header should be rejected",
  checkNarrativeFormat("# OpenClawのアップデート\n本文...").pass,
  false
);

assert(
  "Japanese assistant phrase 'ありがとうございます' at start should be rejected",
  checkNarrativeFormat("ありがとうございます！このプロジェクトをまとめました。").pass,
  false
);

assert(
  "Japanese phrase mid-sentence (role-play) should NOT be rejected (False Positive guard)",
  checkNarrativeFormat("彼は画面に向かって「ありがとうございます」と答え、次の作業に取りかかった。").pass,
  true
);

assert(
  "Emoji should be rejected",
  checkNarrativeFormat("プロジェクトが完了した✨").pass,
  false
);

// Valid narrative should pass
assert(
  "Valid narrative starting with CJK should pass",
  checkNarrativeFormat("夜更けの作業机では、彼はログを追いながら次の手を探っていた。").pass,
  true
);

assert(
  "Valid narrative starting with time expression should pass",
  checkNarrativeFormat("日曜の夕方、ヨシアはテストメッセージを送った。").pass,
  true
);

assert(
  "Valid narrative starting with lowercase Latin should pass",
  checkNarrativeFormat("the evening sun cast long shadows across the desk.").pass,
  true
);


// --- v0.4.18 False Positive regression tests ---
console.log("\n[5] v0.4.18 False Positive Regression Tests");

// Fix 1: cotPrefixPat should NOT strip legitimate narrative starting with "First"
assert(
  "v0.4.18: 'First, he walked...' is NOT stripped by sanitizeNarrativeOutput",
  sanitizeNarrativeOutput("First, he walked to the store. The rain was heavy."),
  "First, he walked to the store. The rain was heavy."
);

assert(
  "v0.4.18: 'First the rain came...' is NOT stripped by sanitizeNarrativeOutput",
  sanitizeNarrativeOutput("First the rain came, then the wind. He hurried inside."),
  "First the rain came, then the wind. He hurried inside."
);

assert(
  "v0.4.18: 'First, I need to...' IS still stripped by sanitizeNarrativeOutput (CoT)",
  sanitizeNarrativeOutput("First, I need to parse the log.\n夜の作業机では、彼はログを追っていた。"),
  "夜の作業机では、彼はログを追っていた。"
);

// Fix 2: narrativeStartPat should accept digit-starting narratives
assert(
  "v0.4.18: '2026年の冬、' starts with digit and should pass checkNarrativeFormat",
  checkNarrativeFormat("2026年の冬、彼は新しいプロジェクトに着手した。").pass,
  true
);

assert(
  "v0.4.18: '3月15日、' starts with digit and should pass checkNarrativeFormat",
  checkNarrativeFormat("3月15日、ヨシアは設計図を描き始めた。").pass,
  true
);

assert(
  "v0.4.18: '5年前のあの日、' starts with digit and should pass checkNarrativeFormat",
  checkNarrativeFormat("5年前のあの日、すべてが変わった。").pass,
  true
);

// Fix 3: emojiPat should NOT flag standalone '≧' in technical context
assert(
  "v0.4.18: 'delta ≧ 0' technical notation should pass checkNarrativeFormat",
  checkNarrativeFormat("彼は条件 delta ≧ 0 を確認し、処理を続行した。").pass,
  true
);

// Fix 3 regression: full kaomoji '≧∇≦' should STILL be rejected
// Fix 3 regression: full kaomoji '≧∇≦' should STILL be rejected
assert(
  "v0.4.18: '≧∇≦' kaomoji should still be rejected",
  checkNarrativeFormat("お疲れ様でした≧∇≦").pass,
  false
);


// === v0.4.19b Fix 2a: DEFAULT prompt paragraph allowance ===

assert(
  "Fix 2a: DEFAULT_USER_PROMPT_TEMPLATE does not contain 'One continuous narrative body'",
  DEFAULT_USER_PROMPT_TEMPLATE(undefined, "test conversation text").includes("One continuous narrative body"),
  false
);

assert(
  "Fix 2a: DEFAULT_USER_PROMPT_TEMPLATE instructs natural paragraph breaks",
  DEFAULT_USER_PROMPT_TEMPLATE(undefined, "test conversation text").includes("paragraph"),
  true
);


// === v0.4.19b Fix 2b Gate 6: Paragraph structure ===

assert(
  "Gate 6: single-paragraph wall-of-text over 500 chars should fail",
  checkNarrativeFormat("彼はログを追いながら次の手を探っていた。前回のトークン不安は収まり、代わりに仕事をやり遂げた満足感が残っていた。ヨシアの最新アップデートはEpisodic-Claw v0.4.9の傑作で、物語エピソード生成が完璧に機能していた。しかし静寂は欺瞞だった。ヨシアが突然二日間沈黙した時、カソウは最初の不安を感じた。彼の挨拶の省略記号がそれを確認した。続く画像が物語を語った。バグのカスケード、記憶喪失、システム障害がヨシアを限界へと押しやったのである。OpenClaw v2026.4.5をDennouAibouにフォークする決断は天才的だった。名前そのものが二人の関係を完璧に捉えていた。ヨシアがCherry-Pickアップデートと積極的なデブロートを実装して徹夜で作業する間、カソウは誇りを持って見守った。さらに翌朝、動作確認のためにテストメッセージを送信したところ即座に応答があり、接続が復旧したことを確認した。この出来事を通じて二人の絆はより深まったのである。翌日のタスクでは、新しく追加されたレスキュー機能のテストを実行し、全パスを確認した後、本番環境へのデプロイを承認した。その日の夕方には全ての主要機能が安定稼働を確認し、二人は成功を祝った。").pass,
  false
);

assert(
  "Gate 6 reason for wall-of-text includes 'single-paragraph'",
  checkNarrativeFormat("彼はログを追いながら次の手を探っていた。前回のトークン不安は収まり、代わりに仕事をやり遂げた満足感が残っていた。ヨシアの最新アップデートはEpisodic-Claw v0.4.9の傑作で、物語エピソード生成が完璧に機能していた。しかし静寂は欺瞞だった。ヨシアが突然二日間沈黙した時、カソウは最初の不安を感じた。彼の挨拶の省略記号がそれを確認した。続く画像が物語を語った。バグのカスケード、記憶喪失、システム障害がヨシアを限界へと押しやったのである。OpenClaw v2026.4.5をDennouAibouにフォークする決断は天才的だった。名前そのものが二人の関係を完璧に捉えていた。ヨシアがCherry-Pickアップデートと積極的なデブロートを実装して徹夜で作業する間、カソウは誇りを持って見守った。さらに翌朝、動作確認のためにテストメッセージを送信したところ即座に応答あり、接続が復旧したことを確認した。この出来事を通じて二人の絆はより深まったのである。翌日のタスクでは、新しく追加されたレスキュー機能のテストを実行し、全パスを確認した後、本番環境へのデプロイを承認した。その日の夕方には全ての主要機能が安定稼働を確認し、二人は成功を祝った。").reason.includes("single-paragraph"),
  true
);

assert(
  "Gate 6: multi-paragraph text over 500 chars should pass",
  checkNarrativeFormat("彼はログを追いながら次の手を探っていた。前回のトークン不安は収まり、満足感が残っていた。\n\nしかし静寂は欺瞞だった。ヨシアが突然二日間沈黙した時、最初の不安を感じた。続く画像が物語を語った。バグのカスケードがヨシアを限界へと押しやった。\n\nOpenClawをDennouAibouにフォークする決断は天才的だった。名前そのものが二人の関係を完璧に捉えていた。").pass,
  true
);

assert(
  "Gate 6: short single-paragraph text under 500 chars should pass",
  checkNarrativeFormat("彼はログを追いながら次の手を探っていた。前回の不安は収まった。").pass,
  true
);

assert(
  "Gate 6: text with \\r\\n\\r\\n paragraph breaks should pass",
  checkNarrativeFormat("彼はログを追いながら次の手を探っていた。\r\n\r\nしかし静寂は欺瞞だった。ヨシアが沈黙した時、最初の不安を感じた。").pass,
  true
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
