# Release Notes — episodic-claw v0.4.6

**Date:** 2026-04-11
**Parent:** v0.4.5
**Scope:** Plugin-only (no OpenClaw core modifications)

---

## Purpose

v0.4.6 closes the gap between the design plan (Option A: Plugin-only, Tool-first) and the actual runtime behavior. It ensures that CLI and Embedded paths both achieve reliable "1-turn recall" without duplicate injection, cross-agent state leakage, or unnecessary RPC calls.

## What Changed

### 1. CLI Filter Enforcement in `ep-recall` Execute Path
- **Before:** The tool-first gate (`evaluate()`) only ran in `before_prompt_build` and `assemble` hooks. CLI providers that skip those hooks could call `ep-recall` unconditionally, causing unnecessary RPC calls and no deterministic filtering.
- **After:** The `ep-recall` tool execute path now runs `tfGate.evaluateForQuery()` before making any RPC call. Full 4-stage filter order: **novelty -> intent -> fingerprint dedup -> negative cache backoff**. If any filter says skip, a short no-op text response is returned and **no RPC recall is made**.
- **Query source:** Uses `instantDeterministicRewrite` with recent user messages (`recallQueryRecentMessageCount`) when message context is available. Falls back to `params.query` only when messages are unavailable. Never uses "latest raw user message only" as the primary path.

### 2. Per-Agent Gate State Isolation
- **Before:** `tfGate` was singleton-wide — fingerprint cache, negative cache, and turn counter were shared across all agents. One agent's no-hit could suppress another agent's recall.
- **After:** Gate state is now scoped by `agentId`. Each agent has its own fingerprint window, negative cache, and turn counter. `recordNoHit` / `recordHit` / `evaluate` all require an `agentId` parameter.

### 3. Hook No-Op Without State Mutation
- **Before:** `before_prompt_build` and `assemble` called `tfGate.evaluate()` when tool-first was enabled, which mutated turn counters and fingerprint state — causing turn drift and noise even though the hooks returned no-op.
- **After:** Both hooks return no-op immediately when `toolFirstRecall.enabled=true` without calling `tfGate.evaluate()`. Gate state is only mutated by the `ep-recall` tool execute path.

### 4. New `evaluateForQuery()` Method
- Lightweight filter check that accepts a pre-built query string.
- Runs the full 4-stage pipeline: novelty -> intent -> fingerprint dedup -> negative cache backoff.
- Used in the `ep-recall` execute path for deterministic filter enforcement with the same gate order as `evaluate()`.

## Constraints (Unchanged from Plan)
- OpenClaw core source is NOT modified (reference only).
- Changes are plugin-only.
- `toolFirstRecall.enabled=false` restores v0.4.5 behavior (fallback compatibility).

## Bug Fixes
- Gate state no longer leaks across agents/sessions.
- `before_prompt_build` and `assemble` no longer cause turn drift when tool-first is enabled.
- CLI path now has deterministic filter enforcement — no more unconditional `ep-recall` RPC calls.

## Test Coverage Added
- `evaluateForQuery` skip on fingerprint dup (no RPC call)
- `evaluateForQuery` skip on negative cache backoff
- No-hit backoff 3/6/12 sequence in execute path
- Per-agent isolation (Agent A no-hit does not suppress Agent B)
- Per-agent turn counter independence
- Per-agent reset
- `toolFirstRecall.enabled=false` fallback compatibility

## Known Risks
- If CLI models ignore the tool usage guidance and call `ep-recall` unconditionally, the full 4-stage filter will suppress low-signal calls at novelty/intent stages, and duplicate/noisy calls at fingerprint/negative cache stages. Overhead remains minimal (sub-ms filter evaluation).
