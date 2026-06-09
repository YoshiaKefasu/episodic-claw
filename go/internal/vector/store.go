package vector

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Bithack/go-hnsw"
	"github.com/blevesearch/bleve/v2"
	"github.com/cockroachdb/pebble"
	"github.com/vmihailenco/msgpack/v5"

	"episodic-core/frontmatter"
	"episodic-core/internal/logger"
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
	InjectedCount        int                `json:"injected_count,omitempty" msgpack:"injected_count,omitempty"`
	DirectGoodCount      int                `json:"direct_good_count,omitempty" msgpack:"direct_good_count,omitempty"`
	MissCount            int                `json:"miss_count,omitempty" msgpack:"miss_count,omitempty"`
	LastRecalledAt       time.Time          `json:"last_recalled_at,omitempty" msgpack:"last_recalled_at,omitempty"`
	LastExpandedAt       time.Time          `json:"last_expanded_at,omitempty" msgpack:"last_expanded_at,omitempty"`
	LastInjectedAt       time.Time          `json:"last_injected_at,omitempty" msgpack:"last_injected_at,omitempty"`
	BudgetSkipCount int `json:"budget_skip_count,omitempty" msgpack:"budget_skip_count,omitempty"`
	DueLagSecondsLast    int64              `json:"due_lag_seconds_last,omitempty" msgpack:"due_lag_seconds_last,omitempty"`
	DueLagSecondsMax     int64              `json:"due_lag_seconds_max,omitempty" msgpack:"due_lag_seconds_max,omitempty"`
	LastDueAt            time.Time          `json:"last_due_at,omitempty" msgpack:"last_due_at,omitempty"`
	// Phase 2: Hippocampus Scoring
	ImportanceScore float32   `json:"importance_score,omitempty" msgpack:"importance_score,omitempty"`
	NoiseScore      float32   `json:"noise_score,omitempty" msgpack:"noise_score,omitempty"`
	PruneState      string    `json:"prune_state,omitempty" msgpack:"prune_state,omitempty"`
	CanonicalParent string    `json:"canonical_parent,omitempty" msgpack:"canonical_parent,omitempty"`
	LastScoredAt    time.Time `json:"last_scored_at,omitempty" msgpack:"last_scored_at,omitempty"`
	ForgottenAt    time.Time `json:"forgotten_at,omitempty" msgpack:"forgotten_at,omitempty"`

	// ContentHash is the first 16 hex chars of SHA-256 over the MD body.
	// Used by Smart Dedup to skip re-embedding when the body has not changed.
	ContentHash string `json:"content_hash,omitempty" msgpack:"content_hash,omitempty"`
}

// RecallCalibration tunes the recall rerank without changing the core retrieval path.
// Nil fields fall back to the built-in defaults so old callers keep working.
type RecallCalibration struct {
	SemanticFloor         *float32 `json:"semanticFloor,omitempty"`
	UsefulnessClamp       *float32 `json:"usefulnessClamp,omitempty"`
	TopicsMatchBoost      *float32 `json:"topicsMatchBoost,omitempty"`
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
	TopicsMode          string        `json:"topicsMode,omitempty"`
	TopicsState         string        `json:"topicsState,omitempty"`
	TopicsMatchCount    int           `json:"topicsMatchCount,omitempty"`
	TopicsFallback      bool          `json:"topicsFallback,omitempty"`
	// MatchedBy is closer to scoring provenance than raw candidate origin:
	// "both" means lexical entry plus semantic score both influenced the final item.
	MatchedBy      string `json:"matchedBy,omitempty"`
	FallbackReason string `json:"fallbackReason,omitempty"`
	CandidateRank  int    `json:"candidateRank,omitempty"`
	Rank           int    `json:"rank,omitempty"`
}

// Watermark tracks the ingestion progress in the session.
type Watermark struct {
	DateSeq  string `json:"dateSeq"`
	AbsIndex uint32 `json:"absIndex"`
}

type StoreConfig struct {
		DeleteTTL           int  // days
	LexicalFilterLimit int  // max items from bleve
	Stage2TwoPhase     bool // [v0.4.26g] enable 2-phase lock optimization for Stage2 scoring
}

type Store struct {
	config            StoreConfig
	db                *pebble.DB
	graph             *hnsw.Hnsw
	topicIndex        map[string]map[string]struct{}
	activeD0Index     map[string]time.Time
	lexical           bleve.Index
	lexicalCancel     context.CancelFunc
	mutex             sync.RWMutex
	maxID             uint32
	IsRefining        atomic.Bool
	rebuildInProgress atomic.Bool
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
			logger.Info(logger.CatStore, "❌ Pebble DB is locked (another instance running or dirty shutdown). Aborting to prevent API limit burst: %v", err)
			return nil, fmt.Errorf("pebble db is locked: %w", err)
		}

		logger.Info(logger.CatStore, "⚠️ Pebble DB corrupted or incompatible: %v", err)
		corruptedPath := dbPath + ".corrupted." + time.Now().Format("20060102-150405")
		logger.Info(logger.CatStore, "🗑️ Isolating corrupted DB: %s → %s", dbPath, corruptedPath)
		if renameErr := os.Rename(dbPath, corruptedPath); renameErr != nil {
			return nil, fmt.Errorf("db corrupted and isolation failed: %w", renameErr)
		}
		logger.Info(logger.CatStore, "🔄 Opening fresh DB (rebuild required)...")
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

	// Trigger startup cleanup and migration before the store is considered ready.
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
	s.mutex.RLock()
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: prefixEp,
		UpperBound: []byte("ep;"),
	})
	s.mutex.RUnlock()

	if err != nil {
		logger.Info(logger.CatStore, "Orphan cleanup failed to initialize iter: %v", err)
		return
	}
	defer iter.Close()

	var toDelete []string
	var toDeleteEmptyID []string
	var toMigrate []EpisodeRecord

	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err == nil && rec.SourcePath != "" {
			iterKey := append([]byte(nil), iter.Key()...)
			// [v0.4.26b] Empty-ID records are orphaned cleanup targets, not warnings.
			if strings.TrimSpace(rec.ID) == "" {
				toDeleteEmptyID = append(toDeleteEmptyID, string(iterKey))
				continue
			}
			if _, statErr := os.Stat(rec.SourcePath); os.IsNotExist(statErr) {
				// Ghost record found
				toDelete = append(toDelete, rec.ID)
			} else {
				// File exists, let's make sure its p2i index is there (migration)
				toMigrate = append(toMigrate, rec)
			}
		}
	}

	// Now apply changes outside the global scan iterator
	if len(toDelete) > 0 {
		logger.Info(logger.CatStore, "Orphan cleanup: found %d ghost records, deleting...", len(toDelete))
		for _, id := range toDelete {
			s.Delete(id) // leverages the new pebble.Batch atomic deletion
		}
	}

	if len(toDeleteEmptyID) > 0 {
		logger.Info(logger.CatStore, "Orphan cleanup: deleting %d empty-ID record(s)", len(toDeleteEmptyID))
		batch := s.db.NewBatch()
		for _, rawKey := range toDeleteEmptyID {
			if rawKey == "" {
				continue
			}
			key := []byte(rawKey)
			batch.Delete(key, nil)
			if recBytes, closer, err := s.db.Get(key); err == nil {
				var rec EpisodeRecord
				if uErr := msgpack.Unmarshal(recBytes, &rec); uErr == nil && rec.SourcePath != "" {
					normalizedPath := filepath.ToSlash(filepath.Clean(rec.SourcePath))
					batch.Delete(append(append([]byte(nil), prefixP2I...), []byte(normalizedPath)...), nil)
				}
				closer.Close()
			}
		}
		if err := batch.Commit(pebble.Sync); err != nil {
			logger.Warn(logger.CatStore, "Orphan cleanup: failed to delete empty-ID records: %v", err)
		} else {
			logger.Info(logger.CatStore, "Orphan cleanup summary: removed %d empty-ID record(s)", len(toDeleteEmptyID))
		}
		batch.Close()
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
		logger.Info(logger.CatStore, "Orphan cleanup: migrated %d existing records to include p2i reverse index.", migrated)
	}
}

