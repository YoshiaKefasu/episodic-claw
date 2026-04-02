package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"episodic-core/internal/vector"
	"episodic-core/watcher"
)

func TestLegacyNestedEpisodeTreeMigrationStartupE2E(t *testing.T) {
	oldDisable := false
	if disableWorkers != nil {
		oldDisable = *disableWorkers
		*disableWorkers = true
		defer func() { *disableWorkers = oldDisable }()
	}

	baseDir := t.TempDir()
	agentWs := filepath.Join(baseDir, "episodes")
	nestedDir := filepath.Join(agentWs, "episodes", "2026", "03", "31")
	nestedFile := filepath.Join(nestedDir, "legacy_backlog_20260331_000001.md")

	if err := os.MkdirAll(nestedDir, 0o755); err != nil {
		t.Fatalf("mkdir nested dir: %v", err)
	}
	if err := os.WriteFile(nestedFile, []byte("---\nid: legacy-1\ntitle: legacy\n---\nlegacy body\n"), 0o644); err != nil {
		t.Fatalf("write nested file: %v", err)
	}

	seeded, err := vector.NewStore(agentWs, vector.StoreConfig{TombstoneTTL: 14, LexicalFilterLimit: 1000})
	if err != nil {
		t.Fatalf("seed store failed: %v", err)
	}
	seedRecord := vector.EpisodeRecord{
		ID:         "legacy-1",
		Title:      "legacy",
		SourcePath: nestedFile,
		Vector:     make([]float32, 3072),
		Timestamp:  time.Now(),
		Surprise:   0,
	}
	if err := seeded.Add(context.Background(), seedRecord); err != nil {
		t.Fatalf("seed record failed: %v", err)
	}
	if err := seeded.Close(); err != nil {
		t.Fatalf("close seeded store: %v", err)
	}

	store, err := getStore(agentWs)
	if err != nil {
		t.Fatalf("getStore failed: %v", err)
	}
	defer store.Close()

	if _, err := os.Stat(nestedFile); !os.IsNotExist(err) {
		t.Fatalf("expected original nested file to be moved out of place, got err=%v", err)
	}

	RunAsyncHealingWorker(agentWs, "", store)

	w, err := watcher.New(10, func(event watcher.FileEvent) {})
	if err != nil {
		t.Fatalf("watcher.New failed: %v", err)
	}
	if err := w.AddRecursive(agentWs); err != nil {
		t.Fatalf("watcher.AddRecursive failed: %v", err)
	}
	w.Start()
	defer w.Stop()

	time.Sleep(500 * time.Millisecond)

	result := runAutoRebuild(agentWs, "", store)
	if result.Processed != 0 {
		t.Fatalf("expected no files to be rebuilt from active root, got processed=%d", result.Processed)
	}

	if _, err := store.GetByPath(nestedFile); err == nil {
		t.Fatalf("expected orphaned nested path to be absent from the active store")
	}
}

func TestLegacyNestedEpisodeTreeRuntimeRollback(t *testing.T) {
	oldDisable := false
	if disableWorkers != nil {
		oldDisable = *disableWorkers
		*disableWorkers = true
		defer func() { *disableWorkers = oldDisable }()
	}

	baseDir := t.TempDir()
	agentWs := filepath.Join(baseDir, "episodes")
	nestedDir := filepath.Join(agentWs, "episodes", "2026", "03", "31")
	nestedFile := filepath.Join(nestedDir, "legacy_backlog_20260331_000001.md")

	if err := os.MkdirAll(nestedDir, 0o755); err != nil {
		t.Fatalf("mkdir nested dir: %v", err)
	}
	if err := os.WriteFile(nestedFile, []byte("---\nid: legacy-1\ntitle: legacy\n---\nlegacy body\n"), 0o644); err != nil {
		t.Fatalf("write nested file: %v", err)
	}

	seeded, err := vector.NewStore(agentWs, vector.StoreConfig{TombstoneTTL: 14, LexicalFilterLimit: 1000})
	if err != nil {
		t.Fatalf("seed store failed: %v", err)
	}
	seedRecord := vector.EpisodeRecord{
		ID:         "legacy-1",
		Title:      "legacy",
		SourcePath: nestedFile,
		Vector:     make([]float32, 3072),
		Timestamp:  time.Now(),
		Surprise:   0,
	}
	if err := seeded.Add(context.Background(), seedRecord); err != nil {
		t.Fatalf("seed record failed: %v", err)
	}
	if err := seeded.Close(); err != nil {
		t.Fatalf("close seeded store: %v", err)
	}

	store, err := getStore(agentWs)
	if err != nil {
		t.Fatalf("getStore failed: %v", err)
	}

	restoredRoot, _, err := restoreLegacyNestedEpisodeTree(agentWs)
	if err != nil {
		t.Fatalf("filesystem rollback failed: %v", err)
	}
	if restoredRoot == "" {
		t.Fatalf("expected rollback target to be reported")
	}

	if _, err := os.Stat(filepath.Join(agentWs, "vector.db")); err != nil {
		t.Fatalf("expected vector.db to be restored: %v", err)
	}
	if _, err := os.Stat(filepath.Join(agentWs, "lexical")); err != nil {
		t.Fatalf("expected lexical index to be restored: %v", err)
	}

	if _, err := os.Stat(nestedFile); err != nil {
		t.Fatalf("expected nested tree file to be restored: %v", err)
	}

	if err := store.Close(); err != nil {
		t.Fatalf("close store after rollback: %v", err)
	}
}
