package vector

import (
	"testing"
)

// TestCooldownDeltaGuard verifies the ShouldCooldownSuppress function
// that was added in v0.4.16b to prevent negative deltas (caused by
// TS process restart resetting turnSeq to 0 while Go persists
// LastBoundaryTurn in Pebble DB) from incorrectly suppressing
// boundary detection.
//
// By calling the production function directly, this test ensures
// that future changes to main.go's cooldown logic will be caught
// if they diverge from the expected behavior.
func TestCooldownDeltaGuard(t *testing.T) {
	tests := []struct {
		name              string
		turn              int
		lastBoundaryTurn  int
		cooldown          int
		expectCooldownHit bool
		reason            string
	}{
		{
			name:              "negative_delta_restart_case_Turn1_LastBoundary100",
			turn:              1,
			lastBoundaryTurn:  100,
			cooldown:          2,
			expectCooldownHit: false,
			reason:            "restart: turnSeq reset to 0→1 but LastBoundaryTurn=100 from Pebble",
		},
		{
			name:              "negative_delta_restart_case_Turn5_LastBoundary50",
			turn:              5,
			lastBoundaryTurn:  50,
			cooldown:          3,
			expectCooldownHit: false,
			reason:            "restart: delta=-45 should NOT trigger cooldown",
		},
		{
			name:              "zero_delta_same_turn_reredetection",
			turn:              5,
			lastBoundaryTurn:  5,
			cooldown:          2,
			expectCooldownHit: true,
			reason:            "same-turn re-detection (delta=0) SHOULD be suppressed by cooldown",
		},
		{
			name:              "positive_delta_within_cooldown",
			turn:              5,
			lastBoundaryTurn:  3,
			cooldown:          2,
			expectCooldownHit: true,
			reason:            "delta=2, 2 >= 0 && 2 <= 2 → cooldown triggers (normal case)",
		},
		{
			name:              "positive_delta_at_cooldown_boundary",
			turn:              10,
			lastBoundaryTurn:  8,
			cooldown:          2,
			expectCooldownHit: true,
			reason:            "delta=2, exactly at cooldown boundary → triggers",
		},
		{
			name:              "positive_delta_beyond_cooldown",
			turn:              10,
			lastBoundaryTurn:  3,
			cooldown:          2,
			expectCooldownHit: false,
			reason:            "delta=7, 7 > 2 → cooldown does NOT trigger",
		},
		{
			name:              "large_negative_delta_restart",
			turn:              1,
			lastBoundaryTurn:  9999,
			cooldown:          5,
			expectCooldownHit: false,
			reason:            "large negative delta after restart should never trigger cooldown",
		},
		{
			name:              "zero_cooldown_disables_check",
			turn:              5,
			lastBoundaryTurn:  4,
			cooldown:          0,
			expectCooldownHit: false,
			reason:            "cooldown=0 means cooldown is disabled entirely",
		},
		{
			name:              "zero_LastBoundaryTurn_first_session",
			turn:              5,
			lastBoundaryTurn:  0,
			cooldown:          2,
			expectCooldownHit: false,
			reason:            "LastBoundaryTurn=0 (first session) → outer guard skips block",
		},
		{
			name:              "zero_turn_ignores_cooldown",
			turn:              0,
			lastBoundaryTurn:  5,
			cooldown:          2,
			expectCooldownHit: false,
			reason:            "turn=0 is invalid → outer guard skips block",
		},
		{
			name:              "negative_cooldown_treated_as_disabled",
			turn:              5,
			lastBoundaryTurn:  3,
			cooldown:          -1,
			expectCooldownHit: false,
			reason:            "negative cooldown is treated as disabled",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ShouldCooldownSuppress(tt.turn, tt.lastBoundaryTurn, tt.cooldown)
			if got != tt.expectCooldownHit {
				t.Errorf("ShouldCooldownSuppress(%d, %d, %d) = %v, want %v: %s",
					tt.turn, tt.lastBoundaryTurn, tt.cooldown, got, tt.expectCooldownHit, tt.reason)
			}
		})
	}
}

// TestCooldownNegativeDeltaOldBehaviorBroken demonstrates the OLD behavior
// (without delta >= 0 guard) that caused the v0.4.16b bug.
// It also verifies that ShouldCooldownSuppress produces the correct (fixed) result.
func TestCooldownNegativeDeltaOldBehaviorBroken(t *testing.T) {
	// OLD code: if params.Turn - st.LastBoundaryTurn <= cooldown { suppress }
	// This would evaluate: 1 - 100 = -99 <= 2 → true → WRONG suppression
	turn := 1
	lastBoundaryTurn := 100
	cooldown := 2

	oldBehaviorHit := (turn - lastBoundaryTurn) <= cooldown
	if !oldBehaviorHit {
		t.Error("old behavior sanity check: -99 <= 2 should be true (this is the bug)")
	}

	// NEW code: ShouldCooldownSuppress correctly rejects negative deltas
	newBehaviorHit := ShouldCooldownSuppress(turn, lastBoundaryTurn, cooldown)
	if newBehaviorHit {
		t.Error("ShouldCooldownSuppress: negative delta should NOT trigger cooldown")
	}
}
