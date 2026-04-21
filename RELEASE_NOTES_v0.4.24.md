# Episodic-Claw v0.4.24

Release date: 2026-04-21

## Summary

This release combines two production-focused fixes:

1. **v0.4.24**: Recall query rewrite is now message-aware, so latest user intent is preserved in keyword construction.
2. **v0.4.24a**: Idle-timeout narrativization blackhole is fixed by explicitly flushing passive pool state at boundaries.

## Highlights

### 1) Message-aware recall query rewrite (latest keyword guarantee)

- Replaced joined-text extraction with **per-message keyword extraction**.
- Added newest-first slot assembly with reservation:
  - `LATEST_RESERVE = 4`
  - `MAX_TOTAL = 12`
- Added deterministic fallback when no keywords are extracted.

Result: latest short user messages no longer disappear from the final recall query when older messages are longer.

### 2) Idle-timeout narrativization blackhole fix

- `poolAndQueue()` now does explicit boundary flush:
  - `pool.add(...)`
  - `pool.forceFlush(...)`
- Removed hidden dependency on `NarrativePool.add()` return value in passive-pool mode.
- Added reason normalization and type alignment (`time-gap` included in queue reason union).

Result: idle/time-gap/surprise/size-limit boundaries reliably enqueue narrative chunks again.

### 3) forceFlush pool-only drain hardening

- `forceFlush()` now drains retained pool data even if segmenter buffer is empty.
- WAL rotate is skipped safely when there are no buffered messages.

Result: retry windows after enqueue failures are safer; pool-retained data is no longer blocked by empty buffer state.

## Validation

- TypeScript: `npx tsc --noEmit` ✅
- Go sidecar build: `go build ./...` ✅
- Test suite: `npm test` ✅ (40 passed, 0 failed)

## Upgrade Notes

- Plugin/package version is now `0.4.24`.
- No user-facing config migration required for this release.
