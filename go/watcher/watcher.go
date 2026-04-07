package watcher

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"episodic-core/internal/logger"

	"github.com/fsnotify/fsnotify"
)

type FileEvent struct {
	Path      string
	Operation string // "CREATE", "WRITE", "REMOVE", "RENAME"
}

// queuedEvent holds an event and the time we expect it to mature
type queuedEvent struct {
	Event    FileEvent
	MatureAt time.Time
}

type Watcher struct {
	fw       *fsnotify.Watcher
	debounce time.Duration
	queue    map[string]*queuedEvent
	mu       sync.Mutex
	root     string
	Emit     func(event FileEvent) // Callback to send to RPC
	Done     chan bool
}

// New initializes the watcher.
func New(debounceMs int, emitFn func(FileEvent)) (*Watcher, error) {
	fw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, fmt.Errorf("fsnotify error: %w", err)
	}

	w := &Watcher{
		fw:       fw,
		debounce: time.Duration(debounceMs) * time.Millisecond,
		queue:    make(map[string]*queuedEvent),
		Emit:     emitFn,
		Done:     make(chan bool),
	}
	return w, nil
}

// AddRecursive walks a directory and adds it and subdirectories to the watcher.
func (w *Watcher) AddRecursive(dir string) error {
	w.root = filepath.Clean(dir)
	return filepath.Walk(w.root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if w.shouldSkipPath(path) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if info.IsDir() {
			if err := w.fw.Add(path); err != nil {
				return err
			}
		}
		return nil
	})
}

func (w *Watcher) shouldSkipPath(candidate string) bool {
	if w.root == "" {
		return false
	}

	rel, err := filepath.Rel(w.root, candidate)
	if err != nil {
		return false
	}
	rel = filepath.Clean(rel)
	if rel == "." {
		return false
	}

	return rel == "episodes" || strings.HasPrefix(rel, "episodes"+string(filepath.Separator))
}

// processQueue is a worker tick that runs periodically to flush matured events safely
func (w *Watcher) processQueue() {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			now := time.Now()
			w.mu.Lock()

			// Find matured events
			var matured []FileEvent
			for path, qEv := range w.queue {
				if now.After(qEv.MatureAt) {
					matured = append(matured, qEv.Event)
					delete(w.queue, path)
				}
			}
			w.mu.Unlock()

			// Emit matured events safely outside the lock to prevent deadlocking if Emit is slow
			for _, ev := range matured {
				w.Emit(ev)
			}

		case <-w.Done:
			return
		}
	}
}

// Start begins listening to fsnotify events and debouncing them safely using a worker queue.
func (w *Watcher) Start() {
	// Start the background queue processor
	go w.processQueue()

	go func() {
		for {
			select {
			case event, ok := <-w.fw.Events:
				if !ok {
					return
				}

				// If it's a new directory, we need to watch it
				if event.Has(fsnotify.Create) {
					info, err := os.Stat(event.Name)
					if err == nil && info.IsDir() {
						if w.shouldSkipPath(event.Name) {
							continue
						}
						w.fw.Add(event.Name)
						continue // Don't emit directory creation to TS directly
					}
				}

				if w.shouldSkipPath(event.Name) {
					continue
				}

				// Only care about markdown files
				if filepath.Ext(event.Name) != ".md" {
					continue
				}

				op := "WRITE"
				if event.Has(fsnotify.Create) {
					op = "CREATE"
				} else if event.Has(fsnotify.Remove) {
					op = "REMOVE"
				} else if event.Has(fsnotify.Rename) {
					op = "RENAME"
				}

				w.mu.Lock()
				// Add or update the event in the queue, pushing back its maturity time
				w.queue[event.Name] = &queuedEvent{
					Event: FileEvent{
						Path:      event.Name,
						Operation: op,
					},
					MatureAt: time.Now().Add(w.debounce),
				}
				w.mu.Unlock()

			case err, ok := <-w.fw.Errors:
				if !ok {
					return
				}
				logger.Warn(logger.CatWatcher, "Error: %v", err)
			case <-w.Done:
				w.fw.Close()
				return
			}
		}
	}()
}

func (w *Watcher) Stop() {
	// Send done twice: once for the fsnotify listener, once for the processQueue worker
	w.Done <- true
	w.Done <- true
}
