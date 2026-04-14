package cache

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/cockroachdb/pebble"
	"gopkg.in/yaml.v3"
)

// QueueStatus represents the state of a cache queue item.
type QueueStatus string

const (
	StatusQueued     QueueStatus = "queued"
	StatusLeased     QueueStatus = "leased"
	StatusDone       QueueStatus = "done"
	StatusDeadLetter QueueStatus = "dead-letter"
)

// QueueItem represents a single narrative chunk in the cache queue.
type QueueItem struct {
	ID               string      `json:"id"`
	AgentWs          string      `json:"agentWs"`
	AgentID          string      `json:"agentId"`
	Source           string      `json:"source"`            // "live-turn" | "cold-start" | "gap-archive"
	ParentIngestID   string      `json:"parentIngestId"`    // groups chunks from same input
	OrderKey         string      `json:"orderKey"`          // "YYYYMMDDHHMMSS-0001"
	Surprise         float64     `json:"surprise"`
	Reason           string      `json:"reason"`
	RawText          string      `json:"rawText"`
	EstimatedTokens  int         `json:"estimatedTokens"`
	Status           QueueStatus `json:"status"`
	Attempts         int         `json:"attempts"`
	CreatedAt        string      `json:"createdAt"`
	UpdatedAt        string      `json:"updatedAt"`
	LeaseOwner       string      `json:"leaseOwner,omitempty"`
	LeaseUntil       string      `json:"leaseUntil,omitempty"`
	BackoffUntil     string      `json:"backoffUntil,omitempty"` // delayed requeue after failure
	LastError        string      `json:"lastError,omitempty"`
}

// FooterMarker is the HTML comment marker for Invisible Footer metadata.
const FooterMarker = "<!-- episodic-meta"

// FooterMetadata mirrors the JSON structure in the Invisible Footer.
type FooterMetadata struct {
	ID               string    `json:"id"`
	Title            string    `json:"title,omitempty"`
	Created          time.Time `json:"created"`
	Tags             []string  `json:"tags"`
	Topics           []string  `json:"topics,omitempty"`
	SavedBy          string    `json:"saved_by,omitempty"`
	ConsolidationKey string    `json:"consolidation_key,omitempty"`
	Surprise         float64   `json:"surprise"`
	Depth            int       `json:"depth,omitempty"`
	Tokens           int       `json:"tokens,omitempty"`
	Sources          []string  `json:"sources,omitempty"`
}
type Queue struct {
	db     *pebble.DB
	dataDir string
	mu     sync.Mutex
}

// New creates or opens a cache queue DB at episodes/cache.db.
func New(episodesDir string) (*Queue, error) {
	cacheDir := filepath.Join(episodesDir, "cache.db")
	opts := &pebble.Options{}
	opts.EnsureDefaults()

	db, err := pebble.Open(cacheDir, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to open cache DB: %w", err)
	}

	q := &Queue{
		db:     db,
		dataDir: cacheDir,
	}

	// Recover any orphaned leases on startup
	if err := q.recoverOrphanedLeases(); err != nil {
		// Non-fatal: log and continue
		fmt.Fprintf(os.Stderr, "[CacheQueue] Lease recovery returned: %v\n", err)
	}

	return q, nil
}

// Close closes the cache DB.
func (q *Queue) Close() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.db.Close()
}

// EnqueueBatch adds multiple items to the queue atomically.
func (q *Queue) EnqueueBatch(items []QueueItem) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	batch := q.db.NewBatch()
	defer batch.Close()

	for _, item := range items {
		item.Status = StatusQueued
		item.Attempts = 0
		now := time.Now().UTC().Format(time.RFC3339)
		if item.CreatedAt == "" {
			item.CreatedAt = now
		}
		item.UpdatedAt = now

		key := []byte(item.AgentID + ":" + item.OrderKey)
		val, err := json.Marshal(item)
		if err != nil {
			return fmt.Errorf("failed to marshal item %s: %w", item.ID, err)
		}
		if err := batch.Set(key, val, pebble.Sync); err != nil {
			return fmt.Errorf("failed to set key %s: %w", item.ID, err)
		}
	}

	return batch.Commit(pebble.Sync)
}

