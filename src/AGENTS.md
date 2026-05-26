# AGENTS.md — TypeScript Adapter Layer

This directory is the OpenClaw-facing adapter layer.

## Role

- Treat TypeScript as the reception desk: plugin lifecycle, config/schema handling, OpenClaw API wiring, RPC calls, feature flags, and emergency fallbacks.
- Do not add new heavy processing here when it can live in the Go sidecar.
- Existing stable TypeScript behavior may stay. Do not migrate working code just for symmetry.

## New feature rule

- New parsing, ranking, indexing, cache/vector/state, healing, consolidation, or deterministic quality logic should be implemented in `../go` first.
- TypeScript should expose a small wrapper that calls the Go RPC method and validates the returned shape.
- Keep a kill switch and a safe fallback for new Go paths when user-facing behavior could be affected.

## Logging rule

- Logs are evidence, not a regression shield. They help explain what happened after the fact; they do not replace tests, RPC contracts, feature flags, or fallback behavior.
- Runtime logs must be gated by an env flag via `getEnvVal()` from `src/env-var.ts`. Do not read `process.env` directly.
- For new or modified production paths, avoid unconditional `console.log`. Prefer existing debug gates and keep log payloads small.
- Never log secrets, API keys, full prompts, full episode text, or large base64/image payloads.
- For cross-language features, log the decision point: Go used, fallback used, timeout, kill switch, keyword count, elapsed time. Keep it structured JSON when practical.

## RPC boundary

- Prefer narrow RPC methods with explicit request/response types in `src/types.ts`.
- Apply a TS-side timeout when the call affects interactive latency.
- Validate adoption conditions in TS before changing visible behavior. Example: timeout flag, elapsed time, keyword count, output length.

## Tests

- Add fallback tests for timeout, Go error, low-signal result, and kill switch when adding a Go-backed path.
- Keep tests deterministic. Mock or wrap RPC behavior instead of requiring external network services.
- Run the relevant targeted test first, then the full suite when behavior changes.
