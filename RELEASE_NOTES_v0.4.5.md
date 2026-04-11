## What's New in v0.4.5

### OpenClaw Compatibility Bump

This release bumps episodic-claw compatibility to OpenClaw `2026.4.10`.

- `openclaw.compat.pluginApi`: `>=2026.3.28 <=2026.4.10`
- `openclaw.build.openclawVersion`: `2026.4.10`
- `openclaw.build.pluginSdkVersion`: `2026.4.10`

### Install Stability Notes

OpenClaw `2026.4.8` had a config-validation edge case around disabled `memory-lancedb` entries requiring an `embedding` config object.  
OpenClaw `2026.4.10` includes the upstream config/plugins fix, so this release recommends running on `2026.4.10+`.

### Docs Updated

- Added explicit troubleshooting steps for the `memory-lancedb` validation failure in:
  - `README.md`
  - `README.ja.md`
- Updated release checklist guidance in:
  - `docs/clawhub_publish_checklist.md`

---

**Full Changelog**: https://github.com/YoshiaKefasu/episodic-claw/blob/main/CHANGELOG.md
