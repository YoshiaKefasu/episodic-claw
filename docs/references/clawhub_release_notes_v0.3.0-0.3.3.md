# ClawHub Release Notes — v0.3.0 through v0.3.3

---

## v0.3.0 — 2026-04-04

### Anchor Compaction Architecture

Compaction now preserves a heuristic Anchor and summary alongside the protected fresh tail, so agents retain a coherent session bridge after old turns are pruned. After compaction, the Anchor + summary are temporarily injected via `prependSystemContext` for a configurable `anchorInjectionAssembles` window, then expire automatically.

### Recall Diagnostics

`matchedBy`, `fallbackReason`, and score breakdown fields are now surfaced on `ScoredEpisode` through Go RPC, making retrieval decisions observable. When lexical-first retrieval returns fewer candidates than the requested top-K, the remaining slots are backfilled from HNSW semantic search.

### Summarization Escalation

Three-tier escalation (Normal → Aggressive → Deterministic Fallback) prevents memory loss when the embedding API returns 429 during `batchIngest`. Directory listings, large code blocks, and similar noisy payloads are replaced with `[Externalized: N chars...]` stubs before segmentation.

### Transcript Repair

Pre-compaction `tool_use`/`tool_result` pairing repair, ported from lossless-claw, fixes orphaned, missing, and duplicate tool result messages.

### Degraded HNSW Confidence Guard

Auto-inject is suppressed when retrieval quality is degraded (`embed_fallback_lexical_only` + low score), with `reason=degraded_low_confidence` logged. The `contextThreshold` config surface is exposed in `openclaw.plugin.json` with runtime wiring, clamped to `[0.70, 1.0]` with a default of 0.85.

### Fixes

- Fixed `tokenBudget === 0` false trigger: pressure checks now skip entirely when the host provides zero or undefined token budget.
- Fixed content-block-level `tool_use_id` detection in transcript repair.
- Fixed empty-result diagnostics gap: Go sidecar now logs fallback metadata even when recall returns zero episodes.

---

## v0.3.1 — 2026-04-05

### Compaction Delegated to OpenClaw Host

The plugin no longer owns the compaction lifecycle. `ownsCompaction: true` and `compact()` have been removed. OpenClaw's native LLM compaction now runs with full context for high-quality summarization. The Context Pressure Monitor has been removed from `assemble()` since compaction is fully managed by the host.

### Before/After Compaction Hooks

- **`before_compaction`**: Flushes the segmenter buffer and archives all unprocessed messages via `batchIngest` before OpenClaw's LLM compaction rewrites the session file.
- **`after_compaction`**: Reads `anchor.md` after LLM compaction, injects it into the next `assemble()`, then consumes (deletes) the file.

### New Modules

- **`src/anchor-store.ts`**: Manages the `anchor.md` lifecycle (write, read, consume) with non-fatal DB indexing.
- **`src/archiver.ts`**: New `EpisodicArchiver` class extracted from Compactor. Handles only `forceFlush` + `archiveUnprocessed`.

### Config Schema Cleanup

Removed `contextThreshold`, `anchorPrompt`, and `compactionPrompt` from the config schema. Extended peerDependencies compat to `>=2026.3.28 <=2026.4.2`.

---

## v0.3.2 — 2026-04-05

### File-Based Anchor Storage

Replaced the previous in-memory anchor storage with a file-based approach. The anchor is now written directly to `{agentWs}/anchor.md` and read from disk on demand, ensuring persistence across plugin reloads and reducing memory footprint.

### Deprecated Configuration Fields Removed

Cleaned up legacy configuration fields (`contextThreshold`, `anchorPrompt`, `compactionPrompt`, `freshTailCount`, `recentKeep`) from the plugin schema and runtime code. These were remnants of the old compaction architecture that was fully delegated to the OpenClaw host in v0.3.1.

### Episodic Memory Pollution Fix

Fixed toolResult pollution in the agent transcript that could cause generative stoppage. Cleaned up the memory ingestion pipeline to prevent stale or duplicate entries from contaminating the episodic memory store.

---

## v0.3.3 — 2026-04-05

### ep-anchor Tool Registration

The `ep-anchor` tool is now properly registered, enabling agents to proactively save session anchors that persist across context compaction. Anchors are stored via `AnchorStore.write()` with a 4000-character limit and automatic recall cache invalidation.

Agents can call `ep-anchor` with two parameters:
- `anchorText` (required): The current session state, progress, and immediate next steps.
- `summaryText` (optional): Broader context or background summary for longer-running sessions.

The tool is distinct from `ep-save`: `ep-anchor` is for session continuity (auto-injected after compaction), while `ep-save` is for long-term episodic memory (searchable via `ep-recall`).

### CLI Mode Duplicate Log Prevention

The `register()` method now uses `global`-scoped `Symbol.for()` flags (`episodic.cli.skipped` and `episodic.cli.registered`) to prevent duplicate log messages when the plugin system calls `register()` multiple times. This resolves the issue where `[Episodic Memory] CLI mode detected. Skipping...` and `[Episodic Memory] Registering plugin...` were printed repeatedly during CLI command execution.
