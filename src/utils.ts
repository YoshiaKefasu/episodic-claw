/**
 * Basic CJK-aware token estimation.
 * Assumes CJK characters are roughly 1.5 tokens each and Latin characters are 0.25 tokens each.
 *
 * Known deviation: This estimate can overshoot by ~20-30% for CJK-heavy text
 * compared to BPE-based tokenizers (cl100k_base, claude). Callers using this
 * for threshold comparisons against host-provided tokenBudget should account
 * for this margin (e.g. contextThreshold default 0.85 absorbs most of it).
 */
export function estimateTokens(text: string): number {
    let count = 0;
    for (const char of text) {
        count += char.charCodeAt(0) > 0x2E80 ? 1.5 : 0.25; 
    }
    return Math.ceil(count);
}
