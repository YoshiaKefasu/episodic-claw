package vector

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Bithack/go-hnsw"
	"github.com/cockroachdb/pebble"
	"github.com/vmihailenco/msgpack/v5"
	"github.com/blevesearch/bleve/v2"

	"episodic-core/frontmatter"
)

// EpisodeRecord encapsulates metadata and the raw embedding for persistent storage.
type EpisodeRecord struct {
	ID                   string             `json:"id" msgpack:"id"`
	Title                string             `json:"title" msgpack:"title"`
	Tags                 []string           `json:"tags" msgpack:"tags"`
	Topics               []string           `json:"topics,omitempty" msgpack:"topics,omitempty"`
	Timestamp            time.Time          `json:"timestamp" msgpack:"timestamp"`
	Edges                []frontmatter.Edge `json:"edges" msgpack:"edges"`
	Vector               []float32          `json:"vector" msgpack:"vector"`
	SourcePath           string             `json:"path" msgpack:"path"`
	Depth                int                `json:"depth,omitempty" msgpack:"depth,omitempty"`
	Tokens               int                `json:"tokens,omitempty" msgpack:"tokens,omitempty"`
	Surprise             float64            `json:"surprise" msgpack:"surprise"`
	Retrievals           int                `json:"retrievals,omitempty" msgpack:"retrievals,omitempty"`
	Hits                 int                `json:"hits,omitempty" msgpack:"hits,omitempty"`
	Alpha                float32            `json:"alpha,omitempty" msgpack:"alpha,omitempty"`
	Beta                 float32            `json:"beta,omitempty" msgpack:"beta,omitempty"`
	LastRetrievedAt      time.Time          `json:"last_retrieved_at,omitempty" msgpack:"last_retrieved_at,omitempty"`
	LastHitAt            time.Time          `json:"last_hit_at,omitempty" msgpack:"last_hit_at,omitempty"`
	RecallShownCount     int                `json:"recall_shown_count,omitempty" msgpack:"recall_shown_count,omitempty"`
	RecallTopRankBest    int                `json:"recall_top_rank_best,omitempty" msgpack:"recall_top_rank_best,omitempty"`
	ExpandCount          int                `json:"expand_count,omitempty" msgpack:"expand_count,omitempty"`
	DirectGoodCount      int                `json:"direct_good_count,omitempty" msgpack:"direct_good_count,omitempty"`
	MissCount            int                `json:"miss_count,omitempty" msgpack:"miss_count,omitempty"`
	LastRecalledAt       time.Time          `json:"last_recalled_at,omitempty" msgpack:"last_recalled_at,omitempty"`
	LastExpandedAt       time.Time          `json:"last_expanded_at,omitempty" msgpack:"last_expanded_at,omitempty"`
	ReplaySelectedCount  int                `json:"replay_selected_count,omitempty" msgpack:"replay_selected_count,omitempty"`
	ReplayReviewedCount  int                `json:"replay_reviewed_count,omitempty" msgpack:"replay_reviewed_count,omitempty"`
	ReplayNoReviewCount  int                `json:"replay_no_review_count,omitempty" msgpack:"replay_no_review_count,omitempty"`
	BudgetSkipCount      int                `json:"budget_skip_count,omitempty" msgpack:"budget_skip_count,omitempty"`
	LastReplayAt         time.Time          `json:"last_replay_at,omitempty" msgpack:"last_replay_at,omitempty"`
	LastReplaySkipReason string             `json:"last_replay_skip_reason,omitempty" msgpack:"last_replay_skip_reason,omitempty"`
	DueLagSecondsLast    int64              `json:"due_lag_seconds_last,omitempty" msgpack:"due_lag_seconds_last,omitempty"`
	DueLagSecondsMax     int64              `json:"due_lag_seconds_max,omitempty" msgpack:"due_lag_seconds_max,omitempty"`
	LastDueAt            time.Time          `json:"last_due_at,omitempty" msgpack:"last_due_at,omitempty"`
	// Phase 2: Hippocampus Scoring
	ImportanceScore      float32            `json:"importance_score,omitempty" msgpack:"importance_score,omitempty"`
	NoiseScore           float32            `json:"noise_score,omitempty" msgpack:"noise_score,omitempty"`
	PruneState           string             `json:"prune_state,omitempty" msgpack:"prune_state,omitempty"`
	CanonicalParent      string             `json:"canonical_parent,omitempty" msgpack:"canonical_parent,omitempty"`
	LastScoredAt         time.Time          `json:"last_scored_at,omitempty" msgpack:"last_scored_at,omitempty"`
	TombstonedAt         time.Time          `json:"tombstoned_at,omitempty" msgpack:"tombstoned_at,omitempty"`

	// ContentHash is the first 16 hex chars of SHA-256 over the MD body.
	// Used by Smart Dedup to skip re-embedding when the body has not changed.
	ContentHash          string             `json:"content_hash,omitempty" msgpack:"content_hash,omitempty"`
}

// RecallCalibration tunes the recall rerank without changing the core retrieval path.
// Nil fields fall back to the built-in defaults so old callers keep working.
type RecallCalibration struct {
	SemanticFloor                *float32 `json:"semanticFloor,omitempty"`
	UsefulnessClamp              *float32 `json:"usefulnessClamp,omitempty"`
	ReplayTieBreakMaxBoost       *float32 `json:"replayTieBreakMaxBoost,omitempty"`
	ReplayLowRetrievabilityBonus *float32 `json:"replayLowRetrievabilityBonus,omitempty"`
	TopicsMatchBoost             *float32 `json:"topicsMatchBoost,omitempty"`
	TopicsMismatchPenalty        *float32 `json:"topicsMismatchPenalty,omitempty"`
	TopicsMissingPenalty         *float32 `json:"topicsMissingPenalty,omitempty"`
	LexicalTopK                  *int     `json:"lexicalTopK,omitempty"`
}