// enqueueSysLexq writes a lexical queue task directly into PebbleDB to guarantee processing.
func (s *Store) enqueueSysLexq(batch *pebble.Batch, action string, recordID string) {
	// [v0.4.20] Guard: skip empty record IDs — Bleve rejects document ID ""
	if recordID == "" {
		logger.Warn(logger.CatLexical, "enqueueSysLexq: skipped empty recordID for action=%s", action)
		return
	}
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
	// [v0.4.20] Guard: reject records with empty ID
	if rec.ID == "" {
		return fmt.Errorf("episode record ID must not be empty")
	}
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
	// [v0.4.20] Guard: reject batch with any empty ID
	for i, rec := range records {
		if rec.ID == "" {
			return fmt.Errorf("episode record ID must not be empty (index %d)", i)
		}
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

func (s *Store) getLocked(id string) (*EpisodeRecord, error) {
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

func (s *Store) Get(id string) (*EpisodeRecord, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	return s.getLocked(id)
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
	defer s.mutex.RUnlock()

	ids := make([]string, 0)
	if set, ok := s.topicIndex[key]; ok {
		for id := range set {
			ids = append(ids, id)
		}
	}

	if len(ids) > 0 {
		results := make([]EpisodeRecord, 0, len(ids))
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
		return results, nil
	}

	// Legacy fallback: scan the store when the reverse index has not been hydrated yet.
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
	// [v0.4.20b] Guard: skip deletion for empty ID
	if id == "" {
		return nil
	}
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

	return s.getLocked(idStr)
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
			logger.Warn(logger.CatStore, "Skipped deletion for %s (file physically exists)", p)
			continue
		}

		// Proceed with deletion since file is truly gone.
		if err := s.DeleteByPath(p); err != nil {
			logger.Info(logger.CatStore, "Batch delete failed for %s: %v", p, err)
		}
	}

	return nil
}

func (s *Store) deleteLocked(id string) error {
	// [v0.4.20b] Guard: skip deletion for empty ID — cannot form valid Pebble keys
	if id == "" {
		logger.Warn(logger.CatStore, "deleteLocked: skipped deletion for empty ID")
		return nil
	}
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

// RecordHit records the strongest positive signal, typically when a recalled
// episode is explicitly expanded by the user. It intentionally mirrors the old
// ep-expand field updates: Retrievals++, Hits += 2, LastRetrievedAt/LastHitAt,
// ExpandCount++, DirectGoodCount++, and LastExpandedAt.
func (s *Store) RecordHit(id string, at time.Time) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	if at.IsZero() {
		at = time.Now()
	}
	return s.UpdateRecord(id, func(rec *EpisodeRecord) error {
		rec.Retrievals++
		rec.Hits += 2
		rec.LastRetrievedAt = at
		rec.LastHitAt = at
		rec.ExpandCount++
		rec.DirectGoodCount++
		rec.LastExpandedAt = at
		return nil
	})
}

// RecordInjected records that an episode was actually injected into model
// context. This is stronger than being returned by recall, but weaker than an
// explicit ep-expand. It protects useful auto-injected memories from weekly
// unused-episode forgotten review.
func (s *Store) RecordInjected(id string, at time.Time) error {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	if at.IsZero() {
		at = time.Now()
	}
	return s.UpdateRecord(id, func(rec *EpisodeRecord) error {
		rec.InjectedCount++
		rec.LastInjectedAt = at
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

	// Ensure the key starts with "meta:" prefix for meta keys

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
	return s.baseRecall("", queryVector, topK, now, nil, true, nil, "")
}

func (s *Store) RecallWithTopics(queryVector []float32, topK int, now time.Time, topics []string) ([]ScoredEpisode, error) {
	// Backward-compatible default: topics means "strict facet filter".
	return s.baseRecall("", queryVector, topK, now, topics, true, nil, "")
}

func (s *Store) RecallWithTopicsMode(queryVector []float32, topK int, now time.Time, topics []string, strictTopics bool, calibration *RecallCalibration) ([]ScoredEpisode, error) {
	return s.baseRecall("", queryVector, topK, now, topics, strictTopics, calibration, "")
}

func (s *Store) RecallWithQuery(queryString string, queryVector []float32, topK int, now time.Time, topics []string, strictTopics bool, calibration *RecallCalibration, fallbackReason string) ([]ScoredEpisode, error) {
	return s.baseRecall(queryString, queryVector, topK, now, topics, strictTopics, calibration, fallbackReason)
}

func (s *Store) baseRecall(queryString string, queryVector []float32, topK int, now time.Time, topics []string, strictTopics bool, calibration *RecallCalibration, fallbackReason string) ([]ScoredEpisode, error) {
	if len(queryVector) != 3072 {
		return nil, fmt.Errorf("query vector length mismatch: expected 3072, got %d", len(queryVector))
	}

	semanticFloor := float32(0.35)
	usefulnessClamp := float32(1.0)
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
		topicsMatchBoost = float32OrDefault(calibration.TopicsMatchBoost, topicsMatchBoost)
		topicsMismatchPenalty = float32OrDefault(calibration.TopicsMismatchPenalty, topicsMismatchPenalty)
		topicsMissingPenalty = float32OrDefault(calibration.TopicsMissingPenalty, topicsMissingPenalty)
		lexicalTopK = intOrDefault(calibration.LexicalTopK, lexicalTopK)
	}
	if usefulnessClamp <= 0 {
		usefulnessClamp = 1.0
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
	seenCandidateIDs := make(map[string]struct{})

	appendCandidateUnique := func(candidate rawScore) {
		var candidateID string
		if candidate.id != "" {
			candidateID = candidate.id
		} else {
			resolvedID, err := s.GetIDByUint32(candidate.uid)
			if err != nil || resolvedID == "" {
				return
			}
			candidateID = resolvedID
		}
		if allowedIDs != nil {
			if _, ok := allowedIDs[candidateID]; !ok {
				return
			}
		}
		if _, exists := seenCandidateIDs[candidateID]; exists {
			return
		}
		seenCandidateIDs[candidateID] = struct{}{}
		candidates = append(candidates, candidate)
	}

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
				appendCandidateUnique(rawScore{id: hit.ID, dist: -1})
			}
		} else if err != nil {
			logger.Info(logger.CatLexical, "Search failed, falling back to HNSW: %v\n", err)
		}
	}

	shouldBackfillSemantic := len(candidates) > 0 &&
		len(candidates) < candidateK &&
		!strings.Contains(fallbackReason, "embed_fallback_lexical_only")

	if len(candidates) == 0 || shouldBackfillSemantic {
		s.mutex.RLock()
		pq := s.graph.Search(hnsw.Point(queryVector), candidateK*2, candidateK)
		for pq.Len() > 0 {
			item := pq.Pop()
			appendCandidateUnique(rawScore{uid: uint32(item.ID), dist: item.D})
			if shouldBackfillSemantic && len(candidates) >= candidateK {
				break
			}
		}
		s.mutex.RUnlock()
	}

	var scored []ScoredEpisode
	scoredIDs := make(map[string]struct{})

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
		if _, exists := scoredIDs[idStr]; exists {
			continue
		}
		scoredIDs[idStr] = struct{}{}

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
		matchedBy := matchedByForCandidate(cand.id != "", fallbackReason)
		callFallbackReason := composeRecallFallbackReason(fallbackReason, topicsFallback)

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
			TopicsMode:          topicsMode,
			TopicsState:         topicsState,
			TopicsMatchCount:    topicsMatchCount,
			TopicsFallback:      topicsFallback,
			MatchedBy:           matchedBy,
			FallbackReason:      callFallbackReason,
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

	if len(scored) == 0 && (fallbackReason != "" || topicsFallback) {
		logger.Warn(logger.CatStore,
			"[Recall] empty_result fallbackReason=%s topicsFallback=%t strictTopics=%t lexicalHits=%d candidateCount=%d queryPresent=%t",
			composeRecallFallbackReason(fallbackReason, topicsFallback),
			topicsFallback,
			strictTopics,
			len(bm25Scores),
			len(candidates),
			queryString != "",
		)
	}

	return scored, nil
}

