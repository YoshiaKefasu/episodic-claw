package vector

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"episodic-core/frontmatter"

	"github.com/cockroachdb/pebble"
	"github.com/Bithack/go-hnsw"
	"github.com/vmihailenco/msgpack/v5"
)

// EpisodeRecord encapsulates metadata and the raw embedding for persistent storage.
type EpisodeRecord struct {
	ID         string             `json:"id" msgpack:"id"`
	Title      string             `json:"title" msgpack:"title"`
	Tags       []string           `json:"tags" msgpack:"tags"`
	Timestamp  time.Time          `json:"timestamp" msgpack:"timestamp"`
	Edges      []frontmatter.Edge `json:"edges" msgpack:"edges"`
	Vector     []float32          `json:"vector" msgpack:"vector"`
	SourcePath string             `json:"path" msgpack:"path"`
	Depth      int                `json:"depth,omitempty" msgpack:"depth,omitempty"`
	Tokens     int                `json:"tokens,omitempty" msgpack:"tokens,omitempty"`
	Surprise   float64            `json:"surprise" msgpack:"surprise"`
}

// ScoredEpisode wraps an EpisodeRecord with its distance score (0.0 to 2.0).
type ScoredEpisode struct {
	Record   EpisodeRecord `json:"Record"`
	Body     string        `json:"Body"`
	Distance float32       `json:"Distance"`
	Score    float32       `json:"Score"` // Final re-ranked score
}

// Watermark tracks the ingestion progress in the session.
type Watermark struct {
	DateSeq  string `json:"dateSeq"`
	AbsIndex uint32 `json:"absIndex"`
}

type Store struct {
	db         *pebble.DB
	graph      *hnsw.Hnsw
	mutex      sync.RWMutex
	maxID      uint32
	IsRefining atomic.Bool
}

// Prefix bytes for Pebble keys
var (
	prefixEp  = []byte("ep:")
	prefixS2I = []byte("s2i:")
	prefixI2S = []byte("i2s:")
	keyMaxID     = []byte("meta:maxid")
	keyWatermark = []byte("meta:watermark")
)


func NewStore(dbDir string) (*Store, error) {
	if err := os.MkdirAll(dbDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create vector db dir: %w", err)
	}

	dbPath := filepath.Join(dbDir, "vector.db")
	db, err := pebble.Open(dbPath, &pebble.Options{})
	if err != nil {
		errStr := strings.ToLower(err.Error())
		if strings.Contains(errStr, "lock") || strings.Contains(errStr, "resource temporarily unavailable") || strings.Contains(errStr, "being used by another process") || strings.Contains(errStr, "in use") {
			log.Printf("[Store] ❌ Pebble DB is locked (another instance running or dirty shutdown). Aborting to prevent API limit burst: %v", err)
			return nil, fmt.Errorf("pebble db is locked: %w", err)
		}

		log.Printf("[Store] ⚠️ Pebble DB corrupted or incompatible: %v", err)
		corruptedPath := dbPath + ".corrupted." + time.Now().Format("20060102-150405")
		log.Printf("[Store] 🗑️ Isolating corrupted DB: %s → %s", dbPath, corruptedPath)
		if renameErr := os.Rename(dbPath, corruptedPath); renameErr != nil {
			return nil, fmt.Errorf("db corrupted and isolation failed: %w", renameErr)
		}
		log.Printf("[Store] 🔄 Opening fresh DB (rebuild required)...")
		db, err = pebble.Open(dbPath, &pebble.Options{})
		if err != nil {
			return nil, fmt.Errorf("failed to open fresh pebble db after cleanup: %w", err)
		}
	}

	// M=32, efConstruction=200, dimensionality=3072, no random seed
	graph := hnsw.New(32, 200, make([]float32, 3072))

	store := &Store{
		db:    db,
		graph: graph,
		maxID: 0,
	}

	if err := store.loadIndexFromPebble(); err != nil {
		return nil, fmt.Errorf("failed to load hnsw index from pebble: %w", err)
	}

	return store, nil
}

// Count returns the number of episode records currently stored.
// Used to detect an empty (freshly rebuilt or corrupted) store.
func (s *Store) Count() int {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	return int(s.maxID)
}

func (s *Store) loadIndexFromPebble() error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	// Load max id
	val, closer, err := s.db.Get(keyMaxID)
	if err == nil {
		if len(val) == 4 {
			s.maxID = binary.BigEndian.Uint32(val)
		}
		closer.Close()
	} else if err != pebble.ErrNotFound {
		return err
	}

	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: prefixEp,
		UpperBound: []byte("ep;"), // ; is after :
	})
	if err != nil {
		return err
	}
	defer iter.Close()

	count := 0
	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err == nil {
			
			// Find its uint32 id
			s2iKey := append(append([]byte(nil), prefixS2I...), []byte(rec.ID)...)
			idVal, idCloser, err := s.db.Get(s2iKey)
			if err == nil {
				uid := binary.BigEndian.Uint32(idVal)
				idCloser.Close()

				s.graph.Grow(int(uid))
				s.graph.Add(hnsw.Point(rec.Vector), uid)
				count++
			}
		}
	}

	fmt.Printf("[Episodic-Core] Vector store initialized: loaded %d vectors into HNSW\n", count)
	return nil
}

