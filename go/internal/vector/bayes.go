package vector

import (
	"math"
	"time"
)

const (
	defaultAlpha float32 = 1.0
	defaultBeta  float32 = 1.0
)

func usefulnessPosteriorMean(hits int, retrievals int, alpha float32, beta float32) float32 {
	a := alpha
	b := beta
	if a <= 0 {
		a = defaultAlpha
	}
	if b <= 0 {
		b = defaultBeta
	}
	return (a + float32(hits)) / (a + b + float32(retrievals))
}

func explorationBonus(retrievals int) float32 {
	if retrievals < 0 {
		return 0
	}
	return 0.05 / (1.0 + float32(retrievals))
}

func surprisePriorScore(surprise float64) float32 {
	if surprise <= 0 {
		return 0
	}
	denom := math.Log1p(2.0)
	if denom <= 0 {
		denom = 1
	}
	score := math.Log1p(surprise) / denom
	if score < 0 {
		score = 0
	} else if score > 1 {
		score = 1
	}
	return float32(score)
}

func freshnessScore(ts time.Time, now time.Time) float32 {
	if ts.IsZero() {
		return 0
	}
	daysOld := float64(now.Sub(ts).Hours() / 24.0)
	if daysOld < 0 {
		daysOld = 0
	}
	// Inverse proportional decay based on the scalable_architecture_plan.md definition:
	// FinalScore(Freshness) = 1.0 / (1.0 + (DaysFromNow * DecayFactor))
	// We use 0.05 as the DecayFactor here, meaning after 20 days, the score is 0.5.
	return float32(1.0 / (1.0 + (daysOld * 0.05)))
}
