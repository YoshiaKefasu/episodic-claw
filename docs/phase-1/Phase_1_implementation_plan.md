# Episodic Memory Plugin - Phase 1 Implementation Plan

## Overview
This implementation handles the Phase 1 goals of the Episodic Memory Plugin for OpenClaw. It establishes an efficient, fast file I/O layer utilizing a Go sidecar pattern (`episodic-core`) that communicates via JSON-RPC over `stdio` with a TypeScript plugin interface.

## User Review Required
No immediate user review is required unless the RPC protocol logic significantly deviates from standard expectations.

## Proposed Changes

### 1. Hybrid Architecture Structure
Create a new directory structure `d:\GitHub\OpenClaw Related Repos\episodic-claw`:
- [/package.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/package.json), [/tsconfig.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/tsconfig.json): TypeScript configurations.
- [/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/index.ts): The OpenClaw plugin entry point, which spawns the Go process.
- `/src/rpc-client.ts`: TypeScript wrapper to send/receive JSON-RPC messages to the Go sidecar.
- `/go/`: The Go module (`episodic-core`), separated for isolation.

### 2. Go Sidecar Component (`episodic-core`)
- **Modules**:
  - `main.go`: JSON-RPC server handling STDIN/STDOUT communication.
  - `watcher`: Wraps `fsnotify` to track `episodes/` nested directories and emits buffered events (1500ms debounce loop).
  - `frontmatter`: YAML frontmatter parser and serializer utilizing `gopkg.in/yaml.v3`.
  - `indexer`: Reads existing `episodes/**/*.md` to generate the initial context list.

### 3. JSON-RPC Protocol Spec
- TS -> Go: `{"jsonrpc": "2.0", "method": "watcher.start", "params": {"path": "..."}, "id": 1}`
- TS -> Go: `{"jsonrpc": "2.0", "method": "frontmatter.parse", "params": {"file": "..."}, "id": 2}`
- Go -> TS (Event): `{"jsonrpc": "2.0", "method": "watcher.onFileChange", "params": {"events": [...]}}`

## Verification Plan

### Automated Tests
- Spawn the Go sidecar manually using `go run .` and issue manual JSON inputs to STDIN to verify correct JSON-RPC outputs.
- Create dummy markdown files inside sub-directories like `episodes/2026/03/15/` to assert that `fsnotify` detects events properly.
- Verify debouncing logic ensures only one event per file per 1500ms is emitted regardless of rapid successive writes.
