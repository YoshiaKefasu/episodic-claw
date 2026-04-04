package vector

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestRuthlessIntegration hits the store directly with 1000 items, forces garbage collection,
// checks Lexical syncing, and confirms Tombstone and Archive states.
func TestRuthlessIntegration(t *testing.T) {
	// Setup test directory
	testDir := t.TempDir()

	s, err := NewStore(testDir, StoreConfig{})
	if err != nil {
		t.Fatalf("Failed to init store: %v", err)
	}
	defer s.Close()

	ctx := context.Background()

	// -----------------------------------------------------
	// Scenario 1: The Data Flood & Lexical Overflow
	// -----------------------------------------------------
	t.Log("==> Scenario 1: Injecting 200 records via BatchAdd...")
	var records []EpisodeRecord
	for i := 0; i < 200; i++ {
		rec := EpisodeRecord{
			ID:              fmt.Sprintf("test_rec_%d", i),
			Title:           fmt.Sprintf("Dummy Document %d", i),
			Topics:          []string{"test_topic", "ruthless"},
			Tags:            []string{"mock"},
			Timestamp:       time.Now().Add(-1 * time.Hour), // Older than 30 mins
			Vector:          make([]float32, 3072), // Dummy zero-vector
			SourcePath:      fmt.Sprintf("/fake/path/test_%d.md", i),
			ImportanceScore: 0.1, // Set up for early pruning
			NoiseScore:      0.9, 
		}
		if i == 100 {
			rec.Title = "The secret architecture of OpenClaw" // Target for Lexical Search
		}
		records = append(records, rec)
	}
	if err := s.BatchAdd(ctx, records); err != nil {
		t.Fatalf("Failed BatchAdd: %v", err)
	}
	
	// We warp "test_rec_1"
	// Extract via raw get to ensure presence
	_, testC, testErr := s.GetRawMeta([]byte("ep:test_rec_1"))
	if testErr != nil {
		t.Fatalf("test_rec_1 MISSING before tombstone warp! err: %v", testErr)
	} else {
		testC.Close()
	}

	// Yield for Lexical Sync to catch up
	t.Log("Waiting 2 seconds for Lexical sync queue to drain...")
	time.Sleep(2 * time.Second)

	// Verify count inside pebble explicitly via manual iteration or recall
	results, err := s.baseRecall("", make([]float32, 3072), 5, time.Now(), nil, false, nil, "")
	if err != nil {
		t.Fatalf("Failed baseRecall: %v", err)
	}
	if len(results) == 0 {
		t.Fatalf("Expected some HNSW or Lexical recall results, got 0")
	}

	// -----------------------------------------------------
	// Scenario 2: 2-Stage Retrieval Fallback & Lexical Fusion
	// -----------------------------------------------------
	t.Log("==> Scenario 2: Querying Lexical Target...")
	lexResults, err := s.baseRecall("architecture", make([]float32, 3072), 5, time.Now(), nil, false, nil, "")
	if err != nil {
		t.Fatalf("Lexical baseRecall failed: %v", err)
	}
	
	found := false
	for _, res := range lexResults {
		if res.Record.ID == "test_rec_100" {
			found = true
			if res.BM25Score <= 0 {
				t.Fatalf("Expected BM25Score > 0 for lexical hit: %v", res)
			}
			t.Logf("Successfully extracted Lexical Hit (ID: %s, BM25: %.2f)", res.Record.ID, res.BM25Score)
			break
		}
	}
	if !found {
		t.Fatalf("Failed to retrieve 'test_rec_50' via Lexical Engine")
	}

	// -----------------------------------------------------
	// Scenario 3: Tombstone GC & Autonomic Pruning
	// -----------------------------------------------------
	t.Log("==> Scenario 3: Tombstone Pruning...")
	// We force ComputeStage2BatchScores to mark them as tombstone (Imp: 0.1, Noise: 0.9)
	err = s.ComputeStage2BatchScores(ctx)
	if err != nil {
		t.Fatalf("Failed ComputeStage2 Batch Scores: %v", err)
	}

	// Manually warp time for one record to simulate 15 days passing
	time.Sleep(1 * time.Second) // wait Lexical worker
	// We warp "test_rec_1"
	// Extract via raw get to ensure presence
	_, closer1, err1 := s.GetRawMeta([]byte("ep:test_rec_1"))
	if err1 == nil && closer1 != nil {
		closer1.Close()
	} else {
		t.Fatalf("Record test_rec_1 not found before tombstone warp: %v", err1)
	}

	tempFilePath := filepath.Join(testDir, "test_1.md")
	os.WriteFile(tempFilePath, []byte("dummy memory content"), 0644)

	dummyRec := EpisodeRecord{
		ID:           "test_rec_1",
		PruneState:   "tombstone",
		TombstonedAt: time.Now().Add(-15 * 24 * time.Hour), // 15 days ago
		SourcePath:   tempFilePath,
	}
	_ = dummyRec
	s.UpdateRecord("test_rec_1", func(r *EpisodeRecord) error {
		r.PruneState = "tombstone"
		r.TombstonedAt = time.Now().Add(-15 * 24 * time.Hour)
		r.SourcePath = tempFilePath
		return nil
	})

	// Run GC (should delete the temp file)
	err = s.RunGarbageCollector(ctx)
	if err != nil {
		t.Fatalf("GarbageCollector failed: %v", err)
	}

	// Check if test_rec_1 file is dead
	if _, err := os.Stat(tempFilePath); !os.IsNotExist(err) {
		t.Fatalf("Expected %s to be GC'd by RunGarbageCollector, but it survived.", tempFilePath)
	} else {
		t.Log("Tombstone successfully GC'd after 15 days simulation!")
	}

	// -----------------------------------------------------
	// Scenario 4: Archived Memory Leak Prevention (Lexical Clean)
	// -----------------------------------------------------
	t.Log("==> Scenario 4: Archive Leak check...")
	s.UpdateRecord("test_rec_100", func(r *EpisodeRecord) error {
		r.PruneState = "merged" // Simulate D1 consolidation
		return nil
	})

	// Simulate D1 consolidation
	time.Sleep(6 * time.Second) // Wait for lexical sync (up to 5s exponential backoff now)

	lexResultsMerged, _ := s.baseRecall("architecture", make([]float32, 3072), 5, time.Now(), nil, false, nil, "")
	for _, res := range lexResultsMerged {
		if res.Record.ID == "test_rec_100" {
			t.Fatalf("Archived record 'test_rec_100' leaked into Lexical Engine results!")
		}
	}
	t.Log("Lexical Index successfully purged Archived/Merged memories.")

	t.Log("✅ All Ruthless Integration Protocols Passed.")
}

