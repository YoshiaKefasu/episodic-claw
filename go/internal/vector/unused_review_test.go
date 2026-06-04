package vector

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRecordInjectedUpdatesEpisodeRecord(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	ctx := context.Background()
	rec := unusedReviewTestRecord("inject-me", time.Now().Add(-48*time.Hour), filepath.Join("episodes", "2026", "05", "inject-me.md"))
	if err := s.Add(ctx, rec); err != nil {
		t.Fatalf("Add failed: %v", err)
	}

	injectedAt := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	if err := s.RecordInjected("inject-me", injectedAt); err != nil {
		t.Fatalf("RecordInjected failed: %v", err)
	}

	updated, err := s.Get("inject-me")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if updated.InjectedCount != 1 {
		t.Fatalf("InjectedCount = %d, want 1", updated.InjectedCount)
	}
	if !updated.LastInjectedAt.Equal(injectedAt) {
		t.Fatalf("LastInjectedAt = %s, want %s", updated.LastInjectedAt, injectedAt)
	}
}

func TestListUnusedMDEpisodesExcludesUsedAndManualSaveRecords(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	old := now.Add(-366 * 24 * time.Hour)
	recent := now.Add(-30 * 24 * time.Hour)

	records := []EpisodeRecord{
		unusedReviewTestRecord("eligible", old, filepath.Join("episodes", "2025", "05", "eligible.md")),
		unusedReviewTestRecord("recent", recent, filepath.Join("episodes", "2026", "05", "recent.md")),
		unusedReviewTestRecord("manual-tag", old, filepath.Join("episodes", "2025", "05", "manual-tag.md")),
		unusedReviewTestRecord("manual-notes", old, filepath.Join("episodes", "notes", "2025-05", "manual-notes.md")),
		unusedReviewTestRecord("recalled", old, filepath.Join("episodes", "2025", "05", "recalled.md")),
		unusedReviewTestRecord("expanded", old, filepath.Join("episodes", "2025", "05", "expanded.md")),
		unusedReviewTestRecord("injected", old, filepath.Join("episodes", "2025", "05", "injected.md")),
		unusedReviewTestRecord("txt", old, filepath.Join("episodes", "2025", "05", "txt.txt")),
	}
	records[2].Tags = []string{"manual-save"}
	records[4].RecallShownCount = 1
	records[4].LastRecalledAt = now.Add(-24 * time.Hour)
	records[5].Hits = 1
	records[5].LastHitAt = now.Add(-24 * time.Hour)
	records[6].InjectedCount = 1
	records[6].LastInjectedAt = now.Add(-24 * time.Hour)

	if err := s.BatchAdd(context.Background(), records); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	candidates, err := s.ListUnusedMDEpisodes(context.Background(), now, 365, 20)
	if err != nil {
		t.Fatalf("ListUnusedMDEpisodes failed: %v", err)
	}
	if len(candidates) != 1 {
		t.Fatalf("candidate count = %d, want 1: %#v", len(candidates), candidates)
	}
	if candidates[0].ID != "eligible" {
		t.Fatalf("candidate ID = %q, want eligible", candidates[0].ID)
	}
}

func TestListBatchableForgottenAndDeleteForgottenFiles(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{DeleteTTL: 14})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	oldFile := filepath.Join(t.TempDir(), "old.md")
	recentFile := filepath.Join(t.TempDir(), "recent.md")
	if err := os.WriteFile(oldFile, []byte("old forgotten"), 0o644); err != nil {
		t.Fatalf("WriteFile old failed: %v", err)
	}
	if err := os.WriteFile(recentFile, []byte("recent forgotten"), 0o644); err != nil {
		t.Fatalf("WriteFile recent failed: %v", err)
	}

	old := unusedReviewTestRecord("old-forgotten", now.Add(-400*24*time.Hour), oldFile)
	old.PruneState = "forgotten"
	old.ForgottenAt = now.Add(-15 * 24 * time.Hour)
	recent := unusedReviewTestRecord("recent-forgotten", now.Add(-400*24*time.Hour), recentFile)
	recent.PruneState = "forgotten"
	recent.ForgottenAt = now.Add(-13 * 24 * time.Hour)
	normal := unusedReviewTestRecord("normal", now.Add(-400*24*time.Hour), filepath.Join("episodes", "normal.md"))

	if err := s.BatchAdd(context.Background(), []EpisodeRecord{old, recent, normal}); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	candidates, err := s.ListBatchableForgotten(context.Background(), now, 10)
	if err != nil {
		t.Fatalf("ListBatchableForgotten failed: %v", err)
	}
	if len(candidates) != 1 || candidates[0].ID != "old-forgotten" {
		t.Fatalf("candidates = %#v, want only old-forgotten", candidates)
	}

	deleted, failed := s.DeleteForgottenFiles(context.Background(), candidates)
	if deleted != 1 || failed != 0 {
		t.Fatalf("DeleteForgottenFiles deleted=%d failed=%d, want 1/0", deleted, failed)
	}
	if _, err := os.Stat(oldFile); !os.IsNotExist(err) {
		t.Fatalf("old forgotten file survived: %v", err)
	}
	if _, err := os.Stat(recentFile); err != nil {
		t.Fatalf("recent forgotten file should survive: %v", err)
	}
}

