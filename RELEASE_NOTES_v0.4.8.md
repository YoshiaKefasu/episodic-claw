# Release Notes — episodic-claw v0.4.8

**Date:** 2026-04-12
**Parent:** v0.4.7
**Scope:** Plugin-only (no OpenClaw core modifications)
**Type:** Hotfix

---

## Purpose

v0.4.8 is a metadata hotfix. The v0.4.7 release accidentally set OpenClaw build metadata to `2026.4.11`, which does not exist. This release corrects all version references to `2026.4.10`.

## What Changed

### Corrected Metadata in `package.json`
| Field | v0.4.7 (wrong) | v0.4.8 (correct) |
|-------|----------------|-------------------|
| `openclaw.compat.pluginApi` | `>=2026.3.28 <=2026.4.11` | `>=2026.3.28 <=2026.4.10` |
| `openclaw.build.openclawVersion` | `2026.4.11` | `2026.4.10` |
| `openclaw.build.pluginSdkVersion` | `2026.4.11` | `2026.4.10` |

### No Runtime Changes
- Zero code changes — this is a metadata-only correction.
- All runtime behavior, Go binaries, and plugin logic remain identical to v0.4.7.

## Constraints
- OpenClaw core source is NOT modified (plugin-only).
- Functionally identical to v0.4.7, but with correct ClawHub-compatible metadata.
