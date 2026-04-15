# Episodic-Claw v0.4.9 Release Notes

**Tag:** `v0.4.9`  
**Date:** 2026-04-14  
**Previous:** [v0.4.8](https://github.com/YoshiaKefasu/episodic-claw/releases/tag/v0.4.8)

---

## Overview

v0.4.9 is a comprehensive update that addresses four major areas of the episodic memory pipeline: **polyglot query support** (CJK morphological tokenization), **query latency optimization** (caching + deduplication), **narrative output sanitization** (tag pollution prevention), and **persistent cache storage** (rawText preservation for re-narrativization).

This release contains **no breaking changes** — existing configurations remain fully compatible.

---

## ✨ New Features

### 🌏 Polyglot Query Morphological Upgrade

#### Language Detection (Phase 1)
- **`eld` language detector** integrated — automatically detects `ja` (Japanese), `zh` (Chinese), `ko` (Korean), `en` (English), `id` (Indonesian)
- **Japanese morphological analysis** via `kuromojin` with POS filtering (nouns, verbs, adjectives, adverbs)
- Queries are now tokenized by the dominant script's morphology instead of raw regex matching

#### Chinese Tokenization (Phase 2)
- **`cjk-tokenizer` package** integrated for Chinese bigram extraction
- `minFrequency=1` for query use (single-occurrence words included)
- `maxPhraseLength=2` for optimal bigram retrieval
- Chinese characters are no longer indexed as one monolithic block

#### Korean Tokenization (Phase 2)
- **Hangul bigram sliding window** — 2-character sliding extraction for Korean text
- Example: `한국어텍스트` → `한국`, `국어`, `어텍`, `텍스`, `스트`
- Reduces the "regex blob" problem where Korean text was treated as a single token

#### Go BM25 CJK Analyzer (Phase 4)
- **Bleve `standard` → `cjk` analyzer** for lexical search
- Unicode script-based unigram tokenization for CJK scripts (Han, Hiragana, Katakana, Hangul)
- Latin scripts continue to use whitespace-based tokenization (no regression)
- Hybrid search (HNSW semantic + BM25 lexical) now works correctly for all CJK languages

### 🚀 Query Pipeline Latency Optimization

#### Phase 0: Debug Cleanup + Async
- **Removed debug TRACE logs** from `rpc-client.ts` (`request()`, `generateEpisodeSlug()`) — 3 `appendFileSync` blocks eliminated
- **`recallFeedback()` is now fire-and-forget** — changed from `await try-catch` to `.catch()` chain for non-blocking execution

#### Phase 1: TS-side Recall Cache + Duplicate Guard
- **TS-side recall result cache** (`_recallResultCacheMap` — `Map<string, RecallResultCache>` per agentWs, 60s TTL)
  - Prevents redundant Embedding API round-trips within a single conversation turn
  - Cache key: `agentWs` + `queryHash`
  - `invalidateTsRecallCache(workspace)` exported for workspace-level invalidation
- **Duplicate recall guard** (`lastRecallTurnMessageCount` in `AgentRuntimeState`)
  - `before_prompt_build` already runs recall for each turn
  - `assemble()` now skips recall if the same message count was already processed
  - Eliminates duplicate Embedding API calls per turn

#### Phase 2: Attachment Filter Integration
- **`classifyAndStripAttachment()`** — unified single-pass function
  - Combines `isAttachmentDominant` + `stripAttachmentNoise` into one function
  - Halves regex iterations per message
  - Old functions preserved with `@deprecated` JSDoc for backward compatibility

### 🧹 Narrative Output Sanitizer

#### LLM Output Tag Stripping
- **`sanitizeNarrativeOutput()`** function added — removes OpenClaw agent response format tags from OpenRouter LLM output before saving episodes
- Strips the following:
  - `<final>`, `</final>` wrapper tags
  - `<thinking>`, `</thinking>`, `<antthinking>`, `</antthinking>` reasoning tags (via `stripReasoningTagsFromText`)
  - `[[reply_to_current]]`, `[reply_to_current]` response format tags
  - `[analysis]`, `[/analysis]` section headers (line-start only)
  - `[output]`, `[/output]` bracket tags (line-start only)
- Whitespace normalization after tag removal

#### Narrative Quality Gate
- **`MIN_NARRATIVE_TOKENS = 10`** — outputs shorter than 10 tokens after sanitization trigger a retry
- Prevents greeting exchanges (`casual-greeting-exchange.md`) and trivial outputs from being saved as episodes
- Retries up to `MAX_RETRIES` (5) before falling back to `cacheRetry`

### 💾 Persistent Cache rawText

#### Ack No Longer Deletes
- **`Ack()` preserves rawText** — changed `deleteAfter=true` → `deleteAfter=false` in PebbleDB
- Items are marked `status: "done"` instead of being physically removed
- rawText is permanently available for re-narrativization and debugging

#### Requeue RPC
- **`cache.requeue`** endpoint — moves `done` items back to `queued` for re-narrativization
- Resets `Attempts`, `LeaseOwner`, `LeaseUntil`, `BackoffUntil`, `LastError`
- Only `StatusDone` items can be requeued (safe by design)
- `cacheRequeue()` TypeScript client method added

#### Stats Enhancement
- **`Stats()` returns 4 values** — `done` count added (queued, leased, done, deadLetter)
- Enables monitoring of accumulated done items

---

## 🔧 Changed

| Component | Before | After |
|---|---|---|
| `Ack()` | Physical delete from PebbleDB | `status: "done"` stamp, rawText preserved |
| `recallFeedback()` | Blocking `await try-catch` | Fire-and-forget `.catch()` chain |
| `narrativizeWithRetry()` | Raw LLM output saved directly | Sanitized + quality-gated output |
| Go BM25 analyzer | `standard` (unicode) | `cjk` (CJK-aware unigram) |
| `Stats()` | 3 return values | 4 return values (added `done`) |
| Attachment filter | 2-pass (dominance + strip) | 1-pass (`classifyAndStripAttachment`) |

---

## 🐛 Fixed

- Debug TRACE logs no longer written to `/root/.openclaw/ep-save-trace.log` (3 locations removed)
- OpenClaw agent response tags (`<final>`, `[[reply_to_current]]`, `[analysis]`) no longer pollute episode content
- Duplicate Embedding API calls per conversation turn eliminated (cache + guard)
- Chinese/Korean queries no longer indexed as single monolithic blobs
- `isAttachmentDominant()` and `stripAttachmentNoise()` marked `@deprecated` — use `classifyAndStripAttachment()` instead

---

## 📦 Assets

| File | Description |
|---|---|
| `episodic-claw-0.4.9.tgz` | npm package (postinstall downloads Go binaries from this release) |
| `episodic-core` | Linux binary (Go 1.25+, amd64) |
| `episodic-core.exe` | Windows binary (Go 1.25+, amd64) |

---

## ⚠️ Known Limitations

- **OpenClaw v2026.4.7+ CLI Pipeline**: The `cli-runner` execution path bypasses `before_prompt_build`, preventing episodic memory ingest for CLI providers (e.g., `google-gemini-cli`). This release is fully compatible with **OpenClaw v2026.4.5**. A fix for v2026.4.7+ requires OpenClaw core changes.
- **PebbleDB storage Growth**: Persistent rawText adds ~5-20MB/month. TTL-based auto-purge is planned for a future release.

---

## 📋 Full Changelog

See [CHANGELOG.md](https://github.com/YoshiaKefasu/episodic-claw/blob/main/CHANGELOG.md) for the complete history.