func TestSimulateMarkUnusedAsForgottenIsReadOnly(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	eligible := unusedReviewTestRecord("dry-run-eligible", now.Add(-400*24*time.Hour), filepath.Join("episodes", "2025", "04", "dry-run-eligible.md"))
	keepRecent := unusedReviewTestRecord("dry-run-recent", now.Add(-30*24*time.Hour), filepath.Join("episodes", "2026", "05", "dry-run-recent.md"))
	keepManual := unusedReviewTestRecord("dry-run-manual", now.Add(-400*24*time.Hour), filepath.Join("episodes", "2025", "04", "dry-run-manual.md"))
	keepManual.Tags = []string{"manual-save"}
	if err := s.BatchAdd(context.Background(), []EpisodeRecord{eligible, keepRecent, keepManual}); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	count, err := s.SimulateMarkUnusedAsForgotten(context.Background(), now, 365, 20)
	if err != nil {
		t.Fatalf("SimulateMarkUnusedAsForgotten failed: %v", err)
	}
	if count != 1 {
		t.Fatalf("count = %d, want 1", count)
	}

	for _, id := range []string{"dry-run-eligible", "dry-run-recent", "dry-run-manual"} {
		rec, err := s.Get(id)
		if err != nil {
			t.Fatalf("Get %s failed: %v", id, err)
		}
		if rec.PruneState != "" {
			t.Fatalf("dry-run mutated PruneState for %s: got %q", id, rec.PruneState)
		}
		if !rec.ForgottenAt.IsZero() {
			t.Fatalf("dry-run mutated ForgottenAt for %s: got %s", id, rec.ForgottenAt)
		}
		if !rec.LastInjectedAt.IsZero() {
			t.Fatalf("dry-run mutated LastInjectedAt for %s: got %s", id, rec.LastInjectedAt)
		}
	}
}

func TestSimulateMarkUnusedAsForgottenRespectsContextCancellation(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	var batch []EpisodeRecord
	for i := 0; i < 5; i++ {
		id := "cancel-eligible-" + time.Duration(i).String()
		batch = append(batch, unusedReviewTestRecord(id, now.Add(-400*24*time.Hour), filepath.Join("episodes", "2025", "04", id+".md")))
	}
	if err := s.BatchAdd(context.Background(), batch); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := s.SimulateMarkUnusedAsForgotten(ctx, now, 365, 20); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got: %v", err)
	}
}

func TestMarkEpisodesForgottenWritesPruneStateAndForgottenAt(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	eligible := unusedReviewTestRecord("write-eligible", now.Add(-400*24*time.Hour), filepath.Join("episodes", "2025", "04", "write-eligible.md"))
	keepRecent := unusedReviewTestRecord("write-recent", now.Add(-30*24*time.Hour), filepath.Join("episodes", "2026", "05", "write-recent.md"))
	keepManual := unusedReviewTestRecord("write-manual", now.Add(-400*24*time.Hour), filepath.Join("episodes", "2025", "04", "write-manual.md"))
	keepManual.Tags = []string{"manual-save"}
	if err := s.BatchAdd(context.Background(), []EpisodeRecord{eligible, keepRecent, keepManual}); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	marked, err := s.MarkEpisodesForgotten(context.Background(), now, 365, 20)
	if err != nil {
		t.Fatalf("MarkEpisodesForgotten failed: %v", err)
	}
	if marked != 1 {
		t.Fatalf("marked = %d, want 1", marked)
	}

	updated, err := s.Get("write-eligible")
	if err != nil {
		t.Fatalf("Get write-eligible failed: %v", err)
	}
	if updated.PruneState != "forgotten" {
		t.Fatalf("PruneState = %q, want forgotten", updated.PruneState)
	}
	if !updated.ForgottenAt.Equal(now) {
		t.Fatalf("ForgottenAt = %s, want %s", updated.ForgottenAt, now)
	}

	for _, id := range []string{"write-recent", "write-manual"} {
		rec, err := s.Get(id)
		if err != nil {
			t.Fatalf("Get %s failed: %v", id, err)
		}
		if rec.PruneState != "" {
			t.Fatalf("PruneState mutated for %s: got %q", id, rec.PruneState)
		}
		if !rec.ForgottenAt.IsZero() {
			t.Fatalf("ForgottenAt mutated for %s: got %s", id, rec.ForgottenAt)
		}
	}
}

