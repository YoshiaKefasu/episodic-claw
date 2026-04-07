---
name: episodic-claw
description: Local episodic memory engine with Go sidecar for Gemini embeddings
homepage: https://github.com/YoshiaKefasu/episodic-claw
metadata: |
  {
    "clawdbot": {
      "requires": {
        "bins": ["go"],
        "env": ["GEMINI_API_KEY"]
      },
      "primaryEnv": "GEMINI_API_KEY",
      "type": "runtime"
    }
  }
---
# episodic-claw

Local episodic memory engine for OpenClaw.

## Architecture
- **TypeScript**: Plugin interface, OpenClaw hooks, tool definitions.
- **Go Sidecar**: High-performance embedding (Gemini API), vector search (HNSW), lexical search (Bleve), and Pebble DB storage.

## Installation
This package includes a `postinstall` script that downloads the prebuilt Go sidecar binary from GitHub Releases.
- To skip the download, set `EPISODIC_SKIP_POSTINSTALL=1`.
- The binary is required for embedding and search functionality.

## Credentials
- **`GEMINI_API_KEY`**: Required for generating embeddings via Google's Gemini API. The Go sidecar reads this from the environment.

## Behavior
- **Memory Injection**: Automatically retrieves relevant past episodes and prepends them to the system prompt before each AI response.
- **File Operations**: Reads/writes episode files under `~/.openclaw/workspace/episodes/`.
- **Anchor Management**: Creates and consumes `anchor.md` to preserve context across compaction cycles.