// ScoredEpisode wraps an EpisodeRecord with its distance score (0.0 to 2.0).
type ScoredEpisode struct {
	Record              EpisodeRecord `json:"Record"`
	Body                string        `json:"Body"`
	Distance            float32       `json:"Distance"`
	Score               float32       `json:"Score"` // Final re-ranked score
	SemanticScore       float32       `json:"semanticScore,omitempty"`
	BM25Score           float32       `json:"bm25Score,omitempty"`
	FreshnessScore      float32       `json:"freshnessScore,omitempty"`
	SurpriseScore       float32       `json:"surpriseScore,omitempty"`
	UsefulnessScore     float32       `json:"usefulnessScore,omitempty"`
	ExplorationScore    float32       `json:"explorationScore,omitempty"`
	ReplayTieBreakScore float32       `json:"replayTieBreakScore,omitempty"`
	TopicsMode          string        `json:"topicsMode,omitempty"`
	TopicsState         string        `json:"topicsState,omitempty"`
	TopicsMatchCount    int           `json:"topicsMatchCount,omitempty"`
	TopicsFallback      bool          `json:"topicsFallback,omitempty"`
	CandidateRank       int           `json:"candidateRank,omitempty"`
	Rank                int           `json:"rank,omitempty"`
}

// Watermark tracks the ingestion progress in the session.
type Watermark struct {
	DateSeq  string `json:"dateSeq"`
	AbsIndex uint32 `json:"absIndex"`
}

type StoreConfig struct {
	TombstoneTTL       int // days
	LexicalFilterLimit int // max items from bleve
}

type Store struct {
	config        StoreConfig
	db            *pebble.DB
	graph         *hnsw.Hnsw
	topicIndex    map[string]map[string]struct{}
	activeD0Index map[string]time.Time
	lexical       bleve.Index
	lexicalCancel context.CancelFunc
	mutex         sync.RWMutex
	maxID         uint32
	IsRefining    atomic.Bool
}

// Prefix bytes for Pebble keys
var (
	prefixEp     = []byte("ep:")
	prefixS2I    = []byte("s2i:")
	prefixI2S    = []byte("i2s:")
	prefixP2I    = []byte("p2i:") // path to UUID mapping for physical deletion
	prefixLexQ   = []byte("sys_lexq:")
	keyMaxID     = []byte("meta:maxid")
	keyWatermark = []byte("meta:watermark")
)

func NewStore(dbDir string, cfg StoreConfig) (*Store, error) {
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

	lexicalIdx, err := openLexicalIndex(dbDir)
	if err != nil {
		return nil, fmt.Errorf("failed to open lexical index: %w", err)
	}

	lexCtx, lexCancel := context.WithCancel(context.Background())

	store := &Store{
		config:        cfg,
		db:            db,
		graph:         graph,
		topicIndex:    make(map[string]map[string]struct{}),
		activeD0Index: make(map[string]time.Time),
		lexical:       lexicalIdx,
		lexicalCancel: lexCancel,
		maxID:         0,
	}

	go store.lexicalWorker(lexCtx)

	if err := store.loadIndexFromPebble(); err != nil {
		return nil, fmt.Errorf("failed to load hnsw index from pebble: %w", err)
	}

	// Trigger background cleanup and migration
	store.CleanOrphans()

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

	s.topicIndex = make(map[string]map[string]struct{})
	s.activeD0Index = make(map[string]time.Time)

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
				s.addToTopicIndexLocked(rec)
				s.addToActiveD0IndexLocked(rec)
				count++
			}
		}
	}

	fmt.Printf("[Episodic-Core] Vector store initialized: loaded %d vectors into HNSW\n", count)
	return nil
}

// CleanOrphans scans the storage for any episodes whose SourcePath no longer exists on the filesystem,
// and removes them. Additionally, it ensures the p2i reverse index is populated for existing files.
func (s *Store) CleanOrphans() {
	go func() {
		s.mutex.RLock()
		iter, err := s.db.NewIter(&pebble.IterOptions{
			LowerBound: prefixEp,
			UpperBound: []byte("ep;"),
		})
		s.mutex.RUnlock()

		if err != nil {
			log.Printf("[Store] Orphan cleanup failed to initialize iter: %v", err)
			return
		}
		defer iter.Close()

		var toDelete []string
		var toMigrate []EpisodeRecord

		for iter.First(); iter.Valid(); iter.Next() {
			var rec EpisodeRecord
			if err := msgpack.Unmarshal(iter.Value(), &rec); err == nil && rec.SourcePath != "" {
				if _, statErr := os.Stat(rec.SourcePath); os.IsNotExist(statErr) {
					// Ghost record found
					toDelete = append(toDelete, string(rec.ID))
				} else {
					// File exists, let's make sure its p2i index is there (migration)
					toMigrate = append(toMigrate, rec)
				}
			}
		}

		// Now apply changes outside the global scan iterator
		if len(toDelete) > 0 {
			log.Printf("[Store] Orphan cleanup: found %d ghost records, deleting...", len(toDelete))
			for _, id := range toDelete {
				s.Delete(id) // leverages the new pebble.Batch atomic deletion
			}
		}

		// Perform p2i migration for legacy records
		migrated := 0
		for _, rec := range toMigrate {
			normalizedPath := filepath.ToSlash(filepath.Clean(rec.SourcePath))
			p2iKey := append(append([]byte(nil), prefixP2I...), []byte(normalizedPath)...)

			s.mutex.RLock()
			_, closer, getErr := s.db.Get(p2iKey)
			s.mutex.RUnlock()

			switch getErr {
			case pebble.ErrNotFound:
				// Needs migration
				s.mutex.Lock()
				s.db.Set(p2iKey, []byte(rec.ID), pebble.NoSync)
				s.mutex.Unlock()
				migrated++
			case nil:
				closer.Close()
			}
		}
		if migrated > 0 {
			log.Printf("[Store] Orphan cleanup: migrated %d existing records to include p2i reverse index.", migrated)
		}
	}()
}


// enqueueSysLexq writes a lexical queue task directly into PebbleDB to guarantee processing.
func (s *Store) enqueueSysLexq(batch *pebble.Batch, action string, recordID string) {
	key := []byte(fmt.Sprintf("sys_lexq:%d:%s", time.Now().UnixNano(), recordID))
	val := []byte(action)
	if batch != nil {
		_ = batch.Set(key, val, nil)
	} else {
		_ = s.db.Set(key, val, pebble.NoSync)
	}
}

