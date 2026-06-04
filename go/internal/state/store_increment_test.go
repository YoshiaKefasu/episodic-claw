package state

import (
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dir, err := os.MkdirTemp("", "state-incr-test-*")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	dbPath := filepath.Join(dir, "state.db")
	s, err := Open(dbPath)
	if err != nil {
		t.Fatalf("Open(%s) failed: %v", dbPath, err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestIncrementCounterStartsAtOneForMissingKey(t *testing.T) {
	s := newTestStore(t)

	got, err := s.IncrementCounter("meta:forgotten_snapshot_counter:2026")
	if err != nil {
		t.Fatalf("IncrementCounter failed: %v", err)
	}
	if got != 1 {
		t.Fatalf("first increment returned %d, want 1", got)
	}
}

func TestIncrementCounterMonotonicallyIncrements(t *testing.T) {
	s := newTestStore(t)

	const key = "meta:forgotten_snapshot_counter:2027"
	for i := uint64(1); i <= 5; i++ {
		got, err := s.IncrementCounter(key)
		if err != nil {
			t.Fatalf("IncrementCounter iter %d failed: %v", i, err)
		}
		if got != i {
			t.Fatalf("iter %d returned %d, want %d", i, got, i)
		}
	}
}

func TestIncrementCounterPerYearKeysAreIndependent(t *testing.T) {
	s := newTestStore(t)

	const y2026 = "meta:forgotten_snapshot_counter:2026"
	const y2027 = "meta:forgotten_snapshot_counter:2027"

	if n, err := s.IncrementCounter(y2026); err != nil || n != 1 {
		t.Fatalf("2026 first = %d err=%v, want 1/nil", n, err)
	}
	if n, err := s.IncrementCounter(y2027); err != nil || n != 1 {
		t.Fatalf("2027 first = %d err=%v, want 1/nil (year-reset)", n, err)
	}
	if n, err := s.IncrementCounter(y2026); err != nil || n != 2 {
		t.Fatalf("2026 second = %d err=%v, want 2/nil", n, err)
	}
}

func TestIncrementCounterRejectsCorruptValue(t *testing.T) {
	s := newTestStore(t)

	if err := s.Set("meta:forgotten_snapshot_counter:2028", "not-a-number"); err != nil {
		t.Fatalf("Set failed: %v", err)
	}
	if _, err := s.IncrementCounter("meta:forgotten_snapshot_counter:2028"); err == nil {
		t.Fatalf("expected parse error, got nil")
	}
}

func TestIncrementCounterConcurrentSerialUnderLock(t *testing.T) {
	s := newTestStore(t)

	const key = "meta:forgotten_snapshot_counter:2029"
	const goroutines = 50
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			if _, err := s.IncrementCounter(key); err != nil {
				t.Errorf("IncrementCounter failed: %v", err)
			}
		}()
	}
	wg.Wait()

	val, err := s.Get(key)
	if err != nil {
		t.Fatalf("Get after concurrent increments failed: %v", err)
	}
	got, err := strconv.ParseUint(val, 10, 64)
	if err != nil {
		t.Fatalf("parse final value %q failed: %v", val, err)
	}
	if got != goroutines {
		t.Fatalf("final value = %d, want %d (lost increments indicate race)", got, goroutines)
	}
}