// LeaseNext finds the oldest queued item for the given agent and leases it.
func (q *Queue) LeaseNext(agentID, workerID string, leaseSeconds int) (*QueueItem, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	now := time.Now().UTC()
	leaseUntil := now.Add(time.Duration(leaseSeconds) * time.Second).Format(time.RFC3339)

	prefix := []byte(agentID + ":")
	iter, err := q.db.NewIter(&pebble.IterOptions{
		LowerBound: prefix,
		UpperBound: prefixUpper(prefix),
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create iterator: %w", err)
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		var item QueueItem
		if err := json.Unmarshal(iter.Value(), &item); err != nil {
			continue
		}

		// Auto-recover expired leases
		if item.Status == StatusLeased && item.LeaseUntil != "" {
			leaseExp, parseErr := time.Parse(time.RFC3339, item.LeaseUntil)
			if parseErr == nil && now.After(leaseExp) {
				item.Status = StatusQueued
				item.LeaseOwner = ""
				item.LeaseUntil = ""
				// Fall through to lease this item
			} else {
				continue // Still leased by someone else
			}
		}

		// Skip items in backoff period (delayed requeue)
		if item.Status == StatusQueued && item.BackoffUntil != "" {
			backoffExp, parseErr := time.Parse(time.RFC3339, item.BackoffUntil)
			if parseErr == nil && now.Before(backoffExp) {
				continue // Still in backoff, skip
			}
			// Backoff expired — clear it
			item.BackoffUntil = ""
		}

		if item.Status != StatusQueued {
			continue
		}

		// Lease it
		item.Status = StatusLeased
		item.LeaseOwner = workerID
		item.LeaseUntil = leaseUntil
		item.UpdatedAt = now.Format(time.RFC3339)

		val, _ := json.Marshal(item)
		if err := q.db.Set(iter.Key(), val, pebble.Sync); err != nil {
			return nil, fmt.Errorf("failed to lease item %s: %w", item.ID, err)
		}
		return &item, nil
	}

	return nil, nil // No items available
}

// Ack marks an item as done (preserves rawText for potential re-narrativization).
func (q *Queue) Ack(id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	// Find the item by scanning (simple approach; could be optimized with index)
	return q.updateItemByScan(id, func(item *QueueItem) bool {
		item.Status = StatusDone
		item.LeaseOwner = ""
		item.LeaseUntil = ""
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		return true
	}, false) // deleteAfter=false: rawText is preserved for potential re-narrativization
}

// Retry increments attempts and returns item to queued state with backoff, or moves to dead-letter.
func (q *Queue) Retry(id, errMsg string, maxAttempts int, backoffSec int) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	return q.updateItemByScan(id, func(item *QueueItem) bool {
		item.Attempts++
		item.LastError = errMsg
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		item.LeaseOwner = ""
		item.LeaseUntil = ""

		if item.Attempts >= maxAttempts {
			item.Status = StatusDeadLetter
			item.BackoffUntil = ""
			return true
		}
		item.Status = StatusQueued
		// Set backoffUntil for delayed requeue (exponential backoff capped at 300s)
		backoff := backoffSec
		if backoff <= 0 {
			backoff = 1 << min(item.Attempts, 8) // 2^attempt, cap at 2^8=256s
			if backoff > 300 {
				backoff = 300
			}
		}
		item.BackoffUntil = time.Now().UTC().Add(time.Duration(backoff) * time.Second).Format(time.RFC3339)
		return true
	}, false)
}

// Requeue moves a "done" item back to "queued" for re-narrativization.
// Returns error if item not found or not in "done" status.
func (q *Queue) Requeue(id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	return q.updateItemByScan(id, func(item *QueueItem) bool {
		if item.Status != StatusDone {
			return false // Only requeue "done" items
		}
		item.Status = StatusQueued
		item.Attempts = 0
		item.LeaseOwner = ""
		item.LeaseUntil = ""
		item.BackoffUntil = ""
		item.LastError = ""
		item.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		return true
	}, false)
}