func matchedByForCandidate(fromLexical bool, fallbackReason string) string {
	if !fromLexical {
		return "semantic"
	}
	if strings.Contains(fallbackReason, "embed_fallback_lexical_only") {
		return "lexical"
	}
	return "both"
}

func composeRecallFallbackReason(baseReason string, topicsFallback bool) string {
	embedFallback := strings.TrimSpace(baseReason)
	switch {
	case embedFallback != "" && topicsFallback:
		return embedFallback + "+topics_fallback"
	case embedFallback != "":
		return embedFallback
	case topicsFallback:
		return "topics_fallback"
	default:
		return ""
	}
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
	// [v0.4.34] Back-compat: legacy "tombstone" PruneState (pre-rename) treated
	// the same as "forgotten" so old DB records do not become active D0.
	if rec.PruneState == "forgotten" || rec.PruneState == "tombstone" || rec.PruneState == "merged" {
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

// Stage2RunSummary captures observability data for a ComputeStage2BatchScores run.
// [v0.4.26e] Added for operationally visible chunked-commit scoring.
type Stage2RunSummary struct {
	AgentWs       string    `json:"agent_ws"`
	RunID         string    `json:"run_id"`
	StartedAt     time.Time `json:"started_at"`
	DurationMs    int64     `json:"duration_ms"`
	Scanned       int       `json:"scanned"`
	Eligible      int       `json:"eligible"`
	SkippedRecent int       `json:"skipped_recent"`
	Rescored      int       `json:"rescored"`
	Forgotten    int       `json:"forgotten"`
	CommitCount   int       `json:"commit_count"`
	Cancelled     bool      `json:"cancelled"`
	CancelReason  string    `json:"cancel_reason,omitempty"`
	CommitError   string    `json:"commit_error,omitempty"` // [v0.4.26e] non-empty when commitBatch fails

	// [v0.4.26g] Lock granularity optimization metrics
	LockWaitMs     int64  `json:"lock_wait_ms"`         // Time spent waiting for lock acquisition
	LockHoldMs     int64  `json:"lock_hold_ms"`         // Time spent holding write/exclusive lock
	ReadLockHoldMs int64  `json:"read_lock_hold_ms"`    // [2phase] Time spent holding read lock (Phase 1)
	IterMs         int64  `json:"iter_ms"`              // Time spent in Pebble iteration + unmarshal
	ComputeMs      int64  `json:"compute_ms"`           // Time spent in score computation
	CommitMs       int64  `json:"commit_ms"`            // Cumulative time spent in batch commits
	PhaseMode      string `json:"phase_mode,omitempty"` // "legacy" or "2phase"
	StalePatches   int    `json:"stale_patches"`        // [2phase] Records modified between Phase1 and Phase3
}

// stage2BatchCommitSize controls how many records are accumulated before a
// partial commit. Partial commits are allowed ("部分反映許容" policy);
// uncommitted records on cancel are discarded.
const stage2BatchCommitSize = 300

// ComputeStage2BatchScores iterates over all D0 records (skipping those less than 30 mins old),
// calculates the Stage 2 Hippocampus Scores (Importance & Noise), and writes them
// back using chunked synchronous Pebble Batches.
//
// [v0.4.26e] Hardened with:
//   - context cancellation: uncommitted records are discarded on cancel
//   - chunked commits: every stage2BatchCommitSize records, a partial commit is issued
//   - structured summary: returned to caller for StateDB persistence (v0.4.26f)
//
// [v0.4.26g] Dispatches to legacy or 2-phase implementation based on StoreConfig.Stage2TwoPhase.
func (s *Store) ComputeStage2BatchScores(ctx context.Context, agentWs string) (Stage2RunSummary, error) {
	if s.config.Stage2TwoPhase {
		return s.computeStage2TwoPhase(ctx, agentWs)
	}
	return s.computeStage2Legacy(ctx, agentWs)
}

// computeStage2Legacy is the original single-lock implementation with [v0.4.26g] instrumentation.
// It holds s.mutex.Lock() for the entire function, which is safe but may cause
// reader starvation under heavy load.
func (s *Store) computeStage2Legacy(ctx context.Context, agentWs string) (Stage2RunSummary, error) {
	lockAttemptedAt := time.Now()
	s.mutex.Lock()
	defer s.mutex.Unlock()
	lockAcquiredAt := time.Now()

	startedAt := lockAcquiredAt
	runID := fmt.Sprintf("%d", startedAt.UnixNano())
	summary := Stage2RunSummary{
		AgentWs:   agentWs,
		RunID:     runID,
		StartedAt: startedAt,
		PhaseMode: "legacy",
	}

	const maxLag = 30 * time.Minute
	now := startedAt

	iterStartedAt := time.Now()
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte("ep:"),
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		return summary, err
	}
	defer iter.Close()

	batch := s.db.NewBatch()
	defer batch.Close()

	var batchCount int // records accumulated in current batch
	var totalCommitMs int64

	commitBatch := func() error {
		if batchCount == 0 {
			return nil
		}
		commitStart := time.Now()
		if err := batch.Commit(pebble.Sync); err != nil {
			logger.Warn(logger.CatStore, "ComputeStage2BatchScores: Failed to commit batch: %v", err)
			// [v0.4.26f] Populate summary on commit failure for caller-side persistence
			summary.CommitError = err.Error()
			summary.DurationMs = time.Since(startedAt).Milliseconds()
			return err
		}
		totalCommitMs += time.Since(commitStart).Milliseconds()
		summary.CommitCount++
		batch.Reset()
		batchCount = 0
		return nil
	}

	var computeMs int64

	for iter.First(); iter.Valid(); iter.Next() {
		// [v0.4.26e] Fix 1: context cancellation check
		select {
		case <-ctx.Done():
			// Discard uncommitted records — contract: "未 commit 分破棄"
			summary.Cancelled = true
			summary.CancelReason = ctx.Err().Error()
			summary.DurationMs = time.Since(startedAt).Milliseconds()
			summary.LockWaitMs = lockAcquiredAt.Sub(lockAttemptedAt).Milliseconds()
			summary.LockHoldMs = time.Since(lockAcquiredAt).Milliseconds()
			summary.IterMs = time.Since(iterStartedAt).Milliseconds() - computeMs - totalCommitMs // approximate
			summary.ComputeMs = computeMs
			summary.CommitMs = totalCommitMs
			logger.Info(logger.CatStore, "ComputeStage2BatchScores: Cancelled after %d commits, %d rescored, %d Forgotten (reason: %s)",
				summary.CommitCount, summary.Rescored, summary.Forgotten, summary.CancelReason)
			return summary, ctx.Err()
		default:
		}

		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		summary.Scanned++

		if !isActiveD0Record(rec) {
			continue
		}
		summary.Eligible++

		// Only recompute if uncomputed or older than maxLag
		if !rec.LastScoredAt.IsZero() && now.Sub(rec.LastScoredAt) < maxLag {
			summary.SkippedRecent++
			continue
		}

		computeStart := time.Now()

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
		computeMs += time.Since(computeStart).Milliseconds()
		summary.Rescored++

		if rec.ImportanceScore < 0.3 && rec.NoiseScore >= 0.8 {
			rec.PruneState = "forgotten"
			rec.ForgottenAt = now
			summary.Forgotten++
			logger.Info(logger.CatStore, "Marked %s as forgotten (Imp:%.2f, Noise:%.2f)", rec.ID, rec.ImportanceScore, rec.NoiseScore)
		}

		// Write back to DB via batch
		if serialized, mErr := msgpack.Marshal(rec); mErr == nil {
			_ = batch.Set(iter.Key(), serialized, pebble.NoSync)
			batchCount++
		}

		// [v0.4.26e] Fix 2: Chunked commit every stage2BatchCommitSize records
		if batchCount >= stage2BatchCommitSize {
			if err := commitBatch(); err != nil {
				return summary, err
			}
		}
	}

	// Final commit for remaining records
	if err := commitBatch(); err != nil {
		return summary, err
	}

	summary.DurationMs = time.Since(startedAt).Milliseconds()
	summary.LockWaitMs = lockAcquiredAt.Sub(lockAttemptedAt).Milliseconds()
	summary.LockHoldMs = time.Since(lockAcquiredAt).Milliseconds()
	summary.IterMs = time.Since(iterStartedAt).Milliseconds() - computeMs - totalCommitMs // approximate: iter+unmarshal time
	summary.ComputeMs = computeMs
	summary.CommitMs = totalCommitMs

	if summary.Rescored > 0 || summary.Forgotten > 0 {
		logger.Info(logger.CatStore, "ComputeStage2BatchScores: run=%s phase=%s scanned=%d eligible=%d skipped=%d rescored=%d Forgotten=%d commits=%d dur=%dms lockWait=%dms lockHold=%dms iter=%dms compute=%dms commit=%dms",
			runID, summary.PhaseMode, summary.Scanned, summary.Eligible, summary.SkippedRecent, summary.Rescored, summary.Forgotten, summary.CommitCount, summary.DurationMs,
			summary.LockWaitMs, summary.LockHoldMs, summary.IterMs, summary.ComputeMs, summary.CommitMs)
	}

	return summary, nil
}

// stage2ScorePatch represents a score-only update to be applied to an episode record.
// [v0.4.26g] Used by 2-phase implementation to avoid lost-update: instead of writing
// back the entire record (which could clobber concurrent Add/Update changes),
// we re-read the current record and only patch the score-related fields.
type stage2ScorePatch struct {
	ID                   string
	ImportanceScore      float32
	NoiseScore           float32
	PruneState           string
	ForgottenAt         time.Time
	LastScoredAt         time.Time
	CanonicalParent      string
	OriginalLastScoredAt time.Time // [v0.4.26g] Phase 1 snapshot's LastScoredAt for accurate stale detection
}

// computeStage2TwoPhase implements the 2-phase lock optimization for Stage2 scoring.
// [v0.4.26g]
//
// Phase 1 (RLock): Snapshot records + compute feature parameters (needs topicIndex).
// Phase 2 (no lock): Compute scores outside the lock — pure CPU, no shared state.
// Phase 3 (Lock): Re-read current records, apply score-only patches, batch commit.
//
// Lost-update safety: Phase 3 re-reads each record under Lock and only patches the
// 6 score fields (ImportanceScore, NoiseScore, PruneState, ForgottenAt, LastScoredAt,
// CanonicalParent). Concurrent Add/UpdateRecord changes to other fields (Hits, Retrievals,
// Tags, Topics, etc.) are preserved because we never overwrite the entire record.
func (s *Store) computeStage2TwoPhase(ctx context.Context, agentWs string) (Stage2RunSummary, error) {
	startedAt := time.Now()
	runID := fmt.Sprintf("%d", startedAt.UnixNano())
	summary := Stage2RunSummary{
		AgentWs:   agentWs,
		RunID:     runID,
		StartedAt: startedAt,
		PhaseMode: "2phase",
	}

	const maxLag = 30 * time.Minute
	now := startedAt

	// ---- Phase 1: RLock snapshot ----
	lockAttemptedAt := time.Now()
	s.mutex.RLock()
	lockAcquiredAt := time.Now()

	iterStartedAt := time.Now()
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte("ep:"),
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		s.mutex.RUnlock()
		return summary, err
	}

	// scoreCandidate holds the data needed for Phase 2 score computation.
	type scoreCandidate struct {
		rec       EpisodeRecord
		params    ScoreUpdateParams
		pebbleKey []byte // original iterator key for Phase 3 lookup
	}

	var candidates []scoreCandidate

	for iter.First(); iter.Valid(); iter.Next() {
		select {
		case <-ctx.Done():
			iter.Close()
			s.mutex.RUnlock()
			summary.Cancelled = true
			summary.CancelReason = ctx.Err().Error()
			summary.DurationMs = time.Since(startedAt).Milliseconds()
			summary.LockWaitMs = lockAcquiredAt.Sub(lockAttemptedAt).Milliseconds()
			summary.ReadLockHoldMs = time.Since(lockAcquiredAt).Milliseconds()
			summary.IterMs = time.Since(iterStartedAt).Milliseconds()
			return summary, ctx.Err()
		default:
		}

		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		summary.Scanned++

		if !isActiveD0Record(rec) {
			continue
		}
		summary.Eligible++

		if !rec.LastScoredAt.IsZero() && now.Sub(rec.LastScoredAt) < maxLag {
			summary.SkippedRecent++
			continue
		}

		// Compute feature parameters under RLock (needs topicIndex)
		ageDays := now.Sub(rec.Timestamp).Hours() / 24.0
		if ageDays > 30.0 {
			ageDays = 30.0
		} else if ageDays < 0.0 {
			ageDays = 0.0
		}
		ageWithoutReusePenalty := ageDays / 30.0

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
			if e.Type == "child" {
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

		candidates = append(candidates, scoreCandidate{
			rec:       rec,
			params:    params,
			pebbleKey: append([]byte(nil), iter.Key()...),
		})
	}
	iter.Close()
	rlockReleasedAt := time.Now()
	s.mutex.RUnlock()

	// ---- Phase 2: Compute scores outside the lock ----
	computeStart := time.Now()

	patches := make([]stage2ScorePatch, 0, len(candidates))
	for i, cand := range candidates {
		// [v0.4.26g] Phase 2 cancel check: respect context cancellation even
		// during lock-free computation. Check every 100 iterations.
		if i%100 == 0 {
			select {
			case <-ctx.Done():
				summary.Cancelled = true
				summary.CancelReason = ctx.Err().Error()
				summary.DurationMs = time.Since(startedAt).Milliseconds()
				summary.LockWaitMs = lockAcquiredAt.Sub(lockAttemptedAt).Milliseconds()
				summary.ReadLockHoldMs = rlockReleasedAt.Sub(lockAcquiredAt).Milliseconds()
				summary.IterMs = rlockReleasedAt.Sub(iterStartedAt).Milliseconds()
				summary.ComputeMs = time.Since(computeStart).Milliseconds()
				return summary, ctx.Err()
			default:
			}
		}

		rec := cand.rec // copy
		CalculateScoreStage2(&rec, cand.params)
		summary.Rescored++

		ForgottenAt := time.Time{}
		pruneState := rec.PruneState
		if rec.ImportanceScore < 0.3 && rec.NoiseScore >= 0.8 {
			pruneState = "forgotten"
			ForgottenAt = now
			summary.Forgotten++
			logger.Info(logger.CatStore, "Marked %s as forgotten (Imp:%.2f, Noise:%.2f)", rec.ID, rec.ImportanceScore, rec.NoiseScore)
		}

		patches = append(patches, stage2ScorePatch{
			ID:                   rec.ID,
			ImportanceScore:      rec.ImportanceScore,
			NoiseScore:           rec.NoiseScore,
			PruneState:           pruneState,
			ForgottenAt:         ForgottenAt,
			LastScoredAt:         now,
			CanonicalParent:      rec.CanonicalParent,
			OriginalLastScoredAt: cand.rec.LastScoredAt, // [v0.4.26g] for accurate stale detection
		})
	}
	computeMs := time.Since(computeStart).Milliseconds()

	// [v0.4.26g] Pre-Phase 3 cancel check: if context was cancelled during Phase 2,
	// abort before acquiring the write lock. This also handles the patches==0 edge
	// case where the Phase 3 loop would never execute and thus never check ctx.
	select {
	case <-ctx.Done():
		summary.Cancelled = true
		summary.CancelReason = ctx.Err().Error()
		summary.DurationMs = time.Since(startedAt).Milliseconds()
		summary.LockWaitMs = lockAcquiredAt.Sub(lockAttemptedAt).Milliseconds()
		summary.ReadLockHoldMs = rlockReleasedAt.Sub(lockAcquiredAt).Milliseconds()
		summary.IterMs = rlockReleasedAt.Sub(iterStartedAt).Milliseconds()
		summary.ComputeMs = computeMs
		return summary, ctx.Err()
	default:
	}

	// ---- Phase 3: Lock, re-read, apply score-only patches, commit ----
	writeLockAttemptedAt := time.Now()
	s.mutex.Lock()
	writeLockAcquiredAt := time.Now() // measure actual write-lock wait time

	batch := s.db.NewBatch()
	var batchCount int
	var totalCommitMs int64

	commitBatch := func() error {
		if batchCount == 0 {
			return nil
		}
		commitStart := time.Now()
		if err := batch.Commit(pebble.Sync); err != nil {
			summary.CommitError = err.Error()
			summary.DurationMs = time.Since(startedAt).Milliseconds()
			batch.Close()
			s.mutex.Unlock()
			return err
		}
		totalCommitMs += time.Since(commitStart).Milliseconds()
		summary.CommitCount++
		batch.Reset()
		batchCount = 0
		return nil
	}

	for i, patch := range patches {
		select {
		case <-ctx.Done():
			summary.Cancelled = true
			summary.CancelReason = ctx.Err().Error()
			summary.DurationMs = time.Since(startedAt).Milliseconds()
			summary.LockWaitMs = lockAcquiredAt.Sub(lockAttemptedAt).Milliseconds() + writeLockAcquiredAt.Sub(writeLockAttemptedAt).Milliseconds()
			summary.LockHoldMs = time.Since(writeLockAcquiredAt).Milliseconds()
			summary.ReadLockHoldMs = rlockReleasedAt.Sub(lockAcquiredAt).Milliseconds()
			summary.IterMs = rlockReleasedAt.Sub(iterStartedAt).Milliseconds()
			summary.ComputeMs = computeMs
			summary.CommitMs = totalCommitMs
			batch.Close()
			s.mutex.Unlock()
			return summary, ctx.Err()
		default:
		}

		epKey := append(append([]byte(nil), prefixEp...), []byte(patch.ID)...)
		val, closer, getErr := s.db.Get(epKey)
		if getErr != nil {
			// Record was deleted between Phase 1 and Phase 3 — skip
			if getErr != pebble.ErrNotFound {
				logger.Warn(logger.CatStore, "2phase: failed to re-read %s: %v", patch.ID, getErr)
			}
			summary.StalePatches++
			continue
		}

		var current EpisodeRecord
		if uErr := msgpack.Unmarshal(val, &current); uErr != nil {
			closer.Close()
			continue
		}
		closer.Close()

		// [v0.4.26g] Staleness detection: compare current record's LastScoredAt
		// against our Phase 1 snapshot's OriginalLastScoredAt. If they differ,
		// the record was modified (scored or updated) between Phase 1 and Phase 3.
		//
		// Known limitation: Add()/UpdateRecord()/RecordHit() modify Hits, Retrievals,
		// Tags, Topics etc. but do NOT touch LastScoredAt, so modifications to those
		// fields alone will NOT be detected as stale. The score-only patch preserves
		// the current field values (no data loss), but the PruneState decision may be
		// based on outdated feature inputs. This is acceptable because Stage2 is periodic
		// and the next run will re-evaluate with fresh data.
		stale := !current.LastScoredAt.Equal(patch.OriginalLastScoredAt)

		// Apply score-only patch (preserving all other fields from the current record).
		// Score fields are always applied — they will be recomputed next run even if stale.
		current.ImportanceScore = patch.ImportanceScore
		current.NoiseScore = patch.NoiseScore
		current.LastScoredAt = patch.LastScoredAt
		current.CanonicalParent = patch.CanonicalParent

		if stale {
			// [v0.4.26g] Stale record: PruneState decision is unreliable because
			// the score was computed from Phase 1 snapshot data (old Hits/Retrievals/etc).
			// Skip PruneState change entirely — the next Stage2 run will re-evaluate
			// with fresh data. This prevents stale-data-driven forgottens.
			//
			// Note: LastScoredAt is still set to `now`, giving the record a 30-min
			// scoring cooldown even though PruneState was not re-evaluated. This is
			// intentional to avoid hot-loop re-scoring on every run.
			summary.StalePatches++
		} else if (current.PruneState == "forgotten" || current.PruneState == "tombstone" || current.PruneState == "merged") && patch.PruneState != current.PruneState {
			// [v0.4.26g] Prune-state resurrection guard: once a record is in a
			// terminal prune state, a later scoring pass must NOT undo that decision.
			// Score fields are still updated for observability.
			summary.StalePatches++
		} else {
			current.PruneState = patch.PruneState
			if !patch.ForgottenAt.IsZero() {
				current.ForgottenAt = patch.ForgottenAt
			}
		}

		if serialized, mErr := msgpack.Marshal(current); mErr == nil {
			_ = batch.Set(epKey, serialized, pebble.NoSync)
			batchCount++
		}

		if batchCount >= stage2BatchCommitSize {
			if err := commitBatch(); err != nil {
				return summary, err
			}
		}

		// Periodic fairness yield: briefly unlock to let readers through
		if i > 0 && i%100 == 0 {
			if batchCount == 0 {
				s.mutex.Unlock()
				s.mutex.Lock()
			}
		}
	}

	// Final commit
	if err := commitBatch(); err != nil {
		return summary, err
	}
	batch.Close()
	s.mutex.Unlock()

	writeLockReleasedAt := time.Now()

	summary.DurationMs = time.Since(startedAt).Milliseconds()
	summary.LockWaitMs = lockAcquiredAt.Sub(lockAttemptedAt).Milliseconds() + writeLockAcquiredAt.Sub(writeLockAttemptedAt).Milliseconds()
	summary.LockHoldMs = writeLockReleasedAt.Sub(writeLockAcquiredAt).Milliseconds()
	summary.ReadLockHoldMs = rlockReleasedAt.Sub(lockAcquiredAt).Milliseconds()
	summary.IterMs = rlockReleasedAt.Sub(iterStartedAt).Milliseconds()
	summary.ComputeMs = computeMs
	summary.CommitMs = totalCommitMs

	if summary.Rescored > 0 || summary.Forgotten > 0 {
		logger.Info(logger.CatStore, "ComputeStage2BatchScores: run=%s phase=%s scanned=%d eligible=%d skipped=%d rescored=%d Forgotten=%d commits=%d stale=%d dur=%dms lockWait=%dms rlockHold=%dms wlockHold=%dms iter=%dms compute=%dms commit=%dms",
			runID, summary.PhaseMode, summary.Scanned, summary.Eligible, summary.SkippedRecent, summary.Rescored, summary.Forgotten, summary.CommitCount, summary.StalePatches, summary.DurationMs,
			summary.LockWaitMs, summary.ReadLockHoldMs, summary.LockHoldMs, summary.IterMs, summary.ComputeMs, summary.CommitMs)
	}

	return summary, nil
}

// CleanupLegacyStage2Summary removes the old meta:stage2:last_summary key from
// vector.db that was written by the pre-v0.4.26f saveStage2Summary method.
// This is a one-time idempotent migration — safe to call repeatedly.
// [v0.4.26f] Summary persistence moved to StateDB; vector.db no longer stores it.
func (s *Store) CleanupLegacyStage2Summary() {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	key := []byte("meta:stage2:last_summary")
	_, closer, err := s.db.Get(key)
	if err == pebble.ErrNotFound {
		return // already clean
	}
	if err != nil {
		logger.Warn(logger.CatStore, "CleanupLegacyStage2Summary: failed to check key: %v", err)
		return
	}
	closer.Close()

	if err := s.db.Delete(key, pebble.Sync); err != nil {
		logger.Warn(logger.CatStore, "CleanupLegacyStage2Summary: failed to delete key: %v", err)
	} else {
		logger.Info(logger.CatStore, "CleanupLegacyStage2Summary: removed legacy meta:stage2:last_summary from vector.db")
	}
}

// ListUnusedMDEpisodes returns old auto-generated Markdown episodes that have
// never been recalled, expanded, hit, or injected. This is a dry-run friendly
// candidate lister for the weekly forgotten review; it does not mutate records.
// Manual ep-save memories are explicitly excluded by both tag and notes/ path.
func (s *Store) ListUnusedMDEpisodes(ctx context.Context, now time.Time, retentionDays int, limit int) ([]EpisodeRecord, error) {
	if now.IsZero() {
		now = time.Now()
	}
	if retentionDays <= 0 || limit <= 0 {
		return nil, nil
	}
	cutoff := now.Add(-time.Duration(retentionDays) * 24 * time.Hour)

	s.mutex.RLock()
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte("ep:"),
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		s.mutex.RUnlock()
		return nil, err
	}
	defer func() {
		iter.Close()
		s.mutex.RUnlock()
	}()

	candidates := make([]EpisodeRecord, 0, limit)
	for iter.First(); iter.Valid(); iter.Next() {
		select {
		case <-ctx.Done():
			return candidates, ctx.Err()
		default:
		}

		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		if !isUnusedMDEpisodeCandidate(rec, cutoff) {
			continue
		}
		candidates = append(candidates, rec)
		if len(candidates) >= limit {
			break
		}
	}
	if err := iter.Error(); err != nil {
		return candidates, err
	}
	return candidates, nil
}