func (s *Store) getNextID(batch *pebble.Batch) (uint32, error) {
	s.maxID++
	buf := make([]byte, 4)
	binary.BigEndian.PutUint32(buf, s.maxID)
	if batch != nil {
		if err := batch.Set(keyMaxID, buf, nil); err != nil {
			return 0, err
		}
	} else {
		if err := s.db.Set(keyMaxID, buf, pebble.Sync); err != nil {
			return 0, err
		}
	}
	return s.maxID, nil
}

func (s *Store) Add(ctx context.Context, rec EpisodeRecord) error {
	// Initialize / Update Phase 2.1 Stage 1 score before hitting DB
	CalculateImportanceStage1(&rec)

	s.mutex.Lock()
	defer s.mutex.Unlock()

	batch := s.db.NewBatch()
	defer batch.Close()

	// 1. Get or Create uint32 ID mapping
	s2iKey := append(append([]byte(nil), prefixS2I...), []byte(rec.ID)...)
	var uid uint32
	var oldRec *EpisodeRecord

	val, closer, err := s.db.Get(s2iKey)
	switch err {
	case pebble.ErrNotFound:
		uid, err = s.getNextID(batch)
		if err != nil {
			return err
		}
		uidBuf := make([]byte, 4)
		binary.BigEndian.PutUint32(uidBuf, uid)
		batch.Set(s2iKey, uidBuf, nil)
		i2sKey := append(append([]byte(nil), prefixI2S...), uidBuf...)
		batch.Set(i2sKey, []byte(rec.ID), nil)

	case nil:
		uid = binary.BigEndian.Uint32(val)
		closer.Close()
		if existing, oCloser, oErr := s.db.Get(append(append([]byte(nil), prefixEp...), []byte(rec.ID)...)); oErr == nil {
			var prev EpisodeRecord
			if uErr := msgpack.Unmarshal(existing, &prev); uErr == nil {
				oldRec = &prev
			}
			oCloser.Close()
		}
	default:
		return err
	}

	// 2. Write Episode Record
	data, err := msgpack.Marshal(&rec)
	if err != nil {
		return fmt.Errorf("failed to marshal record: %w", err)
	}

	epKey := append(append([]byte(nil), prefixEp...), []byte(rec.ID)...)
	batch.Set(epKey, data, nil)

	if rec.SourcePath != "" {
		normalizedPath := filepath.ToSlash(filepath.Clean(rec.SourcePath))
		p2iKey := append(append([]byte(nil), prefixP2I...), []byte(normalizedPath)...)
		batch.Set(p2iKey, []byte(rec.ID), nil)
	}

	s.enqueueSysLexq(batch, "ADD", rec.ID)

	if err := batch.Commit(pebble.Sync); err != nil {
		return fmt.Errorf("failed to commit to pebble: %w", err)
	}

	if len(rec.Vector) != 3072 {
		return fmt.Errorf("vector length mismatch: expected 3072, got %d", len(rec.Vector))
	}
	s.graph.Grow(int(uid))
	s.graph.Add(hnsw.Point(rec.Vector), uid)
	s.refreshTopicIndexLocked(oldRec, &rec)
	s.refreshActiveD0IndexLocked(oldRec, &rec)

	return nil
}

// BatchAdd atomically adds or updates multiple records in one transaction.
func (s *Store) BatchAdd(ctx context.Context, records []EpisodeRecord) error {
	if len(records) == 0 {
		return nil
	}
	
	for i := range records {
		CalculateImportanceStage1(&records[i])
	}

	s.mutex.Lock()
	defer s.mutex.Unlock()

	batch := s.db.NewBatch()
	defer batch.Close()

	var newUids []uint32
	needNewID := 0

	for _, rec := range records {
		s2iKey := append(append([]byte(nil), prefixS2I...), []byte(rec.ID)...)
		_, closer, err := s.db.Get(s2iKey)
		switch err {
		case pebble.ErrNotFound:
			needNewID++
		case nil:
			closer.Close()
		}
	}

	if needNewID > 0 {
		startID := s.maxID + 1
		s.maxID += uint32(needNewID)
		buf := make([]byte, 4)
		binary.BigEndian.PutUint32(buf, s.maxID)
		batch.Set(keyMaxID, buf, nil)

		newUids = make([]uint32, needNewID)
		for i := 0; i < needNewID; i++ {
			newUids[i] = startID + uint32(i)
		}
	}

	type memOp struct {
		uid    uint32
		record EpisodeRecord
		oldRec *EpisodeRecord
	}
	var ops []memOp
	uidIdx := 0

	for _, rec := range records {
		s2iKey := append(append([]byte(nil), prefixS2I...), []byte(rec.ID)...)
		var uid uint32
		var oldRec *EpisodeRecord

		val, closer, err := s.db.Get(s2iKey)
		switch err {
		case pebble.ErrNotFound:
			uid = newUids[uidIdx]
			uidIdx++
			uidBuf := make([]byte, 4)
			binary.BigEndian.PutUint32(uidBuf, uid)

			batch.Set(s2iKey, uidBuf, nil)
			i2sKey := append(append([]byte(nil), prefixI2S...), uidBuf...)
			batch.Set(i2sKey, []byte(rec.ID), nil)
		case nil:
			uid = binary.BigEndian.Uint32(val)
			closer.Close()
			if existing, oCloser, oErr := s.db.Get(append(append([]byte(nil), prefixEp...), []byte(rec.ID)...)); oErr == nil {
				var prev EpisodeRecord
				if uErr := msgpack.Unmarshal(existing, &prev); uErr == nil {
					oldRec = &prev
				}
				oCloser.Close()
			}
		}

		data, err := msgpack.Marshal(&rec)
		if err != nil {
			return err
		}
		epKey := append(append([]byte(nil), prefixEp...), []byte(rec.ID)...)
		batch.Set(epKey, data, nil)

		if rec.SourcePath != "" {
			normalizedPath := filepath.ToSlash(filepath.Clean(rec.SourcePath))
			p2iKey := append(append([]byte(nil), prefixP2I...), []byte(normalizedPath)...)
			batch.Set(p2iKey, []byte(rec.ID), nil)
		}

		s.enqueueSysLexq(batch, "ADD", rec.ID)
		ops = append(ops, memOp{uid: uid, record: rec, oldRec: oldRec})
	}

	if err := batch.Commit(pebble.Sync); err != nil {
		return fmt.Errorf("failed to commit batch add: %w", err)
	}

	for i, op := range ops {
		if i > 0 && i%100 == 0 {
			// allow search queries to jump in during large ingestion
			s.mutex.Unlock()
			s.mutex.Lock()
		}
		s.graph.Grow(int(op.uid))
		s.graph.Add(hnsw.Point(op.record.Vector), op.uid)
		s.refreshTopicIndexLocked(op.oldRec, &op.record)
		s.refreshActiveD0IndexLocked(op.oldRec, &op.record)
	}

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
	s.topicIndex = make(map[string]map[string]struct{})
	s.activeD0Index = make(map[string]time.Time)
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

// ListByTopic returns all episode records that contain a specific topic.
// It prefers the reverse topic index and falls back to a scan only for legacy data.
func (s *Store) ListByTopic(topic string) ([]EpisodeRecord, error) {
	normalized, err := ValidateTopics([]string{topic})
	if err != nil || len(normalized) == 0 {
		return nil, nil
	}
	key := topicKey(normalized[0])

	s.mutex.RLock()
	ids := make([]string, 0)
	if set, ok := s.topicIndex[key]; ok {
		for id := range set {
			ids = append(ids, id)
		}
	}
	s.mutex.RUnlock()

	if len(ids) > 0 {
		results := make([]EpisodeRecord, 0, len(ids))
		s.mutex.RLock()
		for _, id := range ids {
			epKey := append(append([]byte(nil), prefixEp...), []byte(id)...)
			val, closer, err := s.db.Get(epKey)
			if err != nil {
				continue
			}
			var rec EpisodeRecord
			if uErr := msgpack.Unmarshal(val, &rec); uErr == nil {
				results = append(results, rec)
			}
			closer.Close()
		}
		s.mutex.RUnlock()
		return results, nil
	}

	// Legacy fallback: scan the store when the reverse index has not been hydrated yet.
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

	results := make([]EpisodeRecord, 0)
	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		if recordHasTopic(rec, normalized[0]) {
			results = append(results, rec)
		}
	}
	return results, nil
}

