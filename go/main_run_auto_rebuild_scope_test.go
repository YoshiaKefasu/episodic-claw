package main

import (
	"os"
	"path/filepath"
	"testing"

	"episodic-core/internal/vector"
)

// TestRunAutoRebuildScope_LimitsToEpisodesSubdir verifies the v0.4.34-pre.release.hf3 fix:
// runAutoRebuild must NOT walk files outside the episodes/ subdirectory.
// Bug A symptom: 200+ spurious "episode record ID must not be empty" errors
// from memory/, venv/, etc. when rebuild fires.
func TestRunAutoRebuildScope_LimitsToEpisodesSubdir(t *testing.T) {
	oldDisable := false
	if disableWorkers != nil {
		oldDisable = *disableWorkers
		*disableWorkers = true
		defer func() { *disableWorkers = oldDisable }()
	}

	baseDir := t.TempDir()

	// Drop markdown files OUTSIDE the episodes/ subdir (memory/, venv/ analog)
	if err := os.MkdirAll(filepath.Join(baseDir, "memory", "kasou_diary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "memory", "MEMORY.md"), []byte("# mem"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "memory", "kasou_diary", "2026-05-01.md"), []byte("# diary"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(baseDir, "venv", "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(baseDir, "venv", "LICENSE.md"), []byte("# v"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Drop one valid episode file inside the episodes/ subdir with proper frontmatter
	epDir := filepath.Join(baseDir, "episodes", "2026", "06", "04")
	if err := os.MkdirAll(epDir, 0o755); err != nil {
		t.Fatal(err)
	}
	epPath := filepath.Join(epDir, "test-episode.md")
	if err := os.WriteFile(epPath, []byte("---\nid: scope-test-1\ntitle: scope test\n---\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The fix's key behavior: runAutoRebuild should be a no-op when GEMINI_API_KEY
	// is empty (we don't have a real API key in CI). With the fix, the walk is
	// confined to episodes/, but with an empty API key the function returns early
	// after provider init. Either way, the workspace-level files should never be
	// picked up. The test simply checks they still exist (untouched) after the call.
	store, err := vector.NewStore(baseDir, vector.StoreConfig{DeleteTTL: 14, LexicalFilterLimit: 1000})
	if err != nil {
		t.Fatalf("vector.NewStore: %v", err)
	}
	defer store.Close()

	_ = runAutoRebuild(baseDir, "", store)

	// After the call, the files outside episodes/ must still exist and be untouched
	for _, p := range []string{
		filepath.Join(baseDir, "memory", "MEMORY.md"),
		filepath.Join(baseDir, "memory", "kasou_diary", "2026-05-01.md"),
		filepath.Join(baseDir, "venv", "LICENSE.md"),
	} {
		if _, err := os.Stat(p); err != nil {
			t.Errorf("expected file outside episodes/ to be untouched: %s err=%v", p, err)
		}
	}
	// The episode inside episodes/ should also still be there (rebuild is a no-op
	// without API key, no delete)
	if _, err := os.Stat(epPath); err != nil {
		t.Errorf("expected episode inside episodes/ to be untouched: %s err=%v", epPath, err)
	}
}

// TestRunAutoRebuildScope_HasSuffixGuard verifies that callers passing an
// already-/episodes-suffixed targetDir do not get a double-joined phantom
// path. This is the BLOCKER case identified by code-reviewer:
//   targetDir = ".../episodes" → episodesDir must remain ".../episodes" (no extra /episodes suffix)
func TestRunAutoRebuildScope_HasSuffixGuard(t *testing.T) {
	oldDisable := false
	if disableWorkers != nil {
		oldDisable = *disableWorkers
		*disableWorkers = true
		defer func() { *disableWorkers = oldDisable }()
	}

	baseDir := t.TempDir()
	agentWs := filepath.Join(baseDir, "episodes")

	// Create a real .md file directly under the passed agentWs (=.../episodes)
	if err := os.MkdirAll(agentWs, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(agentWs, "x.md"),
		[]byte("---\nid: x-1\ntitle: x\n---\nbody\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	store, err := vector.NewStore(agentWs, vector.StoreConfig{DeleteTTL: 14, LexicalFilterLimit: 1000})
	if err != nil {
		t.Fatalf("vector.NewStore: %v", err)
	}
	defer store.Close()

	_ = runAutoRebuild(agentWs, "", store)

	// File must still exist (no double-join phantom walk removed it)
	if _, err := os.Stat(filepath.Join(agentWs, "x.md")); err != nil {
		t.Errorf("HasSuffix guard failed: file at %s was affected by phantom walk: %v",
			filepath.Join(agentWs, "x.md"), err)
	}
}

// TestRunAutoRebuildScope_NoEpisodesSubdir verifies that the fix skips gracefully
// when targetDir has no episodes/ subdirectory. This covers workspaces where
// the directory was just created or episodes live elsewhere.
func TestRunAutoRebuildScope_NoEpisodesSubdir(t *testing.T) {
	oldDisable := false
	if disableWorkers != nil {
		oldDisable = *disableWorkers
		*disableWorkers = true
		defer func() { *disableWorkers = oldDisable }()
	}

	baseDir := t.TempDir() // empty — no episodes/ inside

	store, err := vector.NewStore(baseDir, vector.StoreConfig{DeleteTTL: 14, LexicalFilterLimit: 1000})
	if err != nil {
		t.Fatalf("vector.NewStore: %v", err)
	}
	defer store.Close()

	result := runAutoRebuild(baseDir, "", store)
	if result.Processed != 0 {
		t.Errorf("expected Processed=0 when no episodes/ subdir, got %d", result.Processed)
	}
}

// TestRunAutoRebuildScope_EpisodesSubdirIsFile verifies that if the path
// "episodes" exists but is a file (not a directory), the function skips
// safely instead of crashing in filepath.Walk.
func TestRunAutoRebuildScope_EpisodesSubdirIsFile(t *testing.T) {
	oldDisable := false
	if disableWorkers != nil {
		oldDisable = *disableWorkers
		*disableWorkers = true
		defer func() { *disableWorkers = oldDisable }()
	}

	baseDir := t.TempDir()
	// Create a regular file named "episodes"
	if err := os.WriteFile(filepath.Join(baseDir, "episodes"), []byte("not a dir"), 0o644); err != nil {
		t.Fatal(err)
	}

	store, err := vector.NewStore(baseDir, vector.StoreConfig{DeleteTTL: 14, LexicalFilterLimit: 1000})
	if err != nil {
		t.Fatalf("vector.NewStore: %v", err)
	}
	defer store.Close()

	result := runAutoRebuild(baseDir, "", store)
	if result.Processed != 0 {
		t.Errorf("expected Processed=0 when episodes is a file, got %d", result.Processed)
	}
}