func isUnusedMDEpisodeCandidate(rec EpisodeRecord, cutoff time.Time) bool {
	if rec.ID == "" || rec.SourcePath == "" || rec.PruneState != "" || rec.Timestamp.IsZero() || rec.Timestamp.After(cutoff) {
		return false
	}
	if strings.ToLower(filepath.Ext(rec.SourcePath)) != ".md" {
		return false
	}
	if hasTagFold(rec.Tags, "manual-save") || pathHasSegment(rec.SourcePath, "notes") {
		return false
	}
	if rec.RecallShownCount > 0 || rec.ExpandCount > 0 || rec.Hits > 0 || rec.InjectedCount > 0 {
		return false
	}
	if !rec.LastRecalledAt.IsZero() || !rec.LastExpandedAt.IsZero() || !rec.LastHitAt.IsZero() || !rec.LastInjectedAt.IsZero() {
		return false
	}
	return true
}

func hasTagFold(tags []string, want string) bool {
	for _, tag := range tags {
		if strings.EqualFold(strings.TrimSpace(tag), want) {
			return true
		}
	}
	return false
}

func pathHasSegment(pathValue string, want string) bool {
	normalized := filepath.ToSlash(filepath.Clean(pathValue))
	for _, part := range strings.Split(normalized, "/") {
		if strings.EqualFold(strings.TrimSpace(part), want) {
			return true
		}
	}
	return false
}