// Delete completely removes the episode ID and its mappings from Pebble atomically.
func (s *Store) Delete(id string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.deleteLocked(id)
}

// GetByPath fetches an EpisodeRecord by its SourcePath using the p2i reverse index.
// Returns the record and nil error on success, or an error (including pebble.ErrNotFound) on failure.
func (s *Store) GetByPath(path string) (*EpisodeRecord, error) {
	if path == "" {
		return nil, fmt.Errorf("empty path")
	}
	normalizedPath := filepath.ToSlash(filepath.Clean(path))

	s.mutex.RLock()
	defer s.mutex.RUnlock()

	p2iKey := append(append([]byte(nil), prefixP2I...), []byte(normalizedPath)...)
	idBytes, closer, err := s.db.Get(p2iKey)
	if err != nil {
		return nil, err
	}
	idStr := string(idBytes)
	closer.Close()

	return s.Get(idStr)
}

// DeleteByPath removes an episode physically by its SourcePath using the p2i reverse index.
func (s *Store) DeleteByPath(path string) error {
	if path == "" {
		return nil
	}
	normalizedPath := filepath.ToSlash(filepath.Clean(path))
	
	s.mutex.Lock()
	defer s.mutex.Unlock()

	p2iKey := append(append([]byte(nil), prefixP2I...), []byte(normalizedPath)...)
	idBytes, closer, err := s.db.Get(p2iKey)
	if err != nil {
		if err == pebble.ErrNotFound {
			return nil // Already deleted or doesn't exist
		}
		return err
	}
	idStr := string(idBytes)
	closer.Close()
	
	return s.deleteLocked(idStr)
}

// DeleteByPaths provides a bulk, atomic removal of multiple episodes by their SourcePaths.
// IMPORTANT: It checks physical existence using os.Stat before deletion to guard against RENAME ADD/DELETE ordering issues.
func (s *Store) DeleteByPaths(paths []string) error {
	if len(paths) == 0 {
		return nil
	}

	for _, p := range paths {
		if p == "" {
			continue
		}

		// [STAT GUARD] Check if file actually exists.
		// If it exists, it means a bogus or out-of-order DELETE event arrived (e.g., from an atomic save/rename).
		// We skip deleting from the DB to preserve the record.
		if _, err := os.Stat(p); err == nil {
			log.Printf("[Sync-Guard] Skipped deletion for %s (file physically exists)", p)
			continue
		}

		// Proceed with deletion since file is truly gone.
		if err := s.DeleteByPath(p); err != nil {
			log.Printf("[Store] Batch delete failed for %s: %v", p, err)
		}
	}

	return nil
}