// GetLatestNarrative scans the episodes directory for the most recent .md file
// that has the "narrative" tag, excluding genesis-archive/fallback/gap-compacted.
func (q *Queue) GetLatestNarrative(agentWs, agentID string) (episodeID string, body string, found bool, err error) {
	// Scan episodes directory for .md files with "narrative" tag
	type epInfo struct {
		id   string
		time time.Time
		tags []string
		path string
	}

	var episodes []epInfo
	filepath.WalkDir(agentWs, func(fp string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if !strings.HasSuffix(fp, ".md") || strings.HasSuffix(fp, ".raw.md") {
			return nil
		}
		content, rErr := os.ReadFile(fp)
		if rErr != nil {
			return nil
		}

		// Try footer metadata first (v0.4.0+)
		idx := bytes.LastIndex(content, []byte(FooterMarker))
		if idx >= 0 {
			remaining := content[idx:]
			endIdx := bytes.Index(remaining, []byte("-->"))
			if endIdx < 0 {
				return nil
			}
			jsonStr := strings.TrimSpace(string(remaining[len(FooterMarker):endIdx]))
			var fm FooterMetadata
			if jErr := json.Unmarshal([]byte(jsonStr), &fm); jErr != nil {
				return nil
			}
			// Check narrative tag and exclude non-continuity sources
			hasNarrative := false
			for _, t := range fm.Tags {
				if t == "narrative" {
					hasNarrative = true
					break
				}
			}
			if !hasNarrative {
				return nil
			}
			excluded := map[string]bool{"genesis-archive": true, "fallback": true, "gap-compacted": true}
			for _, t := range fm.Tags {
				if excluded[t] {
					return nil
				}
			}
			episodes = append(episodes, epInfo{
				id:   fm.ID,
				time: fm.Created,
				tags: fm.Tags,
				path: fp,
			})
			return nil
		}

		// Fallback: try YAML frontmatter (v0.3.x)
		parts := bytes.SplitN(content, []byte("---"), 3)
		if len(parts) >= 3 && len(bytes.TrimSpace(parts[0])) == 0 {
			var meta struct {
				Tags []string `yaml:"tags"`
			}
			if yErr := yaml.Unmarshal(parts[1], &meta); yErr == nil {
				hasNarrative := false
				for _, t := range meta.Tags {
					if t == "narrative" {
						hasNarrative = true
						break
					}
				}
				if hasNarrative {
					info, iErr := d.Info()
					if iErr == nil {
						episodes = append(episodes, epInfo{
							id:   strings.TrimSuffix(d.Name(), ".md"),
							time: info.ModTime(),
							tags: meta.Tags,
							path: fp,
						})
					}
				}
			}
		}
		return nil
	})

	if len(episodes) == 0 {
		return "", "", false, nil
	}

	// Sort by time descending, pick the latest
	sort.Slice(episodes, func(i, j int) bool {
		return episodes[i].time.After(episodes[j].time)
	})

	latest := episodes[0]
	bodyContent, rErr := os.ReadFile(latest.path)
	if rErr != nil {
		return "", "", false, rErr
	}

	// Extract body (strip footer metadata)
	idx := bytes.LastIndex(bodyContent, []byte(FooterMarker))
	if idx >= 0 {
		bodyContent = bodyContent[:idx]
	}

	// Strip YAML frontmatter if present (for v0.3.x episodes)
	if bytes.HasPrefix(bodyContent, []byte("---")) {
		parts := bytes.SplitN(bodyContent, []byte("---"), 3)
		if len(parts) >= 3 {
			bodyContent = bytes.TrimLeft(parts[2], "\n\r")
		}
	}

	bodyContent = bytes.TrimSpace(bodyContent)

	return latest.id, string(bodyContent), true, nil
}

// Stats returns queue statistics.
func (q *Queue) Stats() (queued, leased, done, deadLetter int, err error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	iter, err := q.db.NewIter(&pebble.IterOptions{})
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		var item QueueItem
		if err := json.Unmarshal(iter.Value(), &item); err != nil {
			continue
		}
		switch item.Status {
		case StatusQueued:
			queued++
		case StatusLeased:
			leased++
		case StatusDone:
			done++
		case StatusDeadLetter:
			deadLetter++
		}
	}
	return queued, leased, done, deadLetter, nil
}

// --- private methods ---

func (q *Queue) recoverOrphanedLeases() error {
	q.mu.Lock()
	defer q.mu.Unlock()

	now := time.Now().UTC()
	count := 0

	iter, err := q.db.NewIter(&pebble.IterOptions{})
	if err != nil {
		return err
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		var item QueueItem
		if err := json.Unmarshal(iter.Value(), &item); err != nil {
			continue
		}

		if item.Status == StatusLeased && item.LeaseUntil != "" {
			leaseExp, parseErr := time.Parse(time.RFC3339, item.LeaseUntil)
			if parseErr == nil && now.After(leaseExp) {
				item.Status = StatusQueued
				item.LeaseOwner = ""
				item.LeaseUntil = ""
				item.UpdatedAt = now.Format(time.RFC3339)

				val, _ := json.Marshal(item)
				if err := q.db.Set(iter.Key(), val, pebble.Sync); err != nil {
					continue
				}
				count++
			}
		}
	}

	if count > 0 {
		fmt.Fprintf(os.Stderr, "[CacheQueue] Recovered %d orphaned leases\n", count)
	}
	return nil
}

func (q *Queue) updateItemByScan(id string, fn func(*QueueItem) bool, deleteAfter bool) error {
	prefix := id
	if idx := indexColon(id); idx >= 0 {
		prefix = id[:idx+1]
	}

	iter, err := q.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte(prefix),
		UpperBound: []byte(prefix + "~"), // rough upper bound
	})
	if err != nil {
		return err
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		var item QueueItem
		if err := json.Unmarshal(iter.Value(), &item); err != nil {
			continue
		}
		if item.ID == id {
			if !fn(&item) {
				return nil
			}
			val, _ := json.Marshal(item)
			if deleteAfter {
				return q.db.Delete(iter.Key(), pebble.Sync)
			}
			return q.db.Set(iter.Key(), val, pebble.Sync)
		}
	}

	return fmt.Errorf("item %s not found", id)
}

func indexColon(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] == ':' {
			return i
		}
	}
	return -1
}

func prefixUpper(prefix []byte) []byte {
	end := make([]byte, len(prefix))
	copy(end, prefix)
	for i := len(end) - 1; i >= 0; i-- {
		end[i]++
		if end[i] != 0 {
			return end
		}
	}
	return append(end, 0)
}
