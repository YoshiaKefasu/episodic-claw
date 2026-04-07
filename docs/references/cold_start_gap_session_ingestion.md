# Reference Report: Cold-Start Gap — Existing Session Ingestion

**Date:** 2026-04-07
**Severity:** HIGH (for agents with large existing context)
**Status:** Unresolved — requires new feature (simplified design confirmed)

---

## 1. Executive Summary

When episodic-claw is first installed on an agent that already has a large existing session transcript (e.g., 600k+ tokens in `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`), **the entire conversation history is invisible to the plugin's memory system.**

The plugin does not read `.jsonl` session transcripts at startup. It only processes Markdown episode files (`.md`) that already exist on disk. On a fresh install, no such files exist — so both the HNSW vector store and the Bleve lexical index start completely empty.

The only mechanism that converts existing session data into episodes is the `before_compaction` hook, which requires OpenClaw to trigger LLM compaction. For agents with 1M+ context windows, this may take hundreds of turns — meaning the agent operates with **zero episodic memory** for an extended period.

**Update (2026-04-07):** Based on the Lexical Index Rebuild Plan, the fix is significantly simpler than originally thought. The ingestion process only needs to create `.md` files; embedding and indexing are handled by existing mechanisms, resulting in **zero API cost** and **no immediate dependency on `GEMINI_API_KEY`**.

---

## 2. Architecture Overview

### 2.1 OpenClaw Session Storage

OpenClaw stores conversation history in **JSONL format**:

| File | Purpose |
|------|---------|
| `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` | Conversation transcript (one JSON object per line) |
| `~/.openclaw/agents/<agentId>/sessions/sessions.json` | Session registry (metadata, not messages) |

**JSONL format:**
```json
{"type":"session","version":2,"id":"<sessionId>","timestamp":"<ISO date>","cwd":"<dir>"}
{"type":"message","id":"<msg-id>","timestamp":"<ISO date>","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
{"type":"message","id":"<msg-id>","timestamp":"<ISO date>","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}
```

### 2.2 Episodic-Claw's Episode Storage

Episodic-claw stores memories as **Markdown files with YAML frontmatter**:

```
~/.openclaw/workspace/episodes/
├── 2026/
│   └── 04/
│       └── 07/
│           ├── react-component-design.md
│           └── database-schema-discussion.md
├── lexical/          (Bleve full-text index)
└── vector.db/        (PebbleDB + HNSW vector store)
```

---

## 3. The Cold-Start Gap

### 3.1 What Happens at `gateway_start`

```
gateway_start fires (src/index.ts L565-591)
  │
  ├─ Start Go sidecar (rpcClient.start)
  ├─ Resolve workspace path (~/.openclaw/workspace/episodes)
  ├─ ensureWatcher()
  │   ├─ Create workspace directory if missing
  │   └─ rpcClient.startWatcher(agentWs)
  │       └─ Go: handleWatcherStart (main.go L488-555)
  │           ├─ Quarantine legacy nested episode tree
  │           ├─ getStore() → NewStore()
  │           │   ├─ Open PebbleDB
  │           │   ├─ Create HNSW graph (M=32, efConstruction=200, dim=3072)
  │           │   ├─ Open/create Bleve lexical index (pure Go, no API key needed)
  │           │   ├─ Load HNSW index from Pebble
  │           │   ├─ CleanOrphans()
  │           │   └─ s.Count() == 0 → runAutoRebuild() goroutine
  │           │       ├─ Check GEMINI_API_KEY
  │           │       │   ├─ Empty → SKIP (main.go L112-115)
  │           │       │   └─ Set → Walk *.md files only (main.go L687)
  │           │       │       └─ No .md files exist → nothing to index
  │           │       └─ Start Async Healing Worker
  │           │           └─ Pass 1 (embedding) → needs API key
  │           └─ Start fsnotify watcher
  └─ No session file (.jsonl) is ever read
```

### 3.2 The Gap in Numbers

| Scenario | Existing Context | Time Until First Ingestion | Episodes Created |
|----------|-----------------|---------------------------|------------------|
| Fresh install, no prior chat | 0 | N/A | 0 (expected) |
| Fresh install, 100k context | 100k tokens | Until compaction fires (~50-100 turns) | ~10-20 episodes |
| Fresh install, 600k context | 600k tokens | Until compaction fires (~300-500 turns) | ~60-100 episodes |
| Fresh install, 1M context | 1M tokens | May never fire (agent may restart first) | 0 |

