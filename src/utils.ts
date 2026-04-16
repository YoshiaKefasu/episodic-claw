/**
 * Basic CJK-aware token estimation.
 * Assumes CJK characters are roughly 1.5 tokens each and Latin characters are 0.25 tokens each.
 *
 * Known deviation: This estimate can overshoot by ~20-30% for CJK-heavy text
 * compared to BPE-based tokenizers (cl100k_base, claude). Callers using this
 * for threshold comparisons against host-provided tokenBudget should account
 * for this margin when applying any prompt-budget guard.
 *
 * [AUDIT NOTE] The ~20-30% overshoot for CJK is intentional and NOT a bug:
 * - It provides a safety margin against API 400 errors from underestimation
 * - Premature chunk splitting (hitting 48K target early) is safer than exceeding the 64K hard cap
 * - Approximation (text.length * factor) was rejected in v0.4.12 Pro Engineer Review as YAGNI risk
 */
export function estimateTokens(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
        count += text.charCodeAt(i) > 0x2E80 ? 1.5 : 0.25; 
    }
    return Math.ceil(count);
}
