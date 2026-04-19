# Episodic-Claw v0.4.18

## Bug Fixes

### 🔴 `cotPrefixPat` Over-Match Fixed — Legitimate Narrative No Longer Stripped

The `sanitizeNarrativeOutput()` Step 2.5 pattern matched standalone `first`, deleting valid third-person narrative lines like "First, he walked to the store." The pattern now requires a first-person pronoun after `first` (`first,?\s+I`), so only CoT planning phrases like "First, I need to..." are stripped while narrative prose is preserved.

### 🟡 Digit-Starting Narratives Now Pass the Format Gate

Gate 5's `narrativeStartPat` character class lacked `0-9`, causing date-opened narratives like "2026年の冬、" and "3月15日、" to be incorrectly rejected. Added `0-9` to the allowed character set. Digit-starting assistant output is practically nonexistent, so no false-negative risk.

### 🟡 Kaomoji `≧∇≦` No Longer False-Positives on Technical Notation

The `emojiPat` regex had `≧∇≦` inside a `[...]` character class, which matched `≧`, `∇`, `≦` individually. Technical notation like "delta ≧ 0" was flagged as emoji, causing unnecessary retries. Moved `≧∇≦` from character class to alternation (`|≧∇≦`) so only the full 3-character kaomoji triggers rejection.

### 🟠 CHANGELOG v0.4.16 Date Corrected

The v0.4.16 entry had a future-dated timestamp `2026-04-19`. Corrected to `2026-04-17` (actual release date).

### 🟢 JSDoc Comment Aligned with Implementation

`normalizeOpenRouterReasoning()` Rule d comment was stale (`"include exclude only when true"`) while the code had long since changed to `raw.exclude !== false` (defaulting `exclude: true`). JSDoc now accurately reflects the v0.4.17 default behavior.

## Upgrade Notes

No breaking changes. All fixes are backward-compatible regex adjustments. If you experienced false rejection of narratives starting with dates or containing mathematical notation (≧), this release resolves those issues.