### 3.3 The Only Ingestion Path: `before_compaction`

The **only** code path that reads `.jsonl` and converts it to episodes:

```
before_compaction hook (src/index.ts L618-639)
  │
  └─ state.archiver.archiveUnprocessed({ sessionFile, agentWs, agentId })
      │
      ├─ Read .jsonl file line-by-line
      ├─ Detect watermark gap (all messages are "unprocessed" on first install)
      ├─ For gaps <= 50 messages:
      │   └─ Synchronous batchIngest() in chunks of 5
      └─ For gaps > 50 messages:
          ├─ Dump to legacy_backlog_*.json file
          └─ triggerBackgroundIndex() RPC
              └─ processBacklogFile() (background.go L268-409)
                  ├─ Read JSON backlog (array of {role, content})
                  ├─ Chunk into groups of 10
                  ├─ Embed each chunk via Gemini API
                  ├─ Compute Surprise scores
                  └─ Write Markdown episodes to YYYY/MM/DD/
```

**The problem:** `before_compaction` only fires when OpenClaw's LLM compaction runs. For agents with large context windows, this may take hundreds of turns — or never, if the agent restarts before the window fills.

---

## 4. GEMINI_API_KEY: Present vs. Absent

### 4.1 With `GEMINI_API_KEY`

| Component | State After Startup | Behavior |
|-----------|-------------------|----------|
| **PebbleDB** | Empty | No `.md` files to index |
| **HNSW Graph** | Empty | No vectors loaded |
| **Bleve Lexical** | Empty | No text indexed |
| **Auto-Rebuild** | Triggered but finds nothing | Only scans `*.md` files |
| **HealingWorker** | Running | Pass 1 succeeds if `.md` files appear |
| **Existing .jsonl** | **Completely ignored** | No code reads it |

### 4.2 Without `GEMINI_API_KEY`

| Component | State After Startup | Behavior |
|-----------|-------------------|----------|
| **PebbleDB** | Empty | Same as above |
| **HNSW Graph** | Empty | Same as above |
| **Bleve Lexical** | Empty | Same as above |
| **Auto-Rebuild** | **Skipped immediately** | `main.go:112-115` |
| **HealingWorker** | Running but Pass 1 fails | No embedding API available |
| **Existing .jsonl** | **Completely ignored** | Same as above |

### 4.3 Key Finding

**The gap exists in both scenarios.** The presence or absence of `GEMINI_API_KEY` only affects whether Auto-Rebuild *attempts* to index existing `.md` files. It does **not** affect whether existing `.jsonl` session data is read — because no code reads `.jsonl` at startup regardless.

---

## 5. Lexical Index: Never Skipped, Always Empty

The Bleve lexical index (full-text search) is **never skipped** during initialization:

**File:** `go/internal/vector/lexical.go`, lines 20-49

```go
func openLexicalIndex(dbDir string) (bleve.Index, error) {
    lexPath := filepath.Join(dbDir, "lexical")
    idx, err := bleve.Open(lexPath)
    if err == nil {
        return idx, nil  // Existing index opened
    }
    // Create new index (no API key needed)
    mapping := bleve.NewIndexMapping()
    // ...
}
```

**However**, the index is **always empty** on a fresh install because there are no `.md` episode files to index. The lexical index is populated only by:

1. `runAutoRebuild()` — indexes existing `.md` files (none exist on fresh install)
2. `ProcessMDFileIndex()` — indexes individual `.md` files as they are created
3. `processBacklogFile()` — creates `.md` files and adds them to the index

Without any of these triggering, the lexical index remains empty — meaning **even lexical-only fallback search returns zero results**.

---

## 6. HNSW Fallback Behavior

When the embedding API fails at query time:

**File:** `go/main.go`, lines 1881-1894

```go
emb = make([]float32, 3072) // Zero vector
recallFallbackReason = "embed_fallback_lexical_only"
```

**File:** `go/internal/vector/store.go`, lines 1178-1180

```go
// HNSW backfill is SKIPPED when embed_fallback_lexical_only is set
if len(candidates) < candidateK && !strings.Contains(fallbackReason, "embed_fallback_lexical_only") {
    // HNSW search...
}
```

**Result:** When embeddings are unavailable, the system falls back to lexical-only search. But since the lexical index is also empty on a fresh install, **the search returns zero results regardless**.

---

## 7. Impact Assessment

### 7.1 User Experience