func (s *Store) deleteLocked(id string) error {
	epKey := append(append([]byte(nil), prefixEp...), []byte(id)...)
	s2iKey := append(append([]byte(nil), prefixS2I...), []byte(id)...)
	var oldRec *EpisodeRecord

	if val, closer, err := s.db.Get(epKey); err == nil {
		var rec EpisodeRecord
		if uErr := msgpack.Unmarshal(val, &rec); uErr == nil {
			oldRec = &rec
		}
		closer.Close()
	}

	batch := s.db.NewBatch()
	defer batch.Close()

	// Fetch uint32 ID to delete i2s mapping
	if uidBuf, closer, err := s.db.Get(s2iKey); err == nil {
		i2sKey := append(append([]byte(nil), prefixI2S...), uidBuf...)
		batch.Delete(i2sKey, nil)
		closer.Close()
	}

	batch.Delete(epKey, nil)
	batch.Delete(s2iKey, nil)
	batch.Delete(replayStateKey(id), nil)
	batch.Delete(replayLeaseKey(id), nil)

	// Clean up reverse path index
	if oldRec != nil && oldRec.SourcePath != "" {
		normalizedPath := filepath.ToSlash(filepath.Clean(oldRec.SourcePath))
		p2iKey := append(append([]byte(nil), prefixP2I...), []byte(normalizedPath)...)
		batch.Delete(p2iKey, nil)
	}

	s.enqueueSysLexq(batch, "DELETE", id)

	if err := batch.Commit(pebble.Sync); err != nil {
		return err
	}

	if oldRec != nil {
		s.removeFromTopicIndexLocked(*oldRec)
		s.removeFromActiveD0IndexLocked(*oldRec)
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
	oldRec := rec

	if err := mutator(&rec); err != nil {
		return fmt.Errorf("mutator failed: %w", err)
	}

	data, err := msgpack.Marshal(&rec)
	if err != nil {
		return fmt.Errorf("failed to marshal updated record: %w", err)
	}

	batch := s.db.NewBatch()
	defer batch.Close()

	batch.Set(epKey, data, nil)
	s.enqueueSysLexq(batch, "UPDATE", id)

	if err := batch.Commit(pebble.Sync); err != nil {
		return err
	}
	s.refreshTopicIndexLocked(&oldRec, &rec)
	s.refreshActiveD0IndexLocked(&oldRec, &rec)

	return nil
}

// RecordRecall records that an episode was surfaced by recall.
// This keeps the usefulness posterior adaptive without requiring a separate feedback RPC.
func (s *Store) RecordRecall(id string, at time.Time, rank int) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	if at.IsZero() {
		at = time.Now()
	}
	return s.UpdateRecord(id, func(rec *EpisodeRecord) error {
		rec.Retrievals++
		rec.LastRetrievedAt = at
		rec.RecallShownCount++
		rec.LastRecalledAt = at
		if rank > 0 && (rec.RecallTopRankBest == 0 || rank < rec.RecallTopRankBest) {
			rec.RecallTopRankBest = rank
		}
		return nil
	})
}

// RecordHit records a stronger positive signal, typically when a recalled
// episode is explicitly expanded by the user.
func (s *Store) RecordHit(id string, at time.Time) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	if at.IsZero() {
		at = time.Now()
	}
	return s.UpdateRecord(id, func(rec *EpisodeRecord) error {
		rec.Hits++
		rec.LastHitAt = at
		rec.ExpandCount++
		rec.DirectGoodCount++
		rec.LastExpandedAt = at
		return nil
	})
}

// RecordReplaySelection marks that an episode was selected for replay scheduling.
func (s *Store) RecordReplaySelection(id string, at time.Time, dueLagSeconds int64) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	if at.IsZero() {
		at = time.Now()
	}
	return s.UpdateRecord(id, func(rec *EpisodeRecord) error {
		rec.ReplaySelectedCount++
		rec.LastReplayAt = at
		rec.LastDueAt = at
		rec.DueLagSecondsLast = dueLagSeconds
		if dueLagSeconds > rec.DueLagSecondsMax {
			rec.DueLagSecondsMax = dueLagSeconds
		}
		return nil
	})
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
	id   string
	dist float32
}

type recallWeights struct {
	semantic    float32
	lexical     float32
	freshness   float32
	surprise    float32
	usefulness  float32
	exploration float32
}

var defaultRecallWeights = recallWeights{
	semantic:    0.60,
	lexical:     0.10,
	freshness:   0.15,
	surprise:    0.05,
	usefulness:  0.08,
	exploration: 0.02,
}

func l2SquaredDistance(a, b []float32) float32 {
	if len(a) != len(b) {
		return 1000.0
	}
	var dist float32
	for i := range a {
		diff := a[i] - b[i]
		dist += diff * diff
	}
	return dist
}

func float32OrDefault(value *float32, fallback float32) float32 {
	if value != nil {
		return *value
	}
	return fallback
}

func intOrDefault(value *int, fallback int) int {
	if value != nil {
		return *value
	}
	return fallback
}

func (s *Store) Recall(queryVector []float32, topK int, now time.Time) ([]ScoredEpisode, error) {
	return s.baseRecall("", queryVector, topK, now, nil, true, nil)
}

func (s *Store) RecallWithTopics(queryVector []float32, topK int, now time.Time, topics []string) ([]ScoredEpisode, error) {
	// Backward-compatible default: topics means "strict facet filter".
	return s.baseRecall("", queryVector, topK, now, topics, true, nil)
}

func (s *Store) RecallWithTopicsMode(queryVector []float32, topK int, now time.Time, topics []string, strictTopics bool, calibration *RecallCalibration) ([]ScoredEpisode, error) {
	return s.baseRecall("", queryVector, topK, now, topics, strictTopics, calibration)
}

func (s *Store) RecallWithQuery(queryString string, queryVector []float32, topK int, now time.Time, topics []string, strictTopics bool, calibration *RecallCalibration) ([]ScoredEpisode, error) {
	return s.baseRecall(queryString, queryVector, topK, now, topics, strictTopics, calibration)
}

