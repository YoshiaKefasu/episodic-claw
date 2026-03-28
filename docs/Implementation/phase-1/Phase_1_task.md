# Episodic Memory Plugin (Phase 1)

## 1. Project Initialization
- [x] 1.1 Create project directory `d:\GitHub\OpenClaw Related Repos\episodic-claw`.
- [x] 1.2 Initialize TypeScript plugin structure ([package.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/package.json), [tsconfig.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/tsconfig.json), [index.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/lossless-claw/index.ts)).
- [x] 1.3 Initialize Go module (`go mod init episodic-core`) in [go/](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/go/main.go) subfolder.

## 2. Go Core Implementation (Markdown I/O & Watcher)
- [x] 2.1 Implement `frontmatter` parsing and serializing (using `gopkg.in/yaml.v3`).
- [x] 2.2 Implement `watcher` using `fsnotify` for the `episodes/` directory tree.
- [x] 2.3 Implement file debouncing (1500ms) for watcher events.
- [x] 2.4 Implement basic [rebuild](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts#142-145) logic to traverse `episodes/**/*.md` and extract metadata.

## 3. Go JSON-RPC Server
- [x] 3.1 Setup JSON-RPC server listening on stdout/stdin or localhost TCP.
- [x] 3.2 Define basic RPC methods and event broadcasting.

## 4. TypeScript RPC Client & Plugin Integration
- [x] 4.1 Implement [rpc-client.ts](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/src/rpc-client.ts) to communicate with the Go sidecar.
- [x] 4.2 Register OpenClaw plugin configuration ([openclaw.plugin.json](file:///d:/GitHub/OpenClaw%20Related%20Repos/episodic-claw/openclaw.plugin.json)).
- [x] 4.3 Start/Stop Go sidecar process from TypeScript plugin lifecycle.

## 5. Testing
- [x] 5.1 Test file creation and ensure Go watcher notifies TS correctly.