func TestLexicalWALCrashRecovery(t *testing.T) {
	testDir := t.TempDir()

	s, err := NewStore(testDir, StoreConfig{})
	if err != nil {
		t.Fatalf("Failed to init store: %v", err)
	}

	ctx := context.Background()

	// 1. Stop the background lexical worker immediately
	if s.lexicalCancel != nil {
		s.lexicalCancel()
	}

	// 2. Add a record. This writes the EpisodeRecord and the sys_lexq key into Pebble,
	// but because the worker is stopped, it WON'T reach Bleve.
	err = s.Add(ctx, EpisodeRecord{
		ID:     "crash_rec_1",
		Title:  "Crash test dummy architecture",
		Tags:   []string{"test"},
		Vector: make([]float32, 3072),
	})
	if err != nil {
		t.Fatalf("Failed to add test record: %v", err)
	}

	// 3. Close the store gracefully (or simulated crash)
	s.Close()

	// 4. Re-open the store. The lexical worker will boot up and immediately 
	// scan Pebble for dangling sys_lexq items and perform the indexing.
	s2, err := NewStore(testDir, StoreConfig{})
	if err != nil {
		t.Fatalf("Failed to restart store: %v", err)
	}
	defer s2.Close()

	// Give the newly booted worker a couple of seconds to process the WAL
	t.Log("Waiting 2 seconds for Crash Recovery Lexical Sync...")
	time.Sleep(2 * time.Second)

	// 5. Query Bleve explicitly! 
	lexResults, err := s2.baseRecall("Crash test dummy architecture", make([]float32, 3072), 5, time.Now(), nil, false, nil, "")
	if err != nil {
		t.Fatalf("baseRecall failed: %v", err)
	}

	found := false
	for _, res := range lexResults {
		if res.Record.ID == "crash_rec_1" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("Crash recovery failed: record not found in Lexical engine after reboot!")
	}
	t.Log("✅ TestLexicalWALCrashRecovery Passed.")
}
