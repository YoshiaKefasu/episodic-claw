package vector

import (
	"testing"
	"time"

	"github.com/vmihailenco/msgpack/v5"
	"github.com/cockroachdb/pebble"
)

func TestCleanOrphansDeletesEmptyIDRecords(t *testing.T) {
	testDir := t.TempDir()

	store, err := NewStore(testDir, StoreConfig{})
	if err != nil {
		t.Fatalf("failed to init store: %v", err)
	}
	defer store.Close()

	rec := EpisodeRecord{
		ID:         "",
		Title:      "anchor bridge orphan",
		SourcePath: testDir + "/anchor.md",
		Vector:     make([]float32, 3072),
		Timestamp:  time.Now(),
	}

	// Seed a malformed empty-ID record directly, bypassing Add() guards.
	if err := store.db.Set(append(append([]byte(nil), prefixEp...), []byte("")...), mustMsgpack(rec), nil); err != nil {
		t.Fatalf("failed to seed malformed record: %v", err)
	}

	store.CleanOrphans()

	if _, _, err := store.db.Get(append(append([]byte(nil), prefixEp...), []byte("")...)); err != pebble.ErrNotFound {
		t.Fatalf("expected empty-ID orphan to be removed")
	}
}

func mustMsgpack(rec EpisodeRecord) []byte {
	data, err := msgpack.Marshal(&rec)
	if err != nil {
		panic(err)
	}
	return data
}
