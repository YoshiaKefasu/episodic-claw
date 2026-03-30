package vector

import (
	"testing"
	"time"

	"episodic-core/frontmatter"
)

func TestReplayOutcomeClassify(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"DirectGood":   replayObservationExpandedGood,
		"ExpandedGood": replayObservationExpandedGood,
		"Good":         replayObservationExpandedGood,
		"Again":        replayObservationAgain,
		"Miss":         replayObservationAgain,
		"NoReview":     replayObservationNoReview,
		"  custom  ":   "custom",
	}

	for input, want := range cases {
		if got := replayOutcomeClassify(input); got != want {
			t.Fatalf("replayOutcomeClassify(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestInitialReplayStateForRecordByClass(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 30, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name string
		rec  EpisodeRecord
		want replayClass
	}{
		{
			name: "d1",
			rec:  EpisodeRecord{Tags: []string{"d1-summary"}},
			want: replayClassD1,
		},
		{
			name: "manual-save",
			rec:  EpisodeRecord{Tags: []string{"manual-save"}},
			want: replayClassManual,
		},
		{
			name: "singleton",
			rec:  EpisodeRecord{Surprise: 0.9},
			want: replayClassSingleton,
		},
		{
			name: "d0",
			rec:  EpisodeRecord{Surprise: 0.2},
			want: replayClassD0,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			state := initialReplayStateForRecord(tc.rec, now)
			if state.DueAt.IsZero() {
				t.Fatalf("initialReplayStateForRecord(%s) returned zero DueAt", tc.name)
			}
			if got := classifyReplayRecord(tc.rec); got != tc.want {
				t.Fatalf("classifyReplayRecord(%s) = %q, want %q", tc.name, got, tc.want)
			}
		})
	}
}

func TestApplyReplayOutcome(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 3, 30, 12, 0, 0, 0, time.UTC)
	state := ReplayState{
		Stability:        1.0,
		Retrievability:   0.80,
		Difficulty:       0.50,
		DesiredRetention: 0.85,
		DueAt:            now,
	}
	applyReplayOutcome(&state, replayObservationExpandedGood, now, replayClassD1)
	if state.ReviewCount == 0 {
		t.Fatalf("expected review count to increment")
	}
	if state.DueAt.Before(now) {
		t.Fatalf("expected due date to move forward")
	}
	if state.Retrievability < 0.85 {
		t.Fatalf("expected retrievability to stay at or above desired retention")
	}
}

func TestReplayRecordKeptTopicsFallbackNeutral(t *testing.T) {
	t.Parallel()

	rec := EpisodeRecord{
		ID:         "ep-1",
		Topics:     nil,
		Tags:       []string{"manual-save"},
		SourcePath: "",
		Edges:      []frontmatter.Edge{},
	}
	if cls := classifyReplayRecord(rec); cls != replayClassManual {
		t.Fatalf("expected manual-save class, got %q", cls)
	}
}
