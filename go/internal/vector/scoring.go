package vector

import (
	"math"
	"time"
)

// Sigmoid squashes a raw score into the [0.0, 1.0] range.
func sigmoid(x float64) float32 {
	return float32(1.0 / (1.0 + math.Exp(-x)))
}

// ComputeSalience calculates the local salience of an episode.
// Moved from d1_clustering.go for DRY principle.
func ComputeSalience(rec EpisodeRecord) float64 {
	if hasTag(rec.Tags, "manual-save") {
		return 1.0
	}
	score := math.Log1p(max(rec.Surprise, 0)) / math.Log1p(1.0)
	if rec.Hits > 0 {
		score += 0.1
	}
	return clamp01(score)
}

// ComputeWeakness calculates the retrievability weakness of an episode.
// Moved from d1_clustering.go for DRY principle.
func ComputeWeakness(rec EpisodeRecord) float64 {
	if rec.Retrievals <= 0 {
		return 1.0
	}
	hitRate := float64(rec.Hits) / float64(max(rec.Retrievals, 1))
	return clamp01(1.0 - hitRate)
}

// CalculateImportanceStage1 performs lightweight importance calculation
// without heavy DB scans. Called when ingest adds/updates an episode.
func CalculateImportanceStage1(rec *EpisodeRecord) {
	var rawImportance float64

	if hasTag(rec.Tags, "manual-save") {
		rawImportance += 2.0
	}
	if hasTag(rec.Tags, "d1-summary") {
		rawImportance += 1.5
	}
	rawImportance += 2.0 * rec.Surprise

	// 未レビュー(views==0)の場合、未経験ボーナスとして0.5追加し、初期のPruneを防止
	if rec.Retrievals == 0 && rec.ReplayReviewedCount == 0 {
		rawImportance += 0.5
	}

	// Bias = 1.5 程度（正のシグナルがない場合に Importance を Low < 0.3 側に引っ張るため）
	rec.ImportanceScore = sigmoid(rawImportance - 1.5)
	rec.LastScoredAt = time.Now()
}

// ScoreUpdateParams holds async calculated signals for Stage 2.
type ScoreUpdateParams struct {
	AgeWithoutReusePenalty float64
	TopicsPersistence      float64
	RedundancyWithD1       float64
	NoExpandNoHit          float64
}

// CalculateScoreStage2 performs full calculation of both ImportanceScore
// and NoiseScore using async signals.
func CalculateScoreStage2(rec *EpisodeRecord, params ScoreUpdateParams) {
	var rawImportance float64

	if hasTag(rec.Tags, "manual-save") {
		rawImportance += 2.0
	}
	if hasTag(rec.Tags, "d1-summary") {
		rawImportance += 1.5
	}
	rawImportance += 2.0 * rec.Surprise
	rawImportance += 0.5 * math.Log1p(float64(rec.Hits+rec.ExpandCount+1))
	rawImportance += 0.5 * params.TopicsPersistence
	rawImportance -= 1.0 * params.RedundancyWithD1

	if rec.Retrievals == 0 && rec.ReplayReviewedCount == 0 {
		rawImportance += 0.5
	}

	rec.ImportanceScore = sigmoid(rawImportance - 1.5)

	var rawNoise float64
	rawNoise += 2.0 * params.RedundancyWithD1
	rawNoise += 1.0 * params.AgeWithoutReusePenalty
	rawNoise += 1.0 * params.NoExpandNoHit

	// Bias = 1.0 程度（ノイズ要素がない場合は 0.5 未満に抑える）
	rec.NoiseScore = sigmoid(rawNoise - 1.0)
	rec.LastScoredAt = time.Now()
}
