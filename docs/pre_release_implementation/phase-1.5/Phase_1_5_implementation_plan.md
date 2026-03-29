# Episodic Memory Plugin - Phase 1.5 (Missing Elements) Implementation Plan

## Overview
Phase 1 successfully established the Go sidecar architecture (`episodic-core`) for robust file I/O and Socket RPC. However, the foundational TypeScript structures (Phase 1.5) were partially skipped. 

This plan addresses the missing TypeScript implementations required to run this as a true **OpenClaw Plugin**, specifically defining strict types, configuration handlers, and the core Plugin API hooks ([registerContextEngine](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/plugins/registry.ts#604-605)).

## Proposed Changes

### TypeScript Types & Configuration

#### [NEW] [src/types.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/src/types.ts)
Establish the core domain models shared between TS and Go:
- [EpisodeMetadata](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/frontmatter/frontmatter.go#12-19): Metadata stored in YAML frontmatter (ID, Title, Tags, SavedBy, RelatedTo edges).
- [Edge](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/frontmatter/frontmatter.go#20-24): Graph relationship representation (`temporal`, `semantic`, `causal`).
- [MarkdownDocument](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#20-24): Complete episode including metadata and body.
- `EpisodicPluginConfig`: Plugin configuration matching [openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json) (e.g., `sharedEpisodesDir`, `allowCrossAgentRecall`).

#### [NEW] `src/config.ts`
Implement configuration resolution:
- Default values for configuration options.
- A helper function to parse and merge the [openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json) configuration via `api.runtime.config.loadConfig()`.

### OpenClaw Plugin Registration

#### [MODIFY] [src/index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts)
Replace the current dummy [EpisodicMemoryPlugin](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/index.ts#3-20) class with the official OpenClaw Plugin API contract:
- Export a default function [register(api: OpenClawPluginApi)](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/index.ts#1284-1323).
- Use the API to extract `agentWorkspaceDir` correctly (supporting multi-agent independent workspaces as discussed in the architecture).
- Call `api.registerContextEngine("episodic-claw", ...)` with dummy/skeleton methods (`ingest`, `assemble`, [compact](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/src/compaction.ts#226-237)) to be fully implemented in Phase 2.
- Manage the [EpisodicCoreClient](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#34-195) lifecycle within the plugin's [on("start")](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/plugins/registry.ts#606-608) / [on("stop")](file:///d:/GitHub/OpenClaw%20Related%20Repos/openclaw-v2026.3.12/src/plugins/registry.ts#606-608) events.

## Verification Plan

### Automated Tests
- Running `npx tsc` to ensure total type safety across the new domain models and OpenClaw API imports.
- Running a dummy [test.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/test.ts) (or modifying the current one) to ensure the [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/index.ts) structure exports a compliant OpenClaw plugin without runtime crashes.

### Manual Verification
- Review the generated type interfaces to ensure they perfectly align with the JSON structures currently being parsed/returned by the Go sidecar.
