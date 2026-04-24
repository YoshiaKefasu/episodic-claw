# Episodic-Claw v0.4.28

## Summary
- Added language-output guard foundation and enforcement pipeline in staged form (`v0.4.28a` to `v0.4.28c`), including `softwarn` observation defaults, content-floor gates, and controlled `reask/handoff` routing.
- Hardened CLI startup behavior (`v0.4.28d`) by extracting runtime-mode detection into a testable helper and suppressing CLI skip-log flood by default (debug-restorable via `EPISODIC_LOG_CLI_SKIP=1`).
- Expanded regression coverage for language guard behavior, runtime mode detection, and config-pipeline safety checks.

## Included Fix Tracks
- **v0.4.28a**: Language guard base (`narrativeExpectedLanguage`, `narrativeLanguageThreshold`, `narrativeLanguageOnFail`), `detectLanguageDetailed()` integration, `softwarn` default path.
- **v0.4.28b**: Content floor hardening (minimum sentence/content gates) with safe `contentGateEnabled` behavior to avoid item loss on last-resort paths.
- **v0.4.28c**: Language mismatch routing (`isLanguageGate`) with bounded reask (`LANGUAGE_REASK_MAX=1`) and explicit phase handoff behavior.
- **v0.4.28d**: Runtime-mode helper extraction and CLI skip-log flood mitigation in multi-process environments.

## Operational Notes
- `node` daemon classification and `OPENCLAW_SERVICE_KIND` priority remain intentionally deferred to a follow-up PR, gated on lazy-init safety work.
- For CLI-mode debugging, set `EPISODIC_LOG_CLI_SKIP=1` to restore explicit skip logs.

## Validation
- `npm run build:ts` ✅
- `npm test` ✅
  - Includes `test_runtime_mode_detection.ts` (17 assertions)
  - Includes `test_narrative_quality_gate.ts` (39/39)
  - Includes `test_config_pipeline.ts` (57/57)

## Release Assets
- `episodic-claw-0.4.28.tgz`
- `episodic-core` (Linux ELF)
- `episodic-core.exe` (Windows PE)