func (s *Store) baseRecall(queryString string, queryVector []float32, topK int, now time.Time, topics []string, strictTopics bool, calibration *RecallCalibration) ([]ScoredEpisode, error) {
	if len(queryVector) != 3072 {
		return nil, fmt.Errorf("query vector length mismatch: expected 3072, got %d", len(queryVector))
	}

	semanticFloor := float32(0.35)
	usefulnessClamp := float32(1.0)
	replayTieBreakMaxBoost := float32(0.04)
	replayLowRetrievabilityBonus := float32(0.01)
	topicsMatchBoost := float32(0.05)
	topicsMismatchPenalty := float32(0.10)
	topicsMissingPenalty := float32(0.0)
	lexicalTopK := s.config.LexicalFilterLimit
	if lexicalTopK <= 0 {
		lexicalTopK = 1000
	}
	if calibration != nil {
		semanticFloor = float32OrDefault(calibration.SemanticFloor, semanticFloor)
		usefulnessClamp = float32OrDefault(calibration.UsefulnessClamp, usefulnessClamp)
		replayTieBreakMaxBoost = float32OrDefault(calibration.ReplayTieBreakMaxBoost, replayTieBreakMaxBoost)
		replayLowRetrievabilityBonus = float32OrDefault(calibration.ReplayLowRetrievabilityBonus, replayLowRetrievabilityBonus)
		topicsMatchBoost = float32OrDefault(calibration.TopicsMatchBoost, topicsMatchBoost)
		topicsMismatchPenalty = float32OrDefault(calibration.TopicsMismatchPenalty, topicsMismatchPenalty)
		topicsMissingPenalty = float32OrDefault(calibration.TopicsMissingPenalty, topicsMissingPenalty)
		lexicalTopK = intOrDefault(calibration.LexicalTopK, lexicalTopK)
	}
	if usefulnessClamp <= 0 {
		usefulnessClamp = 1.0
	}
	if replayTieBreakMaxBoost < 0 {
		replayTieBreakMaxBoost = 0.04
	}
	if replayLowRetrievabilityBonus < 0 {
		replayLowRetrievabilityBonus = 0.01
	}
	if topicsMatchBoost < 0 {
		topicsMatchBoost = 0.05
	}
	if topicsMismatchPenalty < 0 {
		topicsMismatchPenalty = 0.10
	}
	if topicsMissingPenalty < 0 {
		topicsMissingPenalty = 0
	}
	if topicsMismatchPenalty > 0.95 {
		topicsMismatchPenalty = 0.95
	}
	if topicsMissingPenalty > 0.95 {
		topicsMissingPenalty = 0.95
	}

	filteredTopics, _ := ValidateTopics(topics)
	var allowedIDs map[string]struct{}
	topicsFallback := false
	if len(filteredTopics) > 0 && strictTopics {
		// Strict facet filter: fall back to a legacy scan when reverse index is not hydrated yet.
		allowedIDs = s.allowedIDsForTopics(filteredTopics, true)
		if len(allowedIDs) == 0 {
			// Fallback: if strict facet yields no matches (cold index / legacy data / sparse topics),
			// prefer returning vector candidates with a soft topic hint rather than returning empty.
			allowedIDs = nil
			strictTopics = false
			topicsFallback = true
		}
	}

	if topK <= 0 {
		topK = 5
	}
	candidateK := topK * 4
	if candidateK < 20 {
		candidateK = 20
	}
	if candidateK < topK {
		candidateK = topK
	}

	var candidates []rawScore
	var bm25Scores map[string]float32
	var maxBM25 float32

	if queryString != "" && s.lexical != nil {
		req := bleve.NewSearchRequest(bleve.NewMatchQuery(queryString))
		req.Size = lexicalTopK
		if res, err := s.lexical.Search(req); err == nil && res.Total > 0 {
			bm25Scores = make(map[string]float32)
			for _, hit := range res.Hits {
				if float32(hit.Score) > maxBM25 {
					maxBM25 = float32(hit.Score)
				}
				bm25Scores[hit.ID] = float32(hit.Score)
				candidates = append(candidates, rawScore{id: hit.ID, dist: -1})
			}
		} else if err != nil {
			log.Printf("[LexicalEngine] Search failed, falling back to HNSW: %v\n", err)
		}
	}

	if len(candidates) == 0 {
		s.mutex.RLock()
		pq := s.graph.Search(hnsw.Point(queryVector), candidateK*2, candidateK)
		for pq.Len() > 0 {
			item := pq.Pop()
			candidates = append(candidates, rawScore{uid: uint32(item.ID), dist: item.D})
		}
		s.mutex.RUnlock()
	}

	var scored []ScoredEpisode

	for candidateRank, cand := range candidates {
		var idStr string
		var err error

		if cand.id != "" {
			idStr = cand.id
		} else {
			idStr, err = s.GetIDByUint32(cand.uid)
			if err != nil {
				continue
			}
		}

		if allowedIDs != nil {
			if _, ok := allowedIDs[idStr]; !ok {
				continue
			}
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
		// ...
		// We'll trust the underlying implementation.

		if isArchived {
			continue
		}

		recordTopics := rec.Topics
		if len(recordTopics) == 0 {
			recordTopics = legacyTopicsFromTags(rec.Tags)
		}
		topicsPresent := len(recordTopics) > 0

		if cand.dist < 0 {
			cand.dist = l2SquaredDistance(queryVector, rec.Vector)
		}

		// Normalize BM25
		var bm25 float32
		if maxBM25 > 0 {
			bm25 = bm25Scores[idStr] / maxBM25
		}

		// distance returned by Bithack is actually L2 squared
		semanticScore := float32(1.0 / (1.0 + cand.dist))
		freshnessScore := freshnessScore(rec.Timestamp, now)
		usefulnessScore := usefulnessPosteriorMean(rec.Hits, rec.Retrievals, rec.Alpha, rec.Beta)
		if usefulnessScore > usefulnessClamp {
			usefulnessScore = usefulnessClamp
		}
		surpriseScore := surprisePriorScore(rec.Surprise)
		explorationScore := explorationBonus(rec.Retrievals)

		finalScore := (defaultRecallWeights.semantic * semanticScore) +
			(defaultRecallWeights.lexical * bm25) +
			(defaultRecallWeights.freshness * freshnessScore) +
			(defaultRecallWeights.surprise * surpriseScore) +
			(defaultRecallWeights.usefulness * usefulnessScore) +
			(defaultRecallWeights.exploration * explorationScore)

		// Phase 3.1 replay-state tie-breaker:
		// Keep it tiny and only apply when semantic relevance is already high, so replay cannot hijack recall.
		replayTieBreakScore := float32(0)
		if semanticScore >= semanticFloor {
			cls := classifyReplayRecord(*rec)
			if cls != replayClassD0 {
				if st, ok, stErr := s.GetReplayState(rec.ID); stErr == nil && ok && !st.DueAt.IsZero() && now.After(st.DueAt) {
					overdueHours := now.Sub(st.DueAt).Hours()
					// 0..24h overdue => partial boost, clamp hard so it stays a tie-breaker.
					dueBoost := float32(math.Min(float64(replayTieBreakMaxBoost), (overdueHours/24.0)*(float64(replayTieBreakMaxBoost)/2)))
					if st.Retrievability < 0.60 {
						dueBoost += replayLowRetrievabilityBonus
					}
					if dueBoost > replayTieBreakMaxBoost {
						dueBoost = replayTieBreakMaxBoost
					}
					replayTieBreakScore = dueBoost
					finalScore *= 1.0 + dueBoost
				}
			}
		}

		topicsMode := "none"
		topicsState := "none"
		topicsMatchCount := 0
		if len(filteredTopics) > 0 {
			if strictTopics {
				topicsMode = "strict"
			} else {
				topicsMode = "soft"
			}
			topicsMatchCount = matchedTopicCount(recordTopics, filteredTopics)
			if topicsMatchCount > 0 {
				topicsState = "matched"
				finalScore *= 1.0 + (float32(topicsMatchCount) * topicsMatchBoost)
			} else if !strictTopics {
				if topicsPresent {
					topicsState = "mismatch"
					if topicsMismatchPenalty > 0 {
						finalScore *= 1.0 - topicsMismatchPenalty
					}
				} else {
					topicsState = "missing"
					if topicsMissingPenalty > 0 {
						finalScore *= 1.0 - topicsMissingPenalty
					}
				}
			}
		}

		doc, docErr := frontmatter.Parse(rec.SourcePath)
		body := ""
		if docErr == nil {
			body = doc.Body
		}

		scored = append(scored, ScoredEpisode{
			Record:              *rec,
			Body:                body,
			Distance:            float32(cand.dist),
			Score:               finalScore,
			SemanticScore:       semanticScore,
			BM25Score:           bm25,
			FreshnessScore:      freshnessScore,
			SurpriseScore:       surpriseScore,
			UsefulnessScore:     usefulnessScore,
			ExplorationScore:    explorationScore,
			ReplayTieBreakScore: replayTieBreakScore,
			TopicsMode:          topicsMode,
			TopicsState:         topicsState,
			TopicsMatchCount:    topicsMatchCount,
			TopicsFallback:      topicsFallback,
			CandidateRank:       candidateRank + 1,
		})
	}

	sort.Slice(scored, func(i, j int) bool {
		return scored[i].Score > scored[j].Score // descending score
	})

	for i := range scored {
		scored[i].Rank = i + 1
	}

	if len(scored) > topK {
		scored = scored[:topK]
	}

	return scored, nil
}

func (s *Store) allowedIDsForTopics(topics []string, scanFallback bool) map[string]struct{} {
	// First, try the in-memory reverse index (fast path).
	s.mutex.RLock()
	allowed := make(map[string]struct{})
	for _, topic := range topics {
		key := topicKey(topic)
		if key == "" {
			continue
		}
		if set, ok := s.topicIndex[key]; ok {
			for id := range set {
				allowed[id] = struct{}{}
			}
		}
	}
	s.mutex.RUnlock()

	if len(allowed) > 0 || !scanFallback {
		return allowed
	}

	// Legacy fallback: scan the store only when the reverse index isn't hydrated yet.
	// This is intentionally expensive and only intended for explicit facet searches.
	for _, topic := range topics {
		recs, err := s.ListByTopic(topic)
		if err != nil {
			continue
		}
		for _, rec := range recs {
			if strings.TrimSpace(rec.ID) == "" {
				continue
			}
			allowed[rec.ID] = struct{}{}
		}
	}
	return allowed
}

func (s *Store) addToTopicIndexLocked(rec EpisodeRecord) {
	topics, _ := ValidateTopics(rec.Topics)
	if len(topics) == 0 {
		topics = legacyTopicsFromTags(rec.Tags)
	}
	if len(topics) == 0 {
		return
	}
	for _, topic := range topics {
		key := topicKey(topic)
		if key == "" {
			continue
		}
		bucket := s.topicIndex[key]
		if bucket == nil {
			bucket = make(map[string]struct{})
			s.topicIndex[key] = bucket
		}
		bucket[rec.ID] = struct{}{}
	}
}

func (s *Store) addToActiveD0IndexLocked(rec EpisodeRecord) {
	if !isActiveD0Record(rec) {
		return
	}
	if s.activeD0Index == nil {
		s.activeD0Index = make(map[string]time.Time)
	}
	s.activeD0Index[rec.ID] = rec.Timestamp
}

func (s *Store) removeFromActiveD0IndexLocked(rec EpisodeRecord) {
	if s.activeD0Index == nil {
		return
	}
	delete(s.activeD0Index, rec.ID)
}

func (s *Store) refreshActiveD0IndexLocked(oldRec *EpisodeRecord, newRec *EpisodeRecord) {
	if oldRec != nil {
		s.removeFromActiveD0IndexLocked(*oldRec)
	}
	if newRec != nil {
		s.addToActiveD0IndexLocked(*newRec)
	}
}

func (s *Store) SnapshotActiveD0Records() ([]EpisodeRecord, bool, error) {
	s.mutex.RLock()
	if len(s.activeD0Index) == 0 {
		s.mutex.RUnlock()
		return nil, false, nil
	}

	ids := make([]string, 0, len(s.activeD0Index))
	for id := range s.activeD0Index {
		ids = append(ids, id)
	}
	s.mutex.RUnlock()

	results := make([]EpisodeRecord, 0, len(ids))
	for _, id := range ids {
		rec, err := s.Get(id)
		if err != nil {
			continue
		}
		if isActiveD0Record(*rec) {
			results = append(results, *rec)
		}
	}

	sort.SliceStable(results, func(i, j int) bool {
		if results[i].Timestamp.Equal(results[j].Timestamp) {
			return results[i].ID < results[j].ID
		}
		return results[i].Timestamp.Before(results[j].Timestamp)
	})
	return results, true, nil
}

func (s *Store) removeFromTopicIndexLocked(rec EpisodeRecord) {
	topics, _ := ValidateTopics(rec.Topics)
	if len(topics) == 0 {
		topics = legacyTopicsFromTags(rec.Tags)
	}
	if len(topics) == 0 {
		return
	}
	for _, topic := range topics {
		key := topicKey(topic)
		if key == "" {
			continue
		}
		if bucket := s.topicIndex[key]; bucket != nil {
			delete(bucket, rec.ID)
			if len(bucket) == 0 {
				delete(s.topicIndex, key)
			}
		}
	}
}

func (s *Store) refreshTopicIndexLocked(oldRec *EpisodeRecord, newRec *EpisodeRecord) {
	if oldRec != nil {
		s.removeFromTopicIndexLocked(*oldRec)
	}
	if newRec != nil {
		s.addToTopicIndexLocked(*newRec)
	}
}

func recordHasTopic(rec EpisodeRecord, topic string) bool {
	topics, _ := ValidateTopics(rec.Topics)
	if len(topics) == 0 {
		topics = legacyTopicsFromTags(rec.Tags)
	}
	for _, item := range topics {
		if topicKey(item) == topicKey(topic) {
			return true
		}
	}
	return false
}

func matchedTopicCount(recordTopics []string, filterTopics []string) int {
	if len(recordTopics) == 0 || len(filterTopics) == 0 {
		return 0
	}
	filter := make(map[string]struct{}, len(filterTopics))
	for _, topic := range filterTopics {
		if key := topicKey(topic); key != "" {
			filter[key] = struct{}{}
		}
	}
	count := 0
	for _, topic := range recordTopics {
		if _, ok := filter[topicKey(topic)]; ok {
			count++
		}
	}
	return count
}

func legacyTopicsFromTags(tags []string) []string {
	return LegacyTopicsFromTags(tags)
}

func isActiveD0Record(rec EpisodeRecord) bool {
	if rec.PruneState == "tombstone" || rec.PruneState == "merged" {
		return false
	}
	if len(rec.Tags) == 0 {
		return true
	}
	for _, t := range rec.Tags {
		if t == "archived" || t == "d1-summary" || t == consolidationFailedTag || t == consolidationSkipTag {
			return false
		}
	}
	return true
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
	if s.lexicalCancel != nil {
		s.lexicalCancel()
	}
	if s.lexical != nil {
		_ = s.lexical.Close()
	}
	return s.db.Close()
}

// ComputeStage2BatchScores iterates over all D0 records (skipping those less than 30 mins old),
// calculates the Stage 2 Hippocampus Scores (Importance & Noise), and writes them
// back using a synchronous Pebble Batch.
func (s *Store) ComputeStage2BatchScores(ctx context.Context) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	const maxLag = 30 * time.Minute
	now := time.Now()

	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte("ep:"),
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		return err
	}
	defer iter.Close()

	batch := s.db.NewBatch()
	defer batch.Close()

	var updatedCount int

	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}

		if !isActiveD0Record(rec) {
			continue
		}

		// Only recompute if uncomputed or older than maxLag
		if !rec.LastScoredAt.IsZero() && now.Sub(rec.LastScoredAt) < maxLag {
			continue
		}

		// Age Penalty: max 30 days
		ageDays := now.Sub(rec.Timestamp).Hours() / 24.0
		if ageDays > 30.0 {
			ageDays = 30.0
		} else if ageDays < 0.0 {
			ageDays = 0.0
		}
		ageWithoutReusePenalty := ageDays / 30.0

		// Topics persistence score based on local `topicIndex`
		persistenceScore := 0.0
		topics, _ := ValidateTopics(rec.Topics)
		if len(topics) == 0 {
			topics = legacyTopicsFromTags(rec.Tags)
		}
		if len(topics) > 0 {
			for _, t := range topics {
				if b, ok := s.topicIndex[t]; ok {
					bucketSize := float64(len(b))
					if bucketSize > 10.0 {
						bucketSize = 10.0
					}
					persistenceScore += bucketSize / 10.0
				}
			}
			persistenceScore /= float64(len(topics))
		}

		redundancyWithD1 := 0.0
		for _, e := range rec.Edges {
			if e.Type == "child" { // e.g. record is a child of D1
				// Fast check using the record map `ep:[id]`
				_, closer, getErr := s.db.Get(append([]byte("ep:"), []byte(e.ID)...))
				if getErr == nil {
					redundancyWithD1 = 1.0
					rec.CanonicalParent = e.ID
					closer.Close()
					break
				}
			}
		}

		noExpandNoHit := 0.0
		if rec.ExpandCount == 0 && rec.Hits == 0 {
			noExpandNoHit = 1.0
		}

		params := ScoreUpdateParams{
			AgeWithoutReusePenalty: ageWithoutReusePenalty,
			TopicsPersistence:      persistenceScore,
			RedundancyWithD1:       redundancyWithD1,
			NoExpandNoHit:          noExpandNoHit,
		}

		CalculateScoreStage2(&rec, params)

		if rec.ImportanceScore < 0.3 && rec.NoiseScore >= 0.8 {
			rec.PruneState = "tombstone"
			rec.TombstonedAt = now
			log.Printf("[Hippocampus Dry-Run] Marked %s as tombstone (Imp:%.2f, Noise:%.2f)", rec.ID, rec.ImportanceScore, rec.NoiseScore)
		}

		// Write back to DB via batch
		if serialized, mErr := msgpack.Marshal(rec); mErr == nil {
			_ = batch.Set(iter.Key(), serialized, pebble.NoSync)
			updatedCount++
		}
	}

	if updatedCount > 0 {
		if err := batch.Commit(pebble.Sync); err != nil {
			log.Printf("ComputeStage2BatchScores: Failed to commit batch: %v", err)
			return err
		}
		log.Printf("ComputeStage2BatchScores: Successfully updated Stage 2 scores for %d records.", updatedCount)
	}

	return nil
}

