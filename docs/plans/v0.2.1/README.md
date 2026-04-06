# Episodic-Claw v0.2.1 ("The Vault" Architecture)

This folder contains the master engineering plans, architectural documents, and resilience audits that formed the foundation of the `v0.2.1` release of the Episodic-Claw memory engine.

## The Core Objective
The v0.2.1 release represents a massive paradigm shift from a "prototype memory system" to a **Production-Grade, Enterprise-Resilient Vault**. It focused on ensuring 100% data consistency, solving severe File I/O bottlenecks on Windows/WSL, and enabling long-context integration with advanced Lexical + Semantic dual-engine querying.

## Document Index

- **`v0.2.1_master_plan.md`**: The central roadmap. Outlines the 7-phase transition and tracks system scaling, rate-limit resilience, and API lifecycle rules.
- **`scalable_architecture_plan.md`**: Deep dive into the architectural flaws of v0.2.0 (The "Three Pillars of Death") and the resilient fixes (Circuit Breakers, Self-Healing Queues, Blocking API resolutions).
- **`fs_watcher_sync_plan.md`**: Solving the Node.js chokidar vs. Go OS-threading race conditions. Ensuring safe, atomic file reads across OS boundaries.
- **`phase5_lexical_engine_plan.md`**: Introduction of `bleve`. Expanding from pure semantic (HNSW) search to a hybrid Lexical (N-gram) + Semantic Engine. Resolves vector hallucination on proper nouns/dates.
- **`phase6_batch_ingestion_plan.md`**: The introduction of the brutal Write-Ahead-Log (WAL) via `pebble.Batch`. Destroying memory channel panics and preventing data loss during abrupt IDE closures or system crashes.
- **`wsl_e2e_integration_test_plan.md`**: Hardcore stress-testing protocols for Windows/WSL I/O performance and atomic disk commits.
- **`hippocampus_replay_importance_note.md`**: Research and notes on cognitive scoring (Surprise, Emotion, Usefulness) that decides what memories are prioritized during consolidation.

## Result

The result of this documentation phase is the release of `v0.2.1`: A system with 64,000-token dynamic injection limits, zero ghost writes, and a completely crash-resilient Go sidecar.
