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

/** [v0.4.21e] Canonicalize agentWs path for stable state key construction.
 *  Platform-aware: lowercases on case-insensitive filesystems (win32) only.
 *  On Linux/macOS, case is preserved to avoid false identity collision
 *  on case-sensitive filesystems (common on Linux, possible on macOS).
 *  Normalizes path separators (\→/) and strips trailing slashes on all platforms.
 *  Returns DJB2 hash (base36) of the normalized path.
 *
 *  DESIGN NOTE (Option A): False identity collision (different dirs → same hash)
 *  is worse than false split (same dir → different hashes). Split only causes
 *  extra dedup misses; collision causes data corruption across workspaces.
 */
export function agentWsHash(agentWs: string): string {
  // Order: normalize separators → strip trailing slash → lowercase (win32 only)
  // is equivalent to the old order (normalize → lowercase → strip) because
  // lowercasing '/' is still '/' and stripping after lowercasing is same as before.
  let normalized = agentWs.replace(/\\/g, '/').replace(/\/+$/, '');
  // Case normalization only on Windows (case-insensitive by default)
  // NOTE: macOS default (APFS/HFS+) is also case-insensitive, but we don't
  // lowercase there to avoid false collision on case-sensitive macOS volumes.
  // This is an accepted false-split: same workspace with different case on
  // macOS gets separate entries, which is less harmful than false collision.
  if (process.platform === 'win32') {
    normalized = normalized.toLowerCase();
  }
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) & 0x7FFFFFFF;
  }
  return hash.toString(36);
}