// RunGarbageCollector physically deletes files that have been marked as tombstone
// for over 14 days, delegating DB Hard-Delete to the background FS Watcher.
func (s *Store) RunGarbageCollector(ctx context.Context) error {
	now := time.Now()
	tombstoneTTL := time.Duration(s.config.TombstoneTTL) * 24 * time.Hour
	if s.config.TombstoneTTL <= 0 {
		tombstoneTTL = 14 * 24 * time.Hour
	}

	s.mutex.RLock()
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte("ep:"),
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		s.mutex.RUnlock()
		return err
	}

	var deleteList []EpisodeRecord
	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		if rec.PruneState == "tombstone" {
			if !rec.TombstonedAt.IsZero() && now.Sub(rec.TombstonedAt) >= tombstoneTTL {
				deleteList = append(deleteList, rec)
			}
		}
	}
	iter.Close()
	s.mutex.RUnlock()

	for _, rec := range deleteList {
		if rec.SourcePath != "" {
			if err := os.Remove(rec.SourcePath); err == nil || os.IsNotExist(err) {
				log.Printf("[Hippocampus GC] Physically deleted tombstone memory file: %s", rec.SourcePath)
			} else {
				log.Printf("[Hippocampus GC] Failed to delete tombstone file %s: %v", rec.SourcePath, err)
			}
		}
	}

	return nil
}
