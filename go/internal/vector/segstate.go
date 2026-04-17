package vector

import (
	"fmt"
	"time"

	"github.com/cockroachdb/pebble"
	"github.com/vmihailenco/msgpack/v5"
)

var (
	prefixSegState = []byte("meta:segstate:")
)

// SegmentationState tracks an agent-specific running distribution of raw surprise scores.
// We keep this small and persistent (Pebble) so the threshold can adapt per agent/workspace.
type SegmentationState struct {
	Count            int     `msgpack:"count"`
	Mean             float64 `msgpack:"mean"`
	Variance         float64 `msgpack:"variance"`
	LastBoundaryTurn int     `msgpack:"lastBoundaryTurn"`
	UpdatedAtUnix    int64   `msgpack:"updatedAtUnix"`
}

func segStateKey(agentId string) []byte {
	return append(append([]byte(nil), prefixSegState...), []byte(agentId)...)
}

func (s *Store) GetSegmentationState(agentId string) (SegmentationState, error) {
	if agentId == "" {
		agentId = "auto"
	}
	key := segStateKey(agentId)

	s.mutex.RLock()
	val, closer, err := s.db.Get(key)
	s.mutex.RUnlock()
	if err == pebble.ErrNotFound {
		return SegmentationState{}, nil
	}
	if err != nil {
		return SegmentationState{}, err
	}
	defer closer.Close()

	var st SegmentationState
	if uerr := msgpack.Unmarshal(val, &st); uerr != nil {
		return SegmentationState{}, fmt.Errorf("segstate decode failed: %w", uerr)
	}
	return st, nil
}

// ShouldCooldownSuppress determines whether a boundary detection should be suppressed
// by cooldown logic. Returns true if the boundary should be suppressed.
//
// The delta guard (delta >= 0) prevents negative deltas caused by TS process restart
// (which resets turnSeq to 0) from incorrectly suppressing boundaries when
// LastBoundaryTurn is persisted in Pebble DB.
func ShouldCooldownSuppress(turn, lastBoundaryTurn, cooldown int) bool {
	if cooldown <= 0 || lastBoundaryTurn <= 0 || turn <= 0 {
		return false
	}
	delta := turn - lastBoundaryTurn
	return delta >= 0 && delta <= cooldown
}

func (s *Store) PutSegmentationState(agentId string, st SegmentationState) error {
	if agentId == "" {
		agentId = "auto"
	}
	st.UpdatedAtUnix = time.Now().Unix()
	key := segStateKey(agentId)

	data, err := msgpack.Marshal(&st)
	if err != nil {
		return fmt.Errorf("segstate encode failed: %w", err)
	}

	s.mutex.Lock()
	defer s.mutex.Unlock()
	return s.db.Set(key, data, pebble.NoSync)
}
