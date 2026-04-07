package vector

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"episodic-core/frontmatter"
	"episodic-core/internal/ai"
	"episodic-core/internal/logger"

	"github.com/cockroachdb/pebble"
	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/time/rate"
)

const (
	replayObservationDirectGood   = "DirectGood"
	replayObservationExpandedGood = "ExpandedGood"
	replayObservationAgain        = "Again"
	replayObservationMiss         = "Miss"
	replayObservationNoReview     = "NoReview"
	replayKeyPrefix               = "replay:"
	replayLeaseKeyPrefix          = "replaylease:"
	replayObservationKeyPrefix    = "replayobs:"
)

type ReplayState struct {
	Stability        float64   `json:"stability"`
	Retrievability   float64   `json:"retrievability"`
	Difficulty       float64   `json:"difficulty"`
	DesiredRetention float64   `json:"desired_retention"`
	DueAt            time.Time `json:"due_at"`
	LastReviewedAt   time.Time `json:"last_reviewed_at"`
	ReviewCount      int       `json:"review_count"`
	Lapses           int       `json:"lapses"`
}

type ReplayLease struct {
	Holder     string    `json:"holder"`
	AcquiredAt time.Time `json:"acquired_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type ReplayObservation struct {
	ObservationID string    `json:"observation_id"`
	WorkspaceID   string    `json:"workspace_id"`
	EpisodeID     string    `json:"episode_id"`
	QueryFamilyID string    `json:"query_family_id,omitempty"`
	Outcome       string    `json:"outcome"`
	OccurredAt    time.Time `json:"occurred_at"`
	Source        string    `json:"source"`
	Selected      bool      `json:"selected,omitempty"`
	DueLagSeconds int64     `json:"due_lag_seconds,omitempty"`
	SkippedReason string    `json:"skipped_reason,omitempty"`
}

type ReplayRunSummary struct {
	WorkspaceID        string    `json:"workspace_id"`
	StartedAt          time.Time `json:"started_at"`
	FinishedAt         time.Time `json:"finished_at"`
	DueCandidates      int       `json:"due_candidates"`
	SelectedCount      int       `json:"selected_count"`
	ReviewedCount      int       `json:"reviewed_count"`
	NoReviewCount      int       `json:"no_review_count"`
	LeaseConflictCount int       `json:"lease_conflict_count"`
	BudgetSkipCount    int       `json:"budget_skip_count"`
	SkippedReasons     []string  `json:"skipped_reasons,omitempty"`
	ErrorCount         int       `json:"error_count"`
}

type ReplayCandidate struct {
	Record   EpisodeRecord `json:"record"`
	State    ReplayState   `json:"state"`
	Class    string        `json:"class"`
	Priority float64       `json:"priority"`
}

type replayClass string

const (
	replayClassD1        replayClass = "d1"
	replayClassManual    replayClass = "manual-save"
	replayClassSingleton replayClass = "singleton"
	replayClassD0        replayClass = "d0"
)

func replayStateKey(id string) []byte {
	return []byte(replayKeyPrefix + strings.TrimSpace(id))
}

func replayLeaseKey(id string) []byte {
	return []byte(replayLeaseKeyPrefix + strings.TrimSpace(id))
}

func replayObservationKey(id string) []byte {
	return []byte(replayObservationKeyPrefix + strings.TrimSpace(id))
}

func classifyReplayRecord(rec EpisodeRecord) replayClass {
	switch {
	case hasTag(rec.Tags, "d1-summary"):
		return replayClassD1
	case hasTag(rec.Tags, "manual-save"):
		return replayClassManual
	case isHighSalienceSingleton(rec):
		return replayClassSingleton
	default:
		return replayClassD0
	}
}

func isHighSalienceSingleton(rec EpisodeRecord) bool {
	if hasTag(rec.Tags, "d1-summary") || hasTag(rec.Tags, "manual-save") {
		return false
	}
	if len(rec.Edges) > 0 {
		return false
	}
	return rec.Surprise >= 0.75
}

func replayPriorityForClass(cls replayClass) float64 {
	switch cls {
	case replayClassD1:
		return 3.0
	case replayClassManual:
		return 2.4
	case replayClassSingleton:
		return 2.0
	default:
		return 1.0
	}
}

func initialReplayStateForRecord(rec EpisodeRecord, now time.Time) ReplayState {
	switch classifyReplayRecord(rec) {
	case replayClassD1:
		return ReplayState{
			Stability:        1.8,
			Retrievability:   0.92,
			Difficulty:       0.35,
			DesiredRetention: 0.90,
			DueAt:            now.Add(10 * time.Minute),
			LastReviewedAt:   now,
		}
	case replayClassManual:
		return ReplayState{
			Stability:        1.5,
			Retrievability:   0.88,
			Difficulty:       0.42,
			DesiredRetention: 0.88,
			DueAt:            now.Add(15 * time.Minute),
			LastReviewedAt:   now,
		}
	case replayClassSingleton:
		return ReplayState{
			Stability:        1.2,
			Retrievability:   0.84,
			Difficulty:       0.48,
			DesiredRetention: 0.86,
			DueAt:            now.Add(12 * time.Minute),
			LastReviewedAt:   now,
		}
	default:
		return ReplayState{
			Stability:        0.9,
			Retrievability:   0.80,
			Difficulty:       0.55,
			DesiredRetention: 0.80,
			DueAt:            now.Add(30 * time.Minute),
			LastReviewedAt:   now,
		}
	}
}

func replayOutcomeClassify(outcome string) string {
	trimmed := strings.TrimSpace(outcome)
	switch trimmed {
	case replayObservationDirectGood, replayObservationExpandedGood, "Good":
		return replayObservationExpandedGood
	case replayObservationAgain, replayObservationMiss:
		return replayObservationAgain
	case replayObservationNoReview:
		return replayObservationNoReview
	default:
		return trimmed
	}
}

func clampDuration(d, minDur, maxDur time.Duration) time.Duration {
	if d < minDur {
		return minDur
	}
	if d > maxDur {
		return maxDur
	}
	return d
}

func applyReplayOutcome(state *ReplayState, outcome string, now time.Time, cls replayClass) {
	switch replayOutcomeClassify(outcome) {
	case replayObservationNoReview:
		return
	case replayObservationAgain:
		state.ReviewCount++
		state.Lapses++
		state.LastReviewedAt = now
		state.Stability = math.Max(0.25, state.Stability*0.58)
		state.Difficulty = math.Min(1.0, state.Difficulty+0.06)
		state.Retrievability = 0.28
		state.DueAt = now.Add(clampDuration(10*time.Minute, 5*time.Minute, 30*time.Minute))
	case replayObservationExpandedGood:
		state.ReviewCount++
		state.LastReviewedAt = now
		state.Stability = math.Max(0.5, state.Stability*1.18+0.15)
		state.Difficulty = math.Max(0, state.Difficulty-0.03)
		state.Retrievability = math.Min(0.98, math.Max(state.DesiredRetention, 0.88))
		base := time.Duration(math.Round(state.Stability*35)) * time.Minute
		switch cls {
		case replayClassD1:
			base = time.Duration(math.Round(state.Stability*45)) * time.Minute
		case replayClassManual:
			base = time.Duration(math.Round(state.Stability*40)) * time.Minute
		case replayClassSingleton:
			base = time.Duration(math.Round(state.Stability*30)) * time.Minute
		}
		state.DueAt = now.Add(clampDuration(base, 10*time.Minute, 24*time.Hour))
	default:
		state.ReviewCount++
		state.LastReviewedAt = now
		state.Stability = math.Max(0.5, state.Stability*1.10+0.10)
		state.Difficulty = math.Max(0, state.Difficulty-0.01)
		state.Retrievability = math.Min(0.96, math.Max(state.DesiredRetention, state.Retrievability))
		base := time.Duration(math.Round(state.Stability*30)) * time.Minute
		state.DueAt = now.Add(clampDuration(base, 10*time.Minute, 24*time.Hour))
	}
}

func (s *Store) loadReplayStateLocked(id string) (ReplayState, bool, error) {
	key := replayStateKey(id)
	val, closer, err := s.db.Get(key)
	if err != nil {
		if err == pebble.ErrNotFound {
			return ReplayState{}, false, nil
		}
		return ReplayState{}, false, err
	}
	defer closer.Close()

	var state ReplayState
	if err := json.Unmarshal(val, &state); err != nil {
		return ReplayState{}, false, err
	}
	return state, true, nil
}

func (s *Store) GetReplayState(id string) (ReplayState, bool, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()
	return s.loadReplayStateLocked(id)
}

func (s *Store) UpsertReplayState(id string, seed ReplayState, mutator func(*ReplayState) error) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	state, ok, err := s.loadReplayStateLocked(id)
	if err != nil {
		return err
	}
	if !ok {
		state = seed
	}
	if mutator != nil {
		if err := mutator(&state); err != nil {
			return err
		}
	}

	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return s.db.Set(replayStateKey(id), data, pebble.Sync)
}

func (s *Store) DeleteReplayState(id string) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.db.Delete(replayStateKey(id), pebble.Sync)
}

func (s *Store) loadReplayLeaseLocked(id string) (ReplayLease, bool, error) {
	key := replayLeaseKey(id)
	val, closer, err := s.db.Get(key)
	if err != nil {
		if err == pebble.ErrNotFound {
			return ReplayLease{}, false, nil
		}
		return ReplayLease{}, false, err
	}
	defer closer.Close()

	var lease ReplayLease
	if err := json.Unmarshal(val, &lease); err != nil {
		return ReplayLease{}, false, err
	}
	return lease, true, nil
}

func (s *Store) AcquireReplayLease(id, holder string, ttl time.Duration) (bool, error) {
	id = strings.TrimSpace(id)
	holder = strings.TrimSpace(holder)
	if id == "" || holder == "" {
		return false, nil
	}
	if ttl <= 0 {
		ttl = 20 * time.Minute
	}

	s.mutex.Lock()
	defer s.mutex.Unlock()

	now := time.Now()
	lease, ok, err := s.loadReplayLeaseLocked(id)
	if err != nil {
		return false, err
	}
	if ok && lease.ExpiresAt.After(now) && lease.Holder != holder {
		return false, nil
	}

	next := ReplayLease{
		Holder:     holder,
		AcquiredAt: now,
		ExpiresAt:  now.Add(ttl),
	}
	data, err := json.Marshal(next)
	if err != nil {
		return false, err
	}
	if err := s.db.Set(replayLeaseKey(id), data, pebble.Sync); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) ReleaseReplayLease(id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return nil
	}
	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.db.Delete(replayLeaseKey(id), pebble.Sync)
}

func (s *Store) loadRecordLocked(id string) (*EpisodeRecord, error) {
	key := append(append([]byte(nil), prefixEp...), []byte(id)...)
	val, closer, err := s.db.Get(key)
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

func (s *Store) ApplyReplayObservation(obs ReplayObservation) error {
	obs.ObservationID = strings.TrimSpace(obs.ObservationID)
	obs.EpisodeID = strings.TrimSpace(obs.EpisodeID)
	obs.Outcome = replayOutcomeClassify(obs.Outcome)
	if obs.ObservationID == "" || obs.EpisodeID == "" {
		return fmt.Errorf("invalid replay observation")
	}
	if obs.OccurredAt.IsZero() {
		obs.OccurredAt = time.Now()
	}

	s.mutex.Lock()
	defer s.mutex.Unlock()

	if _, _, err := s.db.Get(replayObservationKey(obs.ObservationID)); err == nil {
		return nil
	} else if err != pebble.ErrNotFound {
		return err
	}

	rec, err := s.loadRecordLocked(obs.EpisodeID)
	if err != nil {
		return err
	}

	state, ok, err := s.loadReplayStateLocked(obs.EpisodeID)
	if err != nil {
		return err
	}
	if !ok {
		state = initialReplayStateForRecord(*rec, obs.OccurredAt)
	}

	applyReplayOutcome(&state, obs.Outcome, obs.OccurredAt, classifyReplayRecord(*rec))
	switch obs.Outcome {
	case replayObservationNoReview:
		rec.ReplayNoReviewCount++
		if strings.TrimSpace(obs.SkippedReason) != "" {
			rec.LastReplaySkipReason = strings.TrimSpace(obs.SkippedReason)
		}
	default:
		rec.ReplayReviewedCount++
		rec.LastReplayAt = obs.OccurredAt
	}

	stateData, err := json.Marshal(state)
	if err != nil {
		return err
	}
	obsData, err := json.Marshal(obs)
	if err != nil {
		return err
	}

	batch := s.db.NewBatch()
	defer batch.Close()
	batch.Set(replayStateKey(obs.EpisodeID), stateData, nil)
	batch.Set(replayObservationKey(obs.ObservationID), obsData, nil)
	return batch.Commit(pebble.Sync)
}

func (s *Store) PromoteReplayStateToParent(children []string, parentID string, now time.Time) error {
	parentID = strings.TrimSpace(parentID)
	if parentID == "" {
		return nil
	}

	parentRec, err := s.loadRecordLocked(parentID)
	if err != nil {
		return err
	}

	bestState := initialReplayStateForRecord(*parentRec, now)
	bestScore := -1.0
	haveCandidate := false

	if parentState, ok, err := s.loadReplayStateLocked(parentID); err == nil && ok {
		bestState = parentState
		bestScore = replayStateScore(parentState)
		haveCandidate = true
	} else if err != nil {
		return err
	}

	for _, childID := range children {
		childID = strings.TrimSpace(childID)
		if childID == "" {
			continue
		}
		childState, ok, err := s.GetReplayState(childID)
		if err != nil {
			return err
		}
		if !ok {
			continue
		}
		score := replayStateScore(childState)
		if !haveCandidate || score > bestScore {
			bestState = childState
			bestScore = score
			haveCandidate = true
		}
	}

	if !haveCandidate {
		bestState = initialReplayStateForRecord(*parentRec, now)
	}

	if err := s.UpsertReplayState(parentID, bestState, func(st *ReplayState) error {
		*st = bestState
		return nil
	}); err != nil {
		return err
	}

	for _, childID := range children {
		childID = strings.TrimSpace(childID)
		if childID == "" || childID == parentID {
			continue
		}
		_ = s.DeleteReplayState(childID)
	}

	return nil
}

func replayStateScore(state ReplayState) float64 {
	return (float64(state.ReviewCount) * 100.0) + (state.Stability * 10.0) + float64(state.DueAt.Unix()%1000)
}

func (s *Store) ListDueReplayCandidates(now time.Time, limit int) ([]ReplayCandidate, error) {
	if limit <= 0 {
		limit = 3
	}

	seen := make(map[string]struct{})
	candidates := make([]ReplayCandidate, 0, limit*2)

	appendCandidate := func(rec EpisodeRecord) error {
		if strings.TrimSpace(rec.ID) == "" {
			return nil
		}
		if _, ok := seen[rec.ID]; ok {
			return nil
		}

		cls := classifyReplayRecord(rec)
		if cls == replayClassD0 {
			return nil
		}

		// Phase 3.1: Replay Scheduler gates
		// Ensure only high importance, low noise items are revived
		if rec.ImportanceScore < 0.60 || rec.NoiseScore >= 0.5 {
			return nil
		}

		state, ok, err := s.GetReplayState(rec.ID)
		if err != nil {
			return err
		}
		if !ok {
			state = initialReplayStateForRecord(rec, now)
			if err := s.UpsertReplayState(rec.ID, state, nil); err != nil {
				return err
			}
		}
		if state.DueAt.After(now) {
			return nil
		}

		seen[rec.ID] = struct{}{}
		candidates = append(candidates, ReplayCandidate{
			Record:   rec,
			State:    state,
			Class:    string(cls),
			Priority: replayPriorityForClass(cls),
		})
		return nil
	}

	if d1Nodes, err := s.ListByTag("d1-summary"); err == nil {
		for _, rec := range d1Nodes {
			if err := appendCandidate(rec); err != nil {
				return nil, err
			}
		}
	}
	if manualNodes, err := s.ListByTag("manual-save"); err == nil {
		for _, rec := range manualNodes {
			if err := appendCandidate(rec); err != nil {
				return nil, err
			}
		}
	}
	if activeD0, _, err := s.SnapshotActiveD0Records(); err == nil {
		for _, rec := range activeD0 {
			if !isHighSalienceSingleton(rec) {
				continue
			}
			if err := appendCandidate(rec); err != nil {
				return nil, err
			}
		}
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].State.DueAt.Equal(candidates[j].State.DueAt) {
			if candidates[i].Priority == candidates[j].Priority {
				return candidates[i].Record.ID < candidates[j].Record.ID
			}
			return candidates[i].Priority > candidates[j].Priority
		}
		return candidates[i].State.DueAt.Before(candidates[j].State.DueAt)
	})

	if len(candidates) > limit {
		candidates = candidates[:limit]
	}
	return candidates, nil
}

func buildReplayReviewPrompt(rec EpisodeRecord, state ReplayState, cls replayClass) string {
	body := ""
	if strings.TrimSpace(rec.SourcePath) != "" {
		if doc, err := frontmatter.Parse(rec.SourcePath); err == nil {
			body = doc.Body
		}
	}
	if body == "" {
		body = rec.Title
	}
	if body == "" {
		body = rec.ID
	}

	runes := []rune(body)
	if len(runes) > 4000 {
		body = string(runes[:4000])
	}

	return fmt.Sprintf(`Review this episodic memory as a short rehearsal.
Keep the answer concrete, grounded in the episode, and under 120 words.
Do not invent facts. Preserve the most useful detail for later recall.

Class: %s
Episode ID: %s
Due at: %s
Stability: %.3f
Retrievability: %.3f
Desired retention: %.2f

---
%s
---
`, cls, rec.ID, state.DueAt.Format(time.RFC3339), state.Stability, state.Retrievability, state.DesiredRetention, body)
}

func RunReplayScheduler(ctx context.Context, agentWs string, apiKey string, vstore *Store, limiter *rate.Limiter) error {
	logger.Info(logger.CatBackground, "Starting replay scheduler for %s\n", agentWs)

	startedAt := time.Now()
	now := startedAt
	candidates, err := vstore.ListDueReplayCandidates(now, 3)
	if err != nil {
		return fmt.Errorf("failed to list replay candidates: %w", err)
	}
	if len(candidates) == 0 {
		logger.Info(logger.CatBackground, "No due replay candidates for %s\n", agentWs)
		summary := ReplayRunSummary{
			WorkspaceID:   agentWs,
			StartedAt:     startedAt,
			FinishedAt:    time.Now(),
			DueCandidates: 0,
		}
		if data, marshalErr := json.Marshal(summary); marshalErr == nil {
			_ = vstore.SetMeta("replay:last_summary", data)
		}
		return nil
	}

	rawLLM := ai.NewGoogleStudioProvider(apiKey, "gemma-3-27b-it")
	llm := &ai.RetryLLM{
		Inner:      rawLLM,
		Limiter:    limiter,
		MaxRetries: 2,
		BaseDelay:  2 * time.Second,
	}

	summary := ReplayRunSummary{
		WorkspaceID:   agentWs,
		StartedAt:     startedAt,
		DueCandidates: len(candidates),
	}
	processed := 0
	for _, cand := range candidates {
		if processed >= 2 {
			break
		}

		holder := fmt.Sprintf("replay:%s", agentWs)
		ok, err := vstore.AcquireReplayLease(cand.Record.ID, holder, 20*time.Minute)
		if err != nil {
			summary.ErrorCount++
			return err
		}
		if !ok {
			summary.LeaseConflictCount++
			continue
		}

		processed++
		summary.SelectedCount++
		_ = vstore.RecordReplaySelection(cand.Record.ID, time.Now(), int64(time.Since(cand.State.DueAt).Seconds()))
		func() {
			defer func() { _ = vstore.ReleaseReplayLease(cand.Record.ID) }()

			prompt := buildReplayReviewPrompt(cand.Record, cand.State, replayClass(cand.Class))
			reviewCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
			defer cancel()

			body, reviewErr := llm.GenerateText(reviewCtx, prompt)
			outcome := replayObservationAgain
			if reviewErr == nil && strings.TrimSpace(body) != "" {
				outcome = replayObservationExpandedGood
			}
			if reviewErr == nil {
				summary.ReviewedCount++
			}

			obs := ReplayObservation{
				ObservationID: fmt.Sprintf("replay:%s:%s:%d", agentWs, cand.Record.ID, cand.State.DueAt.UnixNano()),
				WorkspaceID:   agentWs,
				EpisodeID:     cand.Record.ID,
				Outcome:       outcome,
				OccurredAt:    time.Now(),
				Source:        "replay-worker",
				Selected:      true,
				DueLagSeconds: int64(time.Since(cand.State.DueAt).Seconds()),
			}
			if err := vstore.ApplyReplayObservation(obs); err != nil {
				logger.Info(logger.CatBackground, "Failed to apply observation for %s: %v\n", cand.Record.ID, err)
				summary.ErrorCount++
				return
			}
			if reviewErr != nil {
				logger.Info(logger.CatBackground, "Replay review failed for %s: %v\n", cand.Record.ID, reviewErr)
				summary.ErrorCount++
				return
			}
			logger.Info(logger.CatBackground, "Reviewed %s (%s)\n", cand.Record.ID, cand.Class)
		}()
	}

	if remaining := len(candidates) - processed - summary.LeaseConflictCount; remaining > 0 {
		summary.BudgetSkipCount = remaining
	}
	summary.FinishedAt = time.Now()
	if data, marshalErr := json.Marshal(summary); marshalErr == nil {
		_ = vstore.SetMeta("replay:last_summary", data)
	}

	return nil
}
