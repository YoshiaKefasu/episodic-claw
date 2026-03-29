# Episodic Memory Plugin (Phase 1 & 1.5)

## 1. Project Initialization
- [x] 1.1 Create project directory `d:\GitHub\OpenClaw Related Repos\episodic-claw`.
- [x] 1.2 Initialize TypeScript plugin structure ([package.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/package.json), [tsconfig.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/tsconfig.json), [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/index.ts)).
- [x] 1.3 Initialize Go module (`go mod init episodic-core`) in [go/](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) subfolder.

## 2. Go Core Implementation (Markdown I/O & Watcher)
- [x] 2.1 Implement `frontmatter` parsing and serializing (using `gopkg.in/yaml.v3`).
- [x] 2.2 Implement `watcher` using `fsnotify` for the `episodes/` directory tree.
- [x] 2.3 Implement file debouncing (1500ms) for watcher events.
- [x] 2.4 Implement basic [rebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#175-178) logic to traverse `episodes/**/*.md` and extract metadata.

## 3. Go JSON-RPC Server
- [x] 3.1 Setup JSON-RPC server listening on stdout/stdin or localhost TCP.
- [x] 3.2 Define basic RPC methods and event broadcasting.

## 4. TypeScript RPC Client & Plugin Integration
- [x] 4.1 Implement [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) to communicate with the Go sidecar.
- [x] 4.2 Register OpenClaw plugin configuration ([openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json)).
- [x] 4.3 Start/Stop Go sidecar process from TypeScript plugin lifecycle.

## 5. Testing
- [x] 5.1 Test file creation and ensure Go watcher notifies TS correctly.

## 6. Phase 1.5 (Recovered TS Fundamentals)
- [x] 6.1 Implement [src/types.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/src/types.ts) (EpisodeMetadata, Edge, EpisodicPluginConfig).
- [x] 6.2 Implement [src/config.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/config.ts) (Config parsing and defaults).
- [x] 6.3 Refactor [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) to export default function [register(api: OpenClawPluginApi)](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/index.ts#1284-1323).
- [x] 6.4 Set up OpenClaw Plugin lifecycle hooks (`api.on("start")`, `api.registerContextEngine`).
- [x] 6.5 Update [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) exports to use centralized [types.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/src/types.ts).

## 7. Phase 2 (Segmenter + AI Integration in Go Sidecar)
- [x] 7.1 Go: Define abstract [EmbeddingProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#6-9) and [LLMProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#11-14) interfaces to support future OpenAI-compatible/Ollama injection.
- [x] 7.2 Go: Implement Google AI Studio provider for both `gemini-embedding-2-preview` and `gemma-3-27b-it` as the Stage 1 default.
- [x] 7.3 Go: Implement [Surprise](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#195-228) endpoint using the [EmbeddingProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#6-9).
- [x] 7.4 Go: Implement [Ingest](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go#229-295) endpoint to generate Slug via the [LLMProvider](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/internal/ai/provider.go#11-14) and write Markdown files.
- [x] 7.5 TS: Implement [src/segmenter.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/segmenter.ts) (Buffer management, Surprise RPC calls).
- [x] 7.6 TS: Update [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts) to implement [ingest(ctx)](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/context-engine/legacy.ts#27-36) logic within `api.registerContextEngine` and call Phase 2 RPCs.
- [x] 7.7 Test: Feed dummy conversations and verify that an episode file is automatically created and named correctly by Gemma 3.
- [x] 7.8 Test: Verify end-to-end pipeline with a real Gemini API key ensuring `gemini-embedding-2-preview` distance calculation and `gemma-3-27b-it` slug generation work correctly.