// SimulateMarkUnusedAsForgotten performs a read-only dry-run of the weekly
// unused-episode review. It calls ListUnusedMDEpisodes and emits a structured
// "would forgotten" log line per candidate, but never mutates any record.
// The retentionDays argument is the unused review window measured from each
// candidate's narrative Timestamp, not a deletion deadline. Records touched
// by ep-recall, ep-expand, or auto-injection within that window, and any
// manual-save or notes/* records, are already excluded by the candidate rule.
// The function returns the candidate count for observability/tests.
func (s *Store) SimulateMarkUnusedAsForgotten(ctx context.Context, now time.Time, retentionDays int, limit int) (int, error) {
	if now.IsZero() {
		now = time.Now()
	}
	if retentionDays <= 0 {
		retentionDays = 365
	}
	if limit <= 0 {
		limit = 500
	}
	candidates, err := s.ListUnusedMDEpisodes(ctx, now, retentionDays, limit)
	if err != nil {
		return 0, err
	}
	for i := range candidates {
		select {
		case <-ctx.Done():
			return i, ctx.Err()
		default:
		}
		rec := candidates[i]
		ageDays := int(now.Sub(rec.Timestamp).Hours() / 24)
		logger.Info(logger.CatStore, "dry-run: would forgotten id=%s ageDays=%d retentionDays=%d source=%s", rec.ID, ageDays, retentionDays, filepath.Base(rec.SourcePath))
	}
	// [v0.4.34a] The handler in main.go emits the authoritative summary log
	// line at the RPC boundary. Avoid a duplicate summary here to keep the log
	// stream clean for repeated dry-run probes.
	return len(candidates), nil
}

