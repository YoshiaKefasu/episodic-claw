## What's New in v0.4.4

### OpenRouter Reasoning Control

This release introduces fine-grained control over OpenRouter reasoning/thinking mode during narrative episode generation.

**New `openrouterConfig.reasoning` schema:**
- `enabled` (boolean, default: `true`) — Enable or disable reasoning/thinking mode entirely
- `effort` (string, default: `"high"`) — Reasoning effort level: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
- `maxTokens` (integer, optional) — Cap reasoning tokens; takes precedence over `effort` when set
- `exclude` (boolean, default: `false`) — When `true`, requests the model to exclude reasoning output from the response

**Key behaviors:**
- `enabled: false` removes the `reasoning` field from the request body entirely
- `maxTokens` overrides `effort` when both are specified
- Invalid values for `maxTokens` (non-integer, zero, negative) are silently dropped

### Updated Dependencies
- Compatibility plugin API range updated to `>=2026.3.28 <=2026.4.8`
- `openclawVersion` and `pluginSdkVersion` aligned to `2026.4.8`

### Tests
- Added comprehensive reasoning enablement tests covering all configuration permutations
- All existing release gates continue to pass

---

**Full Changelog**: https://github.com/YoshiaKefasu/episodic-claw/blob/main/CHANGELOG.md
