# Episodic Memory Plugin - Phase 2 Implementation Plan

## Overview
Phase 2 focuses on connecting the OpenClaw Context Engine API to the Episode generation logic. We will implement the `EventSegmenter` in TypeScript, which manages conversation buffers and calculates "Surprise Scores" to determine when an episode should be finalized and written to disk as a Markdown file. We will also implement the [ingest()](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/legacy.ts#27-36) hook in [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/index.ts).

## Proposed Changes

### 1. The Core Segmenter
#### [NEW] `src/segmenter.ts`
Implement the `EventSegmenter` class:
- **Buffer Management:** Collect incoming messages.
- **Surprise Score (Lightweight):**
  - Sends text to the Go sidecar via RPC `Surprise` endpoint to compute true cosine-distance based surprise.
  - We use the **Gemini Embedding API (`gemini-embedding-2` or `text-embedding-004`)** as the default via Google AI Studio.
  - *Future-proofing:* Just like the Slug Generation, the Go sidecar will use an abstract `EmbeddingProvider` interface, allowing us to drop in an **OpenAI-compatible embedding provider** (e.g., local Ollama embeddings) in the future.

- **Slug Generation:**
  - Because OpenClaw does not expose LLM generation utilities to the [ingest](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/legacy.ts#27-36) Context Engine hook, the Go sidecar will also be responsible for making **Text Generation API** calls.
  - We will use **Gemma 3 27B** via the **Google AI Studio API** as the default.
  - *Architecture Note:* The Go sidecar will use an abstract `LLMProvider` interface, allowing us to easily plug in a local **Ollama** (OpenAI-compatible) text generation endpoint in the future.
  
- **Finalize Episode:**
  - Create the YAML frontmatter and Markdown body.
  - The TS segmenter calls `rpcClient.ingest(...)`, and the Go sidecar makes the API call for the slug, creates the path `episodes/YYYY/MM/DD/{slug}.md`, and writes the file.

### 2. Go Sidecar Enhancements
#### [MODIFY] `go/internal/server/server.go` (and related)
- Implement `episodic-core` RPC method [Ingest(ctx context.Context, req IngestReq)](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/types.ts#27-31):
  - Receives summary/body, slug, tags from TS.
  - Determines YYYY/MM/DD path.
  - Serializes to [.md](file:///d:/GitHub/OpenClaw%20Related%20Repos/memsearch/AGENT.md) with `yaml.v3`.
- Implement `episodic-core` RPC method `Surprise(ctx context.Context, req SurpriseReq)`:
  - Takes new text and previous text, uses Gemini API to calculate embedding distance.
  - *Note:* Gemini API integration (formerly Phase 3) is pulled into Phase 2 out of necessity.

### 3. Context Engine Hooks
#### [MODIFY] [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts)
- Update `api.registerContextEngine` -> [ingest(ctx)](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/legacy.ts#27-36):
  - Receive the new message.
  - Pass it to `segmenter.addToBuffer(message)`.
  - If `segmenter.shouldSegment()` returns true:
    - Generate Slug via LLM.
    - Call `rpcClient.ingest(...)` to save the episode via Go.
    - Clear the segmenter buffer.

## User Review Required
> [!NOTE]
> **OpenClaw API Limitations & Gemini Move to Phase 2**
> An investigation into the `openclaw-v2026.3.12` codebase revealed:
> 1. OpenClaw does not have a native embedding or lightweight Surprise Score utility.
> 2. OpenClaw does not expose a native `generateText` LLM hook inside the [registerContextEngine(ingest)](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/registry.ts#35-41) context, as `model` and `apiKey` are not passed down there.
> 
> **Resolution:** We are moving the Gemini API integration (for both Embedding and Text Generation) to the Go Sidecar in Phase 2. The TypeScript segmenter will rely on the Go Sidecar for all AI capabilities.

## Verification Plan
1. **Automated / Unit Tests:** Write a test script that streams dummy conversation messages into the Segmenter.
2. **End-to-End:** Verify that after a certain threshold/surprise, an `episodes/YYYY/MM/DD/dummy-slug.md` file is physically created by the Go sidecar.