// MarkEpisodesForgotten is the write counterpart of SimulateMarkUnusedAsForgotten.
// It calls ListUnusedMDEpisodes and rewrites each candidate with
// PruneState="forgotten" and ForgottenAt=now, batched into a single Pebble
// transaction. Re-check of the unused-eligibility rule happens under the
// store's write lock to avoid racing with a recall/expand/inject that arrived
// between the list and the write. The retentionDays argument follows the
// same semantic as SimulateMarkUnusedAsForgotten (unused review window from
// each record's narrative Timestamp). This function is not yet wired into
// RunGarbageCollector; the weekly scheduler in Phase 5 will own the call site.
func (s *Store) MarkEpisodesForgotten(ctx context.Context, now time.Time, retentionDays int, limit int) (int, error) {
	if now.IsZero() {
		now = time.Now()
	}
	if retentionDays <= 0 {
		retentionDays = 365
	}
	if limit <= 0 {
		limit = 500
	}
	start := time.Now()
	candidates, err := s.ListUnusedMDEpisodes(ctx, now, retentionDays, limit)
	if err != nil {
		return 0, err
	}
	if len(candidates) == 0 {
		logger.Info(logger.CatStore, "MarkEpisodesForgotten count=0 retentionDays=%d limit=%d scanMs=%d", retentionDays, limit, time.Since(start).Milliseconds())
		return 0, nil
	}

	cutoff := now.AddDate(0, 0, -retentionDays)

	s.mutex.Lock()
	defer s.mutex.Unlock()

	batch := s.db.NewBatch()
	defer batch.Close()

	marked := 0

	for i := range candidates {
		select {
		case <-ctx.Done():
			if commitErr := batch.Commit(pebble.Sync); commitErr != nil {
				return marked, fmt.Errorf("MarkEpisodesForgotten partial commit failed: %w", commitErr)
			}
			return marked, ctx.Err()
		default:
		}

		rec := candidates[i]
		epKey := append(append([]byte(nil), prefixEp...), []byte(rec.ID)...)
		val, closer, err := s.db.Get(epKey)
		if err != nil {
			if err != pebble.ErrNotFound {
				logger.Info(logger.CatStore, "MarkEpisodesForgotten: Get %s failed: %v", rec.ID, err)
			}
			continue
		}
		var current EpisodeRecord
		unmarshalErr := msgpack.Unmarshal(val, &current)
		closer.Close()
		if unmarshalErr != nil {
			logger.Info(logger.CatStore, "MarkEpisodesForgotten: Unmarshal %s failed: %v", rec.ID, unmarshalErr)
			continue
		}

		// Re-check eligibility under the write lock. If anything mutated
		// the record between the list snapshot and now (recall/expand/
		// inject), the candidate is no longer eligible and must be left
		// alone.
		if !isUnusedMDEpisodeCandidate(current, cutoff) {
			continue
		}

		current.PruneState = "forgotten"
		current.ForgottenAt = now

		data, marshalErr := msgpack.Marshal(&current)
		if marshalErr != nil {
			logger.Info(logger.CatStore, "MarkEpisodesForgotten: Marshal %s failed: %v", rec.ID, marshalErr)
			continue
		}
		batch.Set(epKey, data, nil)
		marked++
		ageDays := int(now.Sub(current.Timestamp).Hours() / 24)
		logger.Info(logger.CatStore, "forgotten id=%s ageDays=%d retentionDays=%d source=%s", current.ID, ageDays, retentionDays, filepath.Base(current.SourcePath))
	}

	if err := batch.Commit(pebble.Sync); err != nil {
		return marked, fmt.Errorf("MarkEpisodesForgotten commit failed: %w", err)
	}
	logger.Info(logger.CatStore, "MarkEpisodesForgotten count=%d retentionDays=%d limit=%d scanMs=%d", marked, retentionDays, limit, time.Since(start).Milliseconds())
	return marked, nil
}

