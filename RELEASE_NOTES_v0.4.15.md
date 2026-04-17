## v0.4.15 — Config Pipeline Regression Fixes + Automated Test

### Fixed (CRITICAL)
- **`openrouterConfig.maxTokens` transmission path restored**: Removing `narrativeMaxTokens` in v0.4.14 also destroyed the only code path that forwarded `openrouterConfig.maxTokens` to the OpenRouter API call. User settings like `openrouterConfig: { maxTokens: 4096 }` were completely ignored. Added `openrouterMaxTokens` flat field in `loadConfig()`, `types.ts`, and `index.ts` to restore the path.

### Changed
- **`openrouterConfig` nested type removed**: The `openrouterConfig` nested object in `EpisodicPluginConfig` was never returned by `loadConfig()` — all sub-fields were already destructured into flat fields. Removed the dead nested type from both `types.ts` and `index.ts` TypeBox schema to prevent future developers from incorrectly using `cfg.openrouterConfig?.maxTokens` (always `undefined`).
- **`segmentationWarmupCount` default documentation fixed**: `openclaw.plugin.json` described the default as `20`, but the runtime default was `10` (changed in v0.4.0 Phase 3). Updated to `Default: 10`.
- **`recallReInjectionCooldownTurns` dead `?? 10` fallback replaced**: The `?? 10` fallback in `index.ts` was unreachable (because `loadConfig()` provides `?? 24`), but would have incorrectly overridden `recallReInjectionCooldownTurns: 0` (the "disable guard" setting) to `10`. Replaced with `?? 24` to match the authoritative default.

### Added
- **Config pipeline automated test (`test_config_pipeline.ts`)**: 29 tests verifying that every `EpisodicPluginConfig` field appears in `loadConfig()` output, nested→flat field extraction works correctly, default values are consistent between code and `openclaw.plugin.json`, edge cases (0 values, clamping, undefined handling), and regression guards for previously missing fields (v0.4.13–v0.4.15).