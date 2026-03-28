package vector

import (
	"math"
	"regexp"
	"strings"
)

// slugify normalizes a string into a URL-safe slug
func slugify(s string) string {
	s = strings.ToLower(s)
	reg := regexp.MustCompile("[^a-z0-9]+")
	s = reg.ReplaceAllString(s, "-")
	return strings.Trim(s, "-")
}

// CosineDistance calculates the cosine distance (1 - cosine similarity) between two vectors.
// Returns a value in [0.0, 2.0], where 0.0 = identical, 1.0 = orthogonal, 2.0 = opposite.
// Suitable as a Surprise score: higher = more surprising relative to the previous episode.
func CosineDistance(a, b []float32) float64 {
	var dot, magA, magB float64
	for i := range a {
		dot += float64(a[i]) * float64(b[i])
		magA += float64(a[i]) * float64(a[i])
		magB += float64(b[i]) * float64(b[i])
	}
	if magA == 0 || magB == 0 {
		return 1.0 // Maximum distance if embedding is zero vector
	}
	return 1.0 - (dot / (math.Sqrt(magA) * math.Sqrt(magB)))
}