// ListBatchableForgotten returns forgotten records old enough for physical
// deletion. It only lists candidates; file deletion and DB cleanup are handled
// by DeleteForgottenFiles plus the existing background FS watcher path.
func (s *Store) ListBatchableForgotten(ctx context.Context, now time.Time, limit int) ([]EpisodeRecord, error) {
	if now.IsZero() {
		now = time.Now()
	}
	if limit <= 0 {
		return nil, nil
	}
	forgottenTTL := time.Duration(s.config.DeleteTTL) * 24 * time.Hour
	if s.config.DeleteTTL <= 0 {
		forgottenTTL = 14 * 24 * time.Hour
	}

	s.mutex.RLock()
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte("ep:"),
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		s.mutex.RUnlock()
		return nil, err
	}
	defer func() {
		iter.Close()
		s.mutex.RUnlock()
	}()

	deleteList := make([]EpisodeRecord, 0, limit)
	for iter.First(); iter.Valid(); iter.Next() {
		select {
		case <-ctx.Done():
			return deleteList, ctx.Err()
		default:
		}

		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		// [v0.4.34] Back-compat: legacy "tombstone" records from pre-rename DB
		// are eligible for physical delete here. Their TombstonedAt field will
		// not be deserialized into ForgottenAt (different JSON keys), so the TTL
		// check below will skip them until a future migration fills ForgottenAt.
		// At minimum they show up in ListAllForgottenEpisodes queries.
		if rec.PruneState == "forgotten" || rec.PruneState == "tombstone" {
			if !rec.ForgottenAt.IsZero() && now.Sub(rec.ForgottenAt) >= forgottenTTL {
				deleteList = append(deleteList, rec)
				if len(deleteList) >= limit {
					break
				}
			}
		}
	}
	if err := iter.Error(); err != nil {
		return deleteList, err
	}
	return deleteList, nil
}