func (s *Store) getNextID() (uint32, error) {
	s.maxID++
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, s.maxID)
	if err := s.db.Set(keyMaxID, buf, pebble.Sync); err != nil {
		return 0, err
	}
	return s.maxID, nil
}

func (s *Store) Add(ctx context.Context, rec EpisodeRecord) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	// 1. Get or Create uint32 ID mapping
	s2iKey := append(append([]byte(nil), prefixS2I...), []byte(rec.ID)...)
	var uid uint32
	
	val, closer, err := s.db.Get(s2iKey)
	switch err {
	case pebble.ErrNotFound:
		uid, err = s.getNextID()
		if err != nil {
			return err
		}
		
		uidBuf := make([]byte, 4)
		binary.BigEndian.PutUint32(uidBuf, uid)
		
		// write map
		s.db.Set(s2iKey, uidBuf, pebble.NoSync)
		
		i2sKey := append(append([]byte(nil), prefixI2S...), uidBuf...)
		s.db.Set(i2sKey, []byte(rec.ID), pebble.NoSync)
		
	case nil:
		uid = binary.BigEndian.Uint32(val)
		closer.Close()
	default:
		return err
	}

	// 2. Write Episode Record
	data, err := msgpack.Marshal(&rec)
	if err != nil {
		return fmt.Errorf("failed to marshal record: %w", err)
	}

	epKey := append(append([]byte(nil), prefixEp...), []byte(rec.ID)...)
	if err := s.db.Set(epKey, data, pebble.Sync); err != nil {
		return fmt.Errorf("failed to write to pebble: %w", err)
	}

	// 3. Add to HNSW
	// Ensure uniform dimensionality (3072 for gemini-embedding-2-preview default)
	if len(rec.Vector) != 3072 {
		return fmt.Errorf("vector length mismatch: expected 3072, got %d", len(rec.Vector))
	}
	s.graph.Grow(int(uid))
	s.graph.Add(hnsw.Point(rec.Vector), uid)

	return nil
}

func (s *Store) Clear() error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	iter, err := s.db.NewIter(nil)
	if err != nil {
		return err
	}
	defer iter.Close()

	batch := s.db.NewBatch()
	for iter.First(); iter.Valid(); iter.Next() {
		batch.Delete(iter.Key(), nil)
	}
	if err := batch.Commit(pebble.Sync); err != nil {
		return err
	}

	s.graph = hnsw.New(32, 200, make([]float32, 3072))
	s.maxID = 0
	return nil
}

func (s *Store) Get(id string) (*EpisodeRecord, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	epKey := append(append([]byte(nil), prefixEp...), []byte(id)...)
	val, closer, err := s.db.Get(epKey)
	if err != nil {
		return nil, err
	}
	defer closer.Close()

	var rec EpisodeRecord
	if err := msgpack.Unmarshal(val, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// ListByTag returns all episode records that contain a specific tag.
func (s *Store) ListByTag(tag string) ([]EpisodeRecord, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: prefixEp,
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		return nil, err
	}
	defer iter.Close()

	var results []EpisodeRecord
	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err == nil {
			for _, t := range rec.Tags {
				if t == tag {
					results = append(results, rec)
					break
				}
			}
		}
	}
	return results, nil
}

// Delete completely removes the episode ID and its mappings from Pebble.
func (s *Store) Delete(id string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	epKey := append(append([]byte(nil), prefixEp...), []byte(id)...)
	s2iKey := append(append([]byte(nil), prefixS2I...), []byte(id)...)

	// Fetch uint32 ID to delete i2s mapping
	if uidBuf, closer, err := s.db.Get(s2iKey); err == nil {
		i2sKey := append(append([]byte(nil), prefixI2S...), uidBuf...)
		s.db.Delete(i2sKey, pebble.Sync)
		closer.Close()
	}

	if err := s.db.Delete(epKey, pebble.Sync); err != nil {
		return err
	}
	if err := s.db.Delete(s2iKey, pebble.Sync); err != nil {
		return err
	}

	// Note: Go-HNSW does not natively support node deletion from its in-memory graph.
	// The node (uid) remains in the graph, but `Recall()` will gracefully skip it
	// because `GetIDByUint32` or `Get(id)` will return `pebble.ErrNotFound`.
	return nil
}

// UpdateRecord safely modifies an existing record.
func (s *Store) UpdateRecord(id string, mutator func(*EpisodeRecord) error) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	epKey := append(append([]byte(nil), prefixEp...), []byte(id)...)
	val, closer, err := s.db.Get(epKey)
	if err != nil {
		return fmt.Errorf("record not found: %w", err)
	}
	
	var rec EpisodeRecord
	if err := msgpack.Unmarshal(val, &rec); err != nil {
		closer.Close()
		return fmt.Errorf("failed to unmarshal: %w", err)
	}
	closer.Close()

	if err := mutator(&rec); err != nil {
		return fmt.Errorf("mutator failed: %w", err)
	}

	data, err := msgpack.Marshal(&rec)
	if err != nil {
		return fmt.Errorf("failed to marshal updated record: %w", err)
	}

	return s.db.Set(epKey, data, pebble.Sync)
}