func TestMarkEpisodesForgottenRespectsContextCancellation(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	var batch []EpisodeRecord
	for i := 0; i < 5; i++ {
		id := "write-cancel-" + time.Duration(i).String()
		batch = append(batch, unusedReviewTestRecord(id, now.Add(-400*24*time.Hour), filepath.Join("episodes", "2025", "04", id+".md")))
	}
	if err := s.BatchAdd(context.Background(), batch); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	count, err := s.MarkEpisodesForgotten(ctx, now, 365, 20)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got: %v (count=%d)", err, count)
	}
}

func TestMarkEpisodesForgottenDoesNotDoubleMark(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 5, 31, 12, 0, 0, 0, time.UTC)
	rec := unusedReviewTestRecord("idempotent-mark", now.Add(-400*24*time.Hour), filepath.Join("episodes", "2025", "04", "idempotent-mark.md"))
	if err := s.Add(context.Background(), rec); err != nil {
		t.Fatalf("Add failed: %v", err)
	}

	first, err := s.MarkEpisodesForgotten(context.Background(), now, 365, 20)
	if err != nil || first != 1 {
		t.Fatalf("first MarkEpisodesForgotten: count=%d err=%v, want 1/nil", first, err)
	}
	second, err := s.MarkEpisodesForgotten(context.Background(), now.Add(24*time.Hour), 365, 20)
	if err != nil {
		t.Fatalf("second MarkEpisodesForgotten err: %v", err)
	}
	if second != 0 {
		t.Fatalf("second MarkEpisodesForgotten marked %d, want 0 (already Forgotten)", second)
	}
}

func unusedReviewTestRecord(id string, ts time.Time, path string) EpisodeRecord {
	return EpisodeRecord{
		ID:         id,
		Title:      id,
		Timestamp:  ts,
		Vector:     make([]float32, 3072),
		SourcePath: path,
	}
}

// TestListAllForgottenEpisodesReturnsAllForgottenRegardlessOfAge verifies
// that ListAllForgottenEpisodes is the TTL-agnostic counterpart of
// ListBatchableForgotten. Both recent and old Forgotten must be returned.
func TestListAllForgottenEpisodesReturnsAllForgottenRegardlessOfAge(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{DeleteTTL: 14})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	oldFile := filepath.Join(t.TempDir(), "old.md")
	recentFile := filepath.Join(t.TempDir(), "recent.md")
	if err := os.WriteFile(oldFile, []byte("old forgotten"), 0o644); err != nil {
		t.Fatalf("WriteFile old failed: %v", err)
	}
	if err := os.WriteFile(recentFile, []byte("recent forgotten"), 0o644); err != nil {
		t.Fatalf("WriteFile recent failed: %v", err)
	}

	old := unusedReviewTestRecord("old-forgotten", now.Add(-400*24*time.Hour), oldFile)
	old.PruneState = "forgotten"
	old.ForgottenAt = now.Add(-15 * 24 * time.Hour) // older than 14d TTL
	recent := unusedReviewTestRecord("recent-forgotten", now.Add(-400*24*time.Hour), recentFile)
	recent.PruneState = "forgotten"
	recent.ForgottenAt = now.Add(-1 * 24 * time.Hour) // within 14d TTL
	normal := unusedReviewTestRecord("normal", now.Add(-400*24*time.Hour), filepath.Join("episodes", "normal.md"))
	normalTagged := unusedReviewTestRecord("normal-but-stale", now.Add(-400*24*time.Hour), filepath.Join("episodes", "2025", "stale.md"))
	normalTagged.PruneState = "active" // explicitly NOT forgotten

	if err := s.BatchAdd(context.Background(), []EpisodeRecord{old, recent, normal, normalTagged}); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	all, err := s.ListAllForgottenEpisodes(context.Background(), "", 100)
	if err != nil {
		t.Fatalf("ListAllForgottenEpisodes failed: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("all count = %d, want 2 (old + recent): %#v", len(all), all)
	}
	got := map[string]bool{}
	for _, r := range all {
		got[r.ID] = true
	}
	if !got["old-forgotten"] || !got["recent-forgotten"] {
		t.Fatalf("expected old-forgotten and recent-forgotten, got %#v", got)
	}
}

