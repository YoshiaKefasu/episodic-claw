# Release Notes — episodic-claw v0.4.7

**Date:** 2026-04-12
**Parent:** v0.4.6
**Scope:** Plugin-only (no OpenClaw core modifications)

---

## Purpose

v0.4.7 introduces a **Runtime Bridge Mode** master switch and a **Universal CLI Hook Bridge** path, enabling episodic memory to work reliably across all execution environments without requiring OpenClaw core modifications. It also adds **dynamic time-gap-based segmentation** for more natural episode boundaries.

## What Changed

### 1. Runtime Bridge Mode (Master Switch)
- **New config:** `runtimeBridgeMode` — controls how episodic memory ingests and recalls data.
  - `'auto'` (default): Automatically chooses the optimal path based on execution environment. Falls back to `cli_universal` if undetectable.
  - `'cli_universal'`: Forces the universal bridge path (`before_dispatch`/`message_sent` hooks) and tool-first recall ON.
  - `'legacy_embedded'`: Forces the legacy embedded path (`before_prompt_build`/`assemble`) for rollback compatibility.
- **Detection logic:** `src/index.ts` now detects execution context at `wake()` time and selects the appropriate ingestion/recall strategy.
- **Why:** Some OpenClaw setups don't support the legacy embedded hooks. The universal CLI hook path works everywhere.

### 2. Universal Prompt Hook Bridge
- **New ingestion path:** Listens to `before_dispatch` and `message_sent` CLI hooks to capture conversation turns without relying on `before_prompt_build`/`assemble`.
- **Segmenter integration:** The new `src/segmenter.ts` receives message streams from the universal bridge and applies dynamic segmentation (surprise score + time-gap thresholds).
- **Runtime fallback:** If the universal bridge cannot detect hooks, it falls back to CLI `ep-ingest` tool calls.

### 3. Dynamic Segmentation with Time-Gap Threshold
- **New config:** `segmentationTimeGapMinutes` (default: 15) — time gap between user messages that triggers an automatic segment boundary.
- **Combined logic:** Segmenter now fires on surprise score boundaries OR time-gap boundaries, whichever comes first. This prevents long pauses from merging unrelated conversations into one blob.
- **`src/segmenter.ts` rewritten:** Full rewrite with cleaner boundary detection, buffer management, and max-char flush guard (`maxBufferChars`).

### 4. Tool-First Recall v0.4.6 Updates
- `toolFirstRecall` config descriptions updated to reflect `runtimeBridgeMode` interaction.
- When `runtimeBridgeMode=cli_universal`, tool-first recall is forced ON regardless of `toolFirstRecall.enabled` setting.

## New Config Fields
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `runtimeBridgeMode` | `"auto" \| "legacy_embedded" \| "cli_universal"` | `"auto"` | Master switch for ingestion/recall path |
| `segmentationTimeGapMinutes` | `number` | `15` | Time gap (minutes) triggering automatic segment boundary |

## Constraints
- OpenClaw core source is NOT modified (plugin-only).
- `runtimeBridgeMode=legacy_embedded` restores v0.4.6 behavior (rollback compatibility).
- `toolFirstRecall.enabled=false` is respected only when `runtimeBridgeMode=legacy_embedded`.

## Bug Fixes
- Universal bridge detects execution context at runtime — no more silent failures on unsupported OpenClaw setups.
- Time-gap segmentation prevents long idle periods from merging unrelated conversations.

## Known Risks
- `runtimeBridgeMode=cli_universal` forces tool-first recall ON. If the CLI model doesn't support tool calls, memory ingestion still works via fallback `ep-ingest` tool calls, but recall may be delayed.
- `segmentationTimeGapMinutes` too short may cause excessive fragmentation. Default 15 min is conservative.
