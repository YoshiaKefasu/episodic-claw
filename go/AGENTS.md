# AGENTS.md — Go Sidecar Core Layer

This directory is the processing core for Episodic-Claw.

## Role

- Treat Go as the kitchen: parsing, ranking, indexing, cache/vector/state operations, batch work, healing, consolidation, and deterministic quality checks.
- New feature logic should live here by default, with TypeScript kept as the OpenClaw adapter and RPC caller.
- Keep RPC contracts small and stable. Prefer adding a new focused RPC method over overloading a broad one.

## Performance and timeout rule

- New or modified interactive RPC methods must accept `context.Context` and respect cancellation.
- If a method is called from TypeScript with a latency budget, keep the Go handler's timeout at or below that budget.
- Japanese query parsing currently targets a 150ms ceiling from the TypeScript caller. If a richer implementation needs warm-up, warm it in the background and keep a lightweight fallback.
- Benchmark cold, warm, and intentionally throttled paths before making a heavy parser/ranker the default.

## Logging rule

- Logs are evidence, not a guarantee. They should make failures explainable, but correctness still comes from tests, contracts, context cancellation, and fallbacks.
- Keep hot-path logs quiet by default. Add debug gates or sampled summaries for noisy loops.
- Remove temporary TRACE/dump logs before shipping unless they are behind an explicit debug gate.
- Prefer structured, compact log fields: method, elapsedMs, timedOut, candidate count, fallback reason.
- Never log secrets, API keys, full prompts, full episode text, or raw large payloads.

## Error and fallback rule

- Return explicit fields for timeout/partial/fallback states when the caller needs to decide whether to adopt the result.
- Do not panic for user input or recoverable storage/parser errors.
- Keep lightweight deterministic fallbacks close to heavier implementations so the caller can fail closed instead of waiting.

## Tests

- Add Go unit tests for the core algorithm and edge cases before relying on TypeScript integration tests.
- Include empty input, mixed-script input, timeout/cancellation, low-signal output, and fallback behavior where relevant.
- For new parser/ranker work, include benchmark coverage for cold, warm, and throttled scenarios.
