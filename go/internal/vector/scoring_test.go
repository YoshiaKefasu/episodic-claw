package vector

import (
	"testing"
)

func TestPhase3ScoringGates(t *testing.T) {
	// AC-2: Verify Manual Save / D1 / High Surprise scores >= 0.6
	tests := []struct {
		name     string
		tags     []string
		surprise float64
		wantMin  float32
	}{
		{
			name:     "Manual Save only",
			tags:     []string{"manual-save"},
			surprise: 0.0,
			wantMin:  0.6,
		},
		{
			name:     "D1 only",
			tags:     []string{"d1-summary"},
			surprise: 0.0,
			wantMin:  0.6,
		},
		{
			name:     "High Surprise only (0.8)",
			tags:     []string{},
			surprise: 0.8,
			wantMin:  0.6,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := EpisodeRecord{
				Tags:     tt.tags,
				Surprise: tt.surprise,
				// Assume 0 views/retrievals (newly added)
				Retrievals:          0,
				ReplayReviewedCount: 0,
			}
			CalculateImportanceStage1(&rec)
			if rec.ImportanceScore < tt.wantMin {
				t.Errorf("ImportanceScore = %v, want >= %v", rec.ImportanceScore, tt.wantMin)
			}
		})
	}
}
