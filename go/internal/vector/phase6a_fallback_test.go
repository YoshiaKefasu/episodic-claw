package vector

import (
	"context"
	"testing"
	"time"
)

func TestRecallEmbedFallbackLexicalOnlyStillAllowsZeroHitHNSW(t *testing.T) {
	testDir := t.TempDir()

	store, err := NewStore(testDir, StoreConfig{})
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	record := EpisodeRecord{
		ID:         "semantic_only_fallback",
		Title:      "Semantic only memory",
		Tags:       []string{"mock"},
		Timestamp:  time.Now().Add(-1 * time.Hour),
		Vector:     make([]float32, 3072),
		SourcePath: testDir + "/semantic_only_fallback.md",
	}
	if err := store.BatchAdd(context.Background(), []EpisodeRecord{record}); err != nil {
		t.Fatalf("failed to add record: %v", err)
	}

	time.Sleep(250 * time.Millisecond)

	results, err := store.baseRecall(
		"zzqv-lexical-miss-token",
		make([]float32, 3072),
		5,
		time.Now(),
		nil,
		false,
		nil,
		"embed_fallback_lexical_only",
	)
	if err != nil {
		t.Fatalf("baseRecall failed: %v", err)
	}
	if len(results) == 0 {
		t.Fatalf("expected semantic fallback result even when lexical hits are zero")
	}
	if results[0].MatchedBy != "semantic" {
		t.Fatalf("expected zero-hit fallback result to be marked semantic, got %q", results[0].MatchedBy)
	}
	if results[0].FallbackReason != "embed_fallback_lexical_only" {
		t.Fatalf("expected fallbackReason to survive on the scored result, got %q", results[0].FallbackReason)
	}
}
