# Episodic-Claw v0.4.19

This release consolidates the v0.4.19a–v0.4.19d work into a single stable package version.

## Highlights

### OpenRouter response resilience
- Typed error classification for wrapped OpenRouter failures
- Explicit handling for `200 + error` responses
- Clear separation of `missing_choices`, `empty_content`, `non_string_content`, `provider_503`, `provider_429`, and `provider_400_policy`

### Narrative generation hardening
- 12 retry attempts with a 3-second base delay and a 600-second cap
- Custom-model fallback to `openrouter/free`
- Per-model circuit breaker isolation
- Duplicate-save suppression by rawText hash

### Test and release hygiene
- Added dedicated OpenRouter client tests
- Fixed the `test_phase4_5.ts` fixture to match the `CacheQueueItem.rawText` contract
- Kept the published package version at `0.4.19`

## Upgrade Notes

No manual migration is required. This release is backward-compatible and focuses on resilience, observability, and release-test stability.
