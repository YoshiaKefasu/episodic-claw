## v0.4.20 — Lexical Empty-ID Guard + Watcher/Rebuild Timeout Fix

### Critical Fix: Lexical Index Empty-ID Crash Prevention

Bleve rejects document ID `""`, causing a 3-error chain (`bleve batch error` → `batch commit error` → `batchKeys out-of-sync`) that corrupted the lexical queue and silently dropped all subsequent index updates. All entry points now guard against empty IDs:

- **`enqueueSysLexq()`**: Skips empty `recordID` with Warn log (prevents Bleve batch corruption at the source)
- **`Add()` / `BatchAdd()`**: Rejects records with empty ID with explicit error return (prevents empty-ID records from entering the store)
- **`RebuildLexicalIndex()`**: Skips records with empty ID with Warn log (prevents rebuild-time Bleve errors)
- **`lexicalWorker`**: Skips tasks with empty `document ID` (consumes queue keys + continues, preventing orphaned queue entries)

### Fix: Delete/CleanOrphans Empty-ID Guard

`Delete("")` and `deleteLocked("")` would construct invalid PebbleDB keys (prefix-only keys like `"ep:"`, `"s2i:"`) and execute `batch.Delete()` on them. Both functions now return `nil` immediately for empty ID. `CleanOrphans()` now skips records with empty/whitespace-only ID before they reach the delete list.

### Fix: Watcher Start Timeout (5s → 15s) + 1 Retry

The Go sidecar's `handleWatcherStart` runs as a goroutine that may not complete within the old 5s timeout, causing every `gateway_start` to time out and fall back to synchronous `rebuildIndex`. Increased to 15s with 1 retry attempt.

### Fix: Rebuild Fallback Non-Blocking (Async Fire-and-Forget)

When watcher start fails after all retries, the `rebuildIndex` fallback now runs in a `void (async () => { ... })()` IIFE instead of `await`, so `gateway_start` is not blocked on rebuild completion. This eliminates the 20–60s gateway startup delay observed in production logs.

### Fix: Degraded Workspace Early-Return (Regression Fix)

The async fallback created a regression where `before_prompt_build` would re-enter `ensureWatcher()` for degraded workspaces on every turn, spawning infinite async rebuild RPCs. Added early return for already-degraded workspaces to prevent the infinite-rebuild loop.

### Changed

- `Delete()` empty-ID guard uses `id == ""` (API-sourced IDs are already trimmed by callers)
- `CleanOrphans()` empty-ID guard uses `strings.TrimSpace(rec.ID) == ""` (DB-sourced data may contain whitespace-padded IDs)
- Watcher start constants extracted to named `WATCHER_START_TIMEOUT_MS` (15,000) and `WATCHER_START_MAX_RETRIES` (1)

**Full Changelog**: https://github.com/YoshiaKefasu/episodic-claw/compare/v0.4.19...v0.4.20
