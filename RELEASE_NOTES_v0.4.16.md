# Episodic-Claw v0.4.16

## Critical Bug Fixes

### 🔴 Segmentation Lambda Fixed — Boundary Detection Now Uses Configured Threshold

The segmentation lambda parameter was **always passing 1.5** to the Go sidecar instead of the configured `segmentationLambda` (default 2.0). A Welford online statistics implementation (`segCount`, `segMean`, `segM2`) had zero callers, leaving `segCount` permanently at 0. This caused `getEffectiveLambda()` to always return `min(1.5, configuredLambda)` — effectively lowering the surprise threshold from `mean + 2.0×std` to `mean + 1.5×std`, resulting in **over-segmentation** (too many tiny episodes).

**Fix**: Removed all dead Welford code (3 fields + 4 methods) and changed the RPC call from `this.getEffectiveLambda()` to `this.segmentationLambda`. The Go sidecar already handles warmup logic correctly (ignoring lambda during warmup and using a fixed fallback threshold).

### 🟡 Cooldown Negative-Delta Guard — Post-Restart Boundary Suppression Fixed

After a TypeScript process restart, `turnSeq` resets to 0 while Go persists `LastBoundaryTurn` in Pebble DB. This produced negative deltas (`Turn - LastBoundaryTurn < 0`) that incorrectly triggered cooldown suppression, **blocking all boundary detection** until the turn counter caught up to the persisted value.

**Fix**: The cooldown logic now explicitly checks `delta >= 0 && delta <= cooldown` via the extracted `ShouldCooldownSuppress()` pure function in `segstate.go`. The function serves as the single source of truth for cooldown logic, shared by both production code and regression tests.

### 🟢 Get/Put SegmentationState Errors Now Logged

Pebble I/O errors (disk full, permission denied) from `GetSegmentationState` and `PutSegmentationState` were silently ignored. While the zero-value fallback (warmup mode) is safe, failures were completely unobservable for operations.

**Fix**: Errors are now logged at WARN level via `logger.Warn(logger.CatStore, ...)`. The self-healing behavior (EWMA recovers naturally) is preserved; the logs simply make failures visible.

## Other Changes

- **Unused function parameters removed**: `scanLatestNarrativeEpisode(agentWs, agentID)` → `scanLatestNarrativeEpisode(agentWs)` and `checkSleepThreshold(agentWs, vstore, apiKey)` → `checkSleepThreshold(agentWs, vstore)`.
- **Version check in test suite made dynamic**: No more `npm test` breakage on every version bump.

## New Test Coverage

- **11 cooldown delta regression tests** (`cooldown_delta_test.go`): Negative delta (restart), zero delta (same-turn re-detection), positive within/beyond cooldown, large negative, zero turn, zero LastBoundaryTurn, disabled cooldown, exact boundary, and pre-v0.4.16b behavior verification.

---

**Full Changelog**: https://github.com/YoshiaKefasu/episodic-claw/compare/v0.4.15...v0.4.16