func (s *Store) GetIDByUint32(uid uint32) (string, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	uidBuf := make([]byte, 4)
	binary.BigEndian.PutUint32(uidBuf, uid)
	i2sKey := append(append([]byte(nil), prefixI2S...), uidBuf...)
	
	val, closer, err := s.db.Get(i2sKey)
	if err != nil {
		return "", err
	}
	defer closer.Close()
	
	return string(val), nil
}

func (s *Store) GetWatermark() (Watermark, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	val, closer, err := s.db.Get(keyWatermark)
	if err != nil {
		if err == pebble.ErrNotFound {
			// Default watermark if none exists
			return Watermark{DateSeq: "", AbsIndex: 0}, nil
		}
		return Watermark{}, err
	}
	defer closer.Close()

	var wm Watermark
	if err := json.Unmarshal(val, &wm); err != nil {
		return Watermark{}, err
	}
	return wm, nil
}

func (s *Store) SetWatermark(wm Watermark) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	data, err := json.Marshal(wm)
	if err != nil {
		return err
	}
	return s.db.Set(keyWatermark, data, pebble.Sync)
}

func (s *Store) SetMeta(key string, value []byte) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	metaKey := append([]byte("meta:"), []byte(key)...)
	return s.db.Set(metaKey, value, pebble.Sync)
}

func (s *Store) GetRawMeta(key []byte) ([]byte, io.Closer, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	
	// Ensure the key starts with "meta:" if it's not already
	// However, checkSleepThreshold already prefix "meta:" in "meta:last_activity" bytes.
	// But checkSleepThreshold passes []byte("meta:last_activity")
	
	val, closer, err := s.db.Get(key)
	return val, closer, err
}

type rawScore struct {
	uid  uint32
	dist float32
}

func (s *Store) Recall(queryVector []float32, topK int, now time.Time) ([]ScoredEpisode, error) {
	if len(queryVector) != 3072 {
		return nil, fmt.Errorf("query vector length mismatch: expected 3072, got %d", len(queryVector))
	}

	s.mutex.RLock()
	// go-hnsw Search parameters: Query Point, ef (search depth, ~topK*2 or more), K
	pq := s.graph.Search(hnsw.Point(queryVector), topK*2, topK*2)

	var candidates []rawScore
	for pq.Len() > 0 {
		item := pq.Pop()
		candidates = append(candidates, rawScore{uid: uint32(item.ID), dist: item.D})
	}
	s.mutex.RUnlock()

	var scored []ScoredEpisode
	
	for _, cand := range candidates {
		idStr, err := s.GetIDByUint32(cand.uid)
		if err != nil {
			continue
		}
		
		rec, err := s.Get(idStr)
		if err != nil {
			continue
		}

		// Filter out archived nodes (Pattern Separation)
		isArchived := false
		for _, tag := range rec.Tags {
			if tag == "archived" {
				isArchived = true
				break
			}
		}
		if isArchived {
			continue
		}

		// distance returned by Bithack is actually L2 squared
		sim := float32(1.0 / (1.0 + cand.dist))
		
		// Temporal penalty
		daysOld := now.Sub(rec.Timestamp).Hours() / 24.0
		if daysOld < 0 { daysOld = 0 }
		
		penalty := float32(daysOld / 30.0 * 0.01)
		if penalty > 0.20 { penalty = 0.20 }

		finalScore := sim * (1.0 - penalty)

		doc, docErr := frontmatter.Parse(rec.SourcePath)
		body := ""
		if docErr == nil {
			body = doc.Body
		}

		scored = append(scored, ScoredEpisode{
			Record:   *rec,
			Body:     body,
			Distance: float32(cand.dist),
			Score:    finalScore,
		})
	}

	sort.Slice(scored, func(i, j int) bool {
		return scored[i].Score > scored[j].Score // descending score
	})

	if len(scored) > topK {
		scored = scored[:topK]
	}

	return scored, nil
}

// GraphResult is a search result from the HNSW graph.
type GraphResult struct {
	ID   uint32
	Dist float32
}

// SearchGraph performs a thread-safe HNSW graph search.
// It acquires RLock for the duration of the search, preventing data races
// with concurrent Ingest calls that take a Write lock.
func (s *Store) SearchGraph(query []float32, ef, k int) []GraphResult {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	pq := s.graph.Search(hnsw.Point(query), ef, k)
	results := make([]GraphResult, 0, pq.Len())
	for pq.Len() > 0 {
		item := pq.Pop()
		results = append(results, GraphResult{ID: uint32(item.ID), Dist: item.D})
	}
	return results
}

func (s *Store) Close() error {
	return s.db.Close()
}
