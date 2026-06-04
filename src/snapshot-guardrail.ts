// src/snapshot-guardrail.ts — 5-rule guardrail for forgotten-episode snapshot LLM output.
//
// Rules (v2, 2026-06-01):
//   1. non_empty     — output must not be empty
//   2. no_cot_prefix — output must not start with a chain-of-thought
//                      marker (Sure, Okay, First, Let me, ...)
//   3. no_refusal    — output must not be a refusal phrase
//   4. one_line      — output must be a single line (no \n except at the end)
//   5. language_match — output must include characters from the
//                       expected language (ja: hiragana/katakana/kanji,
//                       en: ASCII printable only)
//
// On a rule hit the worker can call ReAsk with the returned reask
// suffix appended to the prompt. non_empty failure is terminal — we
// do not ReAsk on an empty response because the LLM needs a different
// prompt to recover.

export type GuardrailRule = "non_empty" | "no_cot_prefix" | "no_refusal" | "one_line" | "language_match";

export interface GuardrailResult {
  ok: boolean;
  rule?: GuardrailRule;
  /** Optional prompt suffix to append when ReAsking for this failure. */
  reask?: string;
}

/**
 * Check a candidate LLM summary against the 5-rule v2 guardrail.
 * Returns ok=true if all rules pass; otherwise ok=false with the first
 * failing rule and (if defined) a ReAsk suffix.
 */
export function checkGuardrailV2(text: string, expectedLang: string): GuardrailResult {
  const t = (text ?? "").trim();

  // 1. non_empty — terminal, no ReAsk
  if (t.length === 0) {
    return { ok: false, rule: "non_empty" };
  }

  // 2. no_cot_prefix
  if (/^(Sure|Okay|First|Let me|Here is|Here's)/i.test(t)) {
    return {
      ok: false,
      rule: "no_cot_prefix",
      reask: "1センテンスだけで、前置き・解説・改行なしの要約のみ出力してください。",
    };
  }

  // 3. no_refusal
  if (/(I cannot|I'm sorry|As an AI|Unfortunately, I)/i.test(t)) {
    return {
      ok: false,
      rule: "no_refusal",
      reask: "生成を拒否せず、必ず1センテンスの要約を出力してください。",
    };
  }

  // 4. one_line
  if (t.split("\n").filter((l) => l.trim()).length !== 1) {
    return {
      ok: false,
      rule: "one_line",
      reask: "1センテンスだけで、前置き・解説・改行なしの要約のみ出力してください。",
    };
  }

  // 5. language_match
  if (!matchesExpectedLang(t, expectedLang)) {
    return {
      ok: false,
      rule: "language_match",
      reask: `${expectedLang}で出力してください。`,
    };
  }

  return { ok: true };
}

/**
 * Lightweight language match for the two languages we care about.
 * Falls through to "match anything" for unknown languages so the
 * worker does not false-positive on lang fields it does not understand.
 *
 * ja → text contains a hiragana/katakana/CJK kanji codepoint
 * en → text is pure ASCII printable (plus \n)
 * default → true (no rule applied)
 */
export function matchesExpectedLang(text: string, expectedLang: string): boolean {
  switch (expectedLang) {
    case "ja":
      return /[\u3040-\u30ff\u4e00-\u9fff]/.test(text);
    case "en":
      // Allow printable ASCII plus \n, no multi-byte, no tabs.
      return /^[\x20-\x7e\n]*$/.test(text.trim());
    default:
      return true;
  }
}

/**
 * Strip a leading list-prefix marker (LLMs sometimes echo our prompt
 * framing back as a bullet). Handles "- ", "* ", and "1. " prefixes
 * at the start of the first non-empty line. Returns the body trimmed.
 */
export function stripListPrefix(text: string): string {
  const t = (text ?? "").trim();
  return t.replace(/^([-*]\s+|\d+\.\s+)/, "");
}