// ListAllForgottenEpisodes returns all records currently in the "forgotten"
// state, regardless of how long ago they were marked. This is the input for
// the weekly semantic-snapshot worker: each entry will be summarised into a
// one-line memory and then deleted.
//
// If agentWs is non-empty, the result is filtered to records whose SourcePath
// starts with that prefix. Pass an empty string to include all workspaces
// (used by tests and by admin tools).
//
// TTL is intentionally not applied here — ListBatchableForgotten owns that.
// Caller (the TypeScript worker) is expected to drive the per-item summary
// and physical delete loop directly off the returned slice.
func (s *Store) ListAllForgottenEpisodes(ctx context.Context, agentWs string, limit int) ([]EpisodeRecord, error) {
	if limit <= 0 {
		return nil, nil
	}

	s.mutex.RLock()
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: []byte("ep:"),
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		s.mutex.RUnlock()
		return nil, err
	}
	defer func() {
		iter.Close()
		s.mutex.RUnlock()
	}()

	list := make([]EpisodeRecord, 0, limit)
	for iter.First(); iter.Valid(); iter.Next() {
		select {
		case <-ctx.Done():
			return list, ctx.Err()
		default:
		}

		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		if rec.PruneState != "forgotten" {
			continue
		}
		if agentWs != "" && !strings.HasPrefix(rec.SourcePath, agentWs) {
			continue
		}
		list = append(list, rec)
		if len(list) >= limit {
			break
		}
	}
	if err := iter.Error(); err != nil {
		return list, err
	}
	return list, nil
}

// DeleteForgottenFiles physically deletes forgotten candidate files. Missing
// files count as deleted because the background orphan cleanup path handles DB
// consistency later.
func (s *Store) DeleteForgottenFiles(ctx context.Context, records []EpisodeRecord) (deleted int, failed int) {
	for _, rec := range records {
		select {
		case <-ctx.Done():
			return deleted, failed + len(records) - deleted - failed
		default:
		}
		if rec.SourcePath != "" {
			if err := os.Remove(rec.SourcePath); err == nil || os.IsNotExist(err) {
				deleted++
				logger.Info(logger.CatStore, "Physically deleted forgotten memory file: %s", rec.SourcePath)
			} else {
				failed++
				logger.Info(logger.CatStore, "Failed to delete forgotten file %s: %v", rec.SourcePath, err)
			}
		}
	}
	return deleted, failed
}

// RunGarbageCollector physically deletes files that have been marked as forgotten
// for over 14 days, delegating DB Hard-Delete to the background FS Watcher.
func (s *Store) RunGarbageCollector(ctx context.Context) error {
	deleteList, err := s.ListBatchableForgotten(ctx, time.Now(), 10_000)
	if err != nil {
		return err
	}
	s.DeleteForgottenFiles(ctx, deleteList)

	return nil
}

// LexicalCount returns the number of documents in the Bleve lexical index.
func (s *Store) LexicalCount() (uint64, error) {
	if s.lexical == nil {
		return 0, nil
	}
	return s.lexical.DocCount()
}

// RebuildInProgress returns the atomic bool guarding concurrent rebuilds.
func (s *Store) RebuildInProgress() *atomic.Bool {
	return &s.rebuildInProgress
}

// RebuildLexicalIndex scans all EpisodeRecord entries in PebbleDB and
// re-enqueues them into the sys_lexq queue for the lexical worker to
// index into Bleve. Safe to call on a live store — the worker processes
// items asynchronously. Uses "UPDATE" action for idempotent upserts.
func (s *Store) RebuildLexicalIndex() (int, error) {
	if s.lexical == nil {
		return 0, fmt.Errorf("lexical index not initialized")
	}

	// Scope lock narrowly — follow CleanOrphans pattern (store.go:272-277)
	s.mutex.RLock()
	iter, err := s.db.NewIter(&pebble.IterOptions{
		LowerBound: prefixEp,
		UpperBound: []byte("ep;"),
	})
	s.mutex.RUnlock()
	if err != nil {
		return 0, err
	}
	defer iter.Close()

	batch := s.db.NewBatch()
	defer batch.Close()

	count := 0
	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		// [v0.4.20] Skip records with empty ID — cannot be indexed by Bleve
		if rec.ID == "" {
			logger.Warn(logger.CatStore, "RebuildLexicalIndex: skipping record with empty ID (SourcePath=%s)", rec.SourcePath)
			continue
		}
		if rec.SourcePath == "" {
			continue
		}
		if _, err := os.Stat(rec.SourcePath); os.IsNotExist(err) {
			continue
		}
		s.enqueueSysLexq(batch, "UPDATE", rec.ID)
		count++
	}

	if err := batch.Commit(pebble.Sync); err != nil {
		return 0, fmt.Errorf("failed to commit lexical rebuild batch: %w", err)
	}
	return count, nil
}
