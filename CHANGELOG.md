# Changelog

## [0.1.1] — 2026-03-28

### Fixed
- Removed `dist/runner.js` dev artifact (contained hardcoded developer paths) from npm package via `"files"` negation
- Declared `GEMINI_API_KEY` as a required credential in `openclaw.plugin.json` to satisfy ClaWhub security scan
- Added `openclaw.compat.pluginApi: "1.0"` to `package.json` (required by ClaWhub validator)
- Fixed Mermaid `sequenceDiagram` parse errors in README files: participant aliases now use `participant X as Foo + Bar` syntax
- Switched license from MIT to MPL-2.0 (file-level copyleft — modifications to source files must stay open)
- Replaced bundled Go binaries with `postinstall.js` download from GitHub Releases, reducing npm package from ~24 MB → 44 KB

## [0.1.0] — 2026-03-28

First public release.

### Added
- Automatic episode segmentation via Bayesian surprise scoring
- Semantic recall via HNSW vector index (Go sidecar + Gemini Embedding API)
- Context injection: relevant episodes prepended to every system prompt
- Three memory tools: `ep-recall`, `ep-save`, `ep-expand`
- Context compaction: old turns archived to episodes, recent K turns kept
- Watermark-based gap detection to prevent missed context during compaction
- 429 guard: warns when Gemini quota causes silent episode drops
- Fire-and-forget ingest with 30s timeout to prevent Node.js hangs
- Dedup window to filter fallback-repeated messages
- Overlap-based chunk splitting for large buffer flushes
- Background indexer for massive context gaps (>50 messages)
- First-person humanized tool responses and system prompt hints
- Full plugin manifest (`openclaw.plugin.json`) with ClaWhub metadata
