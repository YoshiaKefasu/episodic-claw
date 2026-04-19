// Package state provides a lightweight key-value store for persistent control state
// (segmenter cursors, narrative save hashes, etc.) using PebbleDB.
// This is physically separated from vector.db (memory) and cache.db (queue)
// to maintain clean responsibility boundaries.
package state

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/cockroachdb/pebble"
)

// Store is a simple key-value store backed by PebbleDB for agent control state.
type Store struct {
	db   *pebble.DB
	path string
	mu   sync.Mutex
}

// OpenGlobal opens or creates the global state DB at ~/.openclaw/episodic-claw/state.db.
// On Windows, this resolves to %USERPROFILE%\.openclaw\episodic-claw\state.db.
func OpenGlobal() (*Store, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("failed to resolve home directory: %w", err)
	}
	dbPath := filepath.Join(home, ".openclaw", "episodic-claw", "state.db")
	return Open(dbPath)
}

// Open opens or creates a state DB at the given path.
func Open(dbPath string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("failed to create state DB directory: %w", err)
	}

	opts := &pebble.Options{}
	db, err := pebble.Open(dbPath, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to open state DB at %s: %w", dbPath, err)
	}

	return &Store{
		db:   db,
		path: dbPath,
	}, nil
}

// Get retrieves a value by key. Returns empty string and nil error if key not found.
// This follows the "empty string = not found" convention for easy TS-side consumption.
func (s *Store) Get(key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	val, closer, err := s.db.Get([]byte(key))
	if err != nil {
		if err == pebble.ErrNotFound {
			return "", nil
		}
		return "", fmt.Errorf("state.Get(%s) failed: %w", key, err)
	}
	defer closer.Close()

	return string(val), nil
}

// Set stores a key-value pair.
func (s *Store) Set(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := s.db.Set([]byte(key), []byte(value), pebble.Sync); err != nil {
		return fmt.Errorf("state.Set(%s) failed: %w", key, err)
	}
	return nil
}

// Close closes the underlying PebbleDB.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.db.Close()
}

// Path returns the filesystem path of the state DB.
func (s *Store) Path() string {
	return s.path
}