| Turn | Agent Behavior | Episodic Memory |
|------|---------------|-----------------|
| 1-50 | Normal chat, no memory | Empty (expected) |
| 50-200 | Agent repeats itself, forgets earlier context | Still empty (compaction hasn't fired) |
| 200-500 | Agent has no knowledge of decisions made in turns 1-200 | Still empty |
| 500+ | Compaction finally fires → backlog processed | Finally populated |

### 7.2 Token Waste

During the cold-start period, the agent operates without episodic memory, potentially:
- Re-asking questions already answered
- Re-making decisions already made
- Re-explaining preferences already stated
- Generating redundant content that will later be compressed into the same episodes

### 7.3 Trust Degradation

Users who install episodic-claw expecting "instant memory" will be disappointed when the agent behaves like it has amnesia for the first hundreds of turns. This undermines trust in the plugin's core value proposition.

---

## 8. Proposed Solution: Cold-Start Ingestion (Simplified)

### 8.1 Design

Add a new code path that runs at `gateway_start` (or shortly after) to ingest existing session data. **Crucially, this process only creates `.md` files.** Embedding and indexing are delegated to existing mechanisms, resulting in **zero API cost** and **no dependency on `GEMINI_API_KEY`**.

```
gateway_start fires
  │
  └─ [NEW] coldStartIngest(agentWs, agentId)
      │
      ├─ Locate existing .jsonl session file
      │   └─ Via ctx.sessionFile or sessions.json registry
      ├─ Read and parse JSONL
      ├─ Chunk messages into groups of ~50
      ├─ For each chunk:
      │   └─ Write .md episode file (NO embedding needed)
      │       └─ Add to PebbleDB + sys_lexq queue
      └─ Let existing mechanisms handle the rest:
          ├─ runAutoRebuild() → embeds .md files (if API key set)
          ├─ lexicalWorker → indexes .md files into Bleve (always)
          └─ HealingWorker Pass 1 → embeds orphan .md files (later)
```

### 8.2 Key Considerations

| Consideration | Detail |
|--------------|--------|
| **File size** | 600k context ≈ 2-5MB JSONL. Chunking prevents OOM. |
| **API rate limits** | **None.** No embedding is performed during ingestion. |
| **No API key fallback** | **Always works.** `.md` files are created regardless of API key status. |
| **Idempotency** | Check if episodes already exist before re-ingesting. |
| **User notification** | Log: "Ingested N existing messages into M episodic memories." |

### 8.3 Estimated Effort

| Component | Effort |
|-----------|--------|
| Go: `coldStartIngest()` function | ~80 lines |
| Go: Integration with `handleWatcherStart` | ~20 lines |
| TypeScript: Session file path resolution | ~15 lines |
| Tests | ~50 lines |
| **Total** | **~165 lines, ~3-4 hours** |

---

## 9. Related Code References

| File | Lines | Function | Role |
|------|-------|----------|------|
| `src/index.ts` | 565-591 | `gateway_start` handler | Startup entry point |
| `src/index.ts` | 618-639 | `before_compaction` hook | Only existing .jsonl ingestion path |
| `src/archiver.ts` | 124-236 | `archiveUnprocessed()` | Reads .jsonl, creates episodes |
| `go/main.go` | 79-144 | `getStore()` | Store initialization, Auto-Rebuild trigger |
| `go/main.go` | 488-555 | `handleWatcherStart()` | Watcher startup, no session reading |
| `go/main.go` | 661-879 | `runAutoRebuild()` | Indexes existing .md files only |
| `go/main.go` | 1494-1806 | `RunAsyncHealingWorker()` | Healing, needs API key for Pass 1 |
| `go/internal/vector/background.go` | 268-409 | `processBacklogFile()` | Converts JSON backlog to .md episodes |
| `go/internal/vector/lexical.go` | 20-49 | `openLexicalIndex()` | Lexical index init (always succeeds, never skipped) |
| `go/internal/vector/store.go` | 1178-1180 | `RecallWithQuery()` | HNSW skip on embed fallback |

---

## 10. Conclusion

The cold-start gap is a **significant architectural blind spot** in episodic-claw. The plugin's core value proposition — "never forget" — is undermined when it cannot see the agent's existing conversation history at install time.

The fix is straightforward: add a `coldStartIngest()` code path that reads the existing `.jsonl` session transcript and converts it to Markdown episodes at startup. This would immediately populate both the HNSW vector store and the lexical index, giving the agent full episodic memory from turn one.

**Priority:** HIGH — This should be addressed before the next major release, as it directly impacts the user experience for any agent with existing conversation history.