// TestListAllForgottenEpisodesFiltersByAgentWsPrefix verifies the
// agentWs prefix filter. Only records whose SourcePath starts with the
// supplied prefix are returned; an empty prefix returns everything.
func TestListAllForgottenEpisodesFiltersByAgentWsPrefix(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	// Use path.Join (forward slashes only) for SourcePath data so the test is
	// cross-platform. filepath.Join would convert / to \ on Windows and break
	// the strings.HasPrefix assertion below.
	wsA := "/home/kasou/.openclaw/workspace/agentA/episodes"
	wsB := "/home/kasou/.openclaw/workspace/agentB/episodes"
	recA1 := unusedReviewTestRecord("agentA-1", now.Add(-400*24*time.Hour), path.Join(wsA, "a1.md"))
	recA1.PruneState = "forgotten"
	recA1.ForgottenAt = now.Add(-3 * 24 * time.Hour)
	recA2 := unusedReviewTestRecord("agentA-2", now.Add(-400*24*time.Hour), path.Join(wsA, "a2.md"))
	recA2.PruneState = "forgotten"
	recA2.ForgottenAt = now.Add(-3 * 24 * time.Hour)
	recB := unusedReviewTestRecord("agentB-1", now.Add(-400*24*time.Hour), path.Join(wsB, "b1.md"))
	recB.PruneState = "forgotten"
	recB.ForgottenAt = now.Add(-3 * 24 * time.Hour)

	if err := s.BatchAdd(context.Background(), []EpisodeRecord{recA1, recA2, recB}); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	filtered, err := s.ListAllForgottenEpisodes(context.Background(), wsA, 100)
	if err != nil {
		t.Fatalf("ListAllForgottenEpisodes failed: %v", err)
	}
	if len(filtered) != 2 {
		t.Fatalf("filtered count = %d, want 2: %#v", len(filtered), filtered)
	}
	for _, r := range filtered {
		if !strings.HasPrefix(r.SourcePath, wsA) {
			t.Fatalf("record %s not in agentA: %s", r.ID, r.SourcePath)
		}
	}
}

// TestListAllForgottenEpisodesRespectsLimit verifies the limit is respected.
func TestListAllForgottenEpisodesRespectsLimit(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	records := make([]EpisodeRecord, 0, 5)
	for i := 0; i < 5; i++ {
		rec := unusedReviewTestRecord(
			fmt.Sprintf("forgotten-%d", i),
			now.Add(-400*24*time.Hour),
			filepath.Join("episodes", "2025", "05", fmt.Sprintf("forgotten-%d.md", i)),
		)
		rec.PruneState = "forgotten"
		rec.ForgottenAt = now.Add(-3 * 24 * time.Hour)
		records = append(records, rec)
	}
	if err := s.BatchAdd(context.Background(), records); err != nil {
		t.Fatalf("BatchAdd failed: %v", err)
	}

	got, err := s.ListAllForgottenEpisodes(context.Background(), "", 3)
	if err != nil {
		t.Fatalf("ListAllForgottenEpisodes failed: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("count = %d, want 3 (limit respected)", len(got))
	}
}

// TestListAllForgottenEpisodesRespectsContextCancellation verifies a
// cancelled context aborts the iteration promptly.
func TestListAllForgottenEpisodesRespectsContextCancellation(t *testing.T) {
	s, err := NewStore(t.TempDir(), StoreConfig{})
	if err != nil {
		t.Fatalf("NewStore failed: %v", err)
	}
	defer s.Close()

	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	rec := unusedReviewTestRecord("only-forgotten", now.Add(-400*24*time.Hour), filepath.Join("episodes", "only.md"))
	rec.PruneState = "forgotten"
	rec.ForgottenAt = now.Add(-1 * time.Hour)
	if err := s.Add(context.Background(), rec); err != nil {
		t.Fatalf("Add failed: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel before call
	got, err := s.ListAllForgottenEpisodes(ctx, "", 10)
	if err == nil {
		t.Fatalf("expected ctx error, got nil (results: %#v)", got)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}
