# Episodic-Claw v0.4.29

## Summary

This release packages two production hardening tracks after `v0.4.28`:

1. `v0.4.28e` — blocks untrusted metadata contamination in recall query construction.
2. `v0.4.28f` — adds configurable OpenRouter transport timeout/retry controls for long-wait generation scenarios.

## What Changed

### 1) Untrusted metadata contamination fix (`v0.4.28e`)

- Added shared stripping for untrusted metadata blocks used by Telegram-style payloads.
- Hardened anchor normalization so `raw_prompt_fallback` no longer adopts full contaminated raw prompt as-is.
- Added query-side defensive strip in deterministic rewrite to prevent keyword pollution even if upstream sanitize misses edge cases.
- Added observability fields for anchor sanitize behavior.

### 2) OpenRouter timeout/retry transport control (`v0.4.28f`)

- Added configSchema keys:
  - `openrouterConfig.timeoutMs` (clamped to `30000..300000`)
  - `openrouterConfig.maxRetries` (clamped to `0..5`)
- Wired both keys to `OpenRouterClient` construction in runtime.
- Added startup logging for effective runtime values:
  - `openrouterTimeoutMs`
  - `openrouterMaxRetries`

## Recommended Runtime Presets

- **Strict 3-minute fail policy**: `timeoutMs=180000`, `maxRetries=0`
- **Strict 5-minute fail policy**: `timeoutMs=300000`, `maxRetries=0`
- **Retry-allowed policy**: `timeoutMs=120000`, `maxRetries=1~2`

## Validation

Local verification passed:

- `npm run build:ts`
- `npm test`

Coverage includes:

- `test_untrusted_metadata.ts`
- `test_anchor_sanitize.ts`
- `test_config_pipeline.ts` (Section 6c)
- `test_phase4_5.ts` source-smoke wiring checks

## Known Follow-up

- Canary/production observation for long-running OpenRouter jobs is still recommended to confirm a reduced mismatch rate between provider-side completion and local timeout failures.
