/**
 * Basic CJK-aware token estimation
 * Assumes CJK characters are roughly 1.5 tokens each and Latin characters are 0.25 tokens each.
 */
export function estimateTokens(text: string): number {
    let count = 0;
    for (const char of text) {
        count += char.charCodeAt(0) > 0x2E80 ? 1.5 : 0.25; 
    }
    return Math.ceil(count);
}
