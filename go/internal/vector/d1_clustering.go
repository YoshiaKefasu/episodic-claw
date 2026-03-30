package vector

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"episodic-core/frontmatter"

	"github.com/cockroachdb/pebble"
	"github.com/vmihailenco/msgpack/v5"
)

const (
	consolidationFailedTag = "consolidation-failed"
	consolidationSkipTag   = "consolidation-skip"
)

type d1ClusterConfig struct {
	MaxActiveD0          int
	MaxWindow            time.Duration
	MinNodeSimilarity    float64
	MinContextSimilarity float64
	MaxNeighborGap       time.Duration
	MinClusterSize       int
	MaxClusterSize       int
	MaxClusterSpan       time.Duration
	BoundaryCut          float64
	HighSalienceCut      float64
	FallbackChunkSize    int
	MaxClusterTokens     int
	PerNodeTokenCap      int
}

type d1ConsolidationNode struct {
	Record           EpisodeRecord
	Index            int
	NormalizedVector []float32
	ContextVector    []float32
	SalienceScore    float64
	WeaknessScore    float64
	EstimatedTokens  int
	BoundaryAfter    bool
}

type d1ConsolidationCluster struct {
	Nodes           []d1ConsolidationNode
	Fingerprint     string
	ReplayPriority  float64
	EstimatedTokens int
	StartTime       time.Time
	EndTime         time.Time
	UsedFallback    bool
}

func defaultD1ClusterConfig() d1ClusterConfig {
	return d1ClusterConfig{
		MaxActiveD0:          200,
		MaxWindow:            72 * time.Hour,
		MinNodeSimilarity:    0.82,
		MinContextSimilarity: 0.70,
		MaxNeighborGap:       24 * time.Hour,
		MinClusterSize:       3,
		MaxClusterSize:       12,
		MaxClusterSpan:       48 * time.Hour,
		BoundaryCut:          0.20,
		HighSalienceCut:      0.75,
		FallbackChunkSize:    10,
		MaxClusterTokens:     3200,
		PerNodeTokenCap:      640,
	}
}

func collectActiveD0Nodes(vstore *Store) ([]EpisodeRecord, error) {
	if snapshot, usedIndex, err := vstore.SnapshotActiveD0Records(); err == nil && usedIndex {
		return snapshot, nil
	}

	var d0Nodes []EpisodeRecord
	vstore.mutex.RLock()
	iter, err := vstore.db.NewIter(&pebble.IterOptions{
		LowerBound: prefixEp,
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		vstore.mutex.RUnlock()
		return nil, fmt.Errorf("failed to iter unarchived nodes: %w", err)
	}
	defer iter.Close()

	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err != nil {
			continue
		}
		if isActiveD0Record(rec) {
			d0Nodes = append(d0Nodes, rec)
		}
	}
	vstore.mutex.RUnlock()

	sort.SliceStable(d0Nodes, func(i, j int) bool {
		if d0Nodes[i].Timestamp.Equal(d0Nodes[j].Timestamp) {
			return d0Nodes[i].ID < d0Nodes[j].ID
		}
		return d0Nodes[i].Timestamp.Before(d0Nodes[j].Timestamp)
	})
	return d0Nodes, nil
}

func quarantineConsolidationRecord(vstore *Store, rec EpisodeRecord, reason string) {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		reason = "unknown"
	}
	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Quarantining D0 %s: %s\n", rec.ID, reason)

	quarantineTags := []string{consolidationSkipTag, consolidationFailedTag}
	if err := vstore.UpdateRecord(rec.ID, func(target *EpisodeRecord) error {
		target.Tags = appendUniqueTags(target.Tags, quarantineTags...)
		return nil
	}); err != nil {
		fmt.Fprintf(os.Stderr, "[SleepConsolidation] Failed to quarantine D0 %s in store: %v\n", rec.ID, err)
	}

	sourcePath := strings.TrimSpace(rec.SourcePath)
	if sourcePath == "" {
		return
	}

	doc, err := frontmatter.Parse(sourcePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[SleepConsolidation] Failed to parse quarantined D0 %s for on-disk update: %v\n", rec.ID, err)
		return
	}
	doc.Metadata.Tags = appendUniqueTags(doc.Metadata.Tags, quarantineTags...)
	doc.Metadata.RefineFailed = true
	if err := frontmatter.Serialize(sourcePath, doc); err != nil {
		fmt.Fprintf(os.Stderr, "[SleepConsolidation] Failed to serialize quarantined D0 %s: %v\n", rec.ID, err)
	}
}

func appendUniqueTags(tags []string, additions ...string) []string {
	if len(additions) == 0 {
		return tags
	}
	seen := make(map[string]struct{}, len(tags)+len(additions))
	result := make([]string, 0, len(tags)+len(additions))
	for _, tag := range tags {
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		result = append(result, tag)
	}
	for _, tag := range additions {
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		result = append(result, tag)
	}
	return result
}

func loadExistingConsolidationKeys(vstore *Store) (map[string]string, error) {
	result := make(map[string]string)
	d1Nodes, err := vstore.ListByTag("d1-summary")
	if err != nil {
		return result, err
	}
	for _, rec := range d1Nodes {
		if strings.TrimSpace(rec.SourcePath) == "" {
			continue
		}
		doc, err := frontmatter.Parse(rec.SourcePath)
		if err != nil {
			continue
		}
		key := strings.TrimSpace(doc.Metadata.ConsolidationKey)
		if key == "" {
			childIDs := make([]string, 0, len(doc.Metadata.RelatedTo))
			for _, edge := range doc.Metadata.RelatedTo {
				if edge.Type == "child" && strings.TrimSpace(edge.ID) != "" {
					childIDs = append(childIDs, edge.ID)
				}
			}
			key = clusterFingerprint(childIDs)
		}
		if key != "" {
			result[key] = rec.ID
		}
	}
	return result, nil
}

func buildD1Clusters(d0Nodes []EpisodeRecord, now time.Time, cfg d1ClusterConfig) ([]d1ConsolidationCluster, error) {
	active := trimActiveD0Nodes(d0Nodes, now, cfg)
	if len(active) == 0 {
		return nil, nil
	}

	nodes := buildConsolidationNodes(active, cfg)
	if len(nodes) == 0 {
		return legacyChunkClusters(active, cfg), nil
	}

	components := exactPairwiseComponents(nodes, cfg)
	clusters := buildClustersFromComponents(components, cfg)
	if shouldFallbackToLegacy(clusters, len(nodes), cfg) {
		return legacyChunkClusters(active, cfg), nil
	}
	assignReplayPriority(clusters, now, cfg)
	sortClustersByPriority(clusters)
	return clusters, nil
}

func trimActiveD0Nodes(d0Nodes []EpisodeRecord, now time.Time, cfg d1ClusterConfig) []EpisodeRecord {
	if len(d0Nodes) == 0 {
		return nil
	}

	cutoff := now.Add(-cfg.MaxWindow)
	filtered := make([]EpisodeRecord, 0, len(d0Nodes))
	for _, rec := range d0Nodes {
		if len(rec.Vector) != 3072 {
			continue
		}
		if rec.Timestamp.Before(cutoff) {
			continue
		}
		filtered = append(filtered, rec)
	}

	if len(filtered) == 0 {
		filtered = append(filtered, d0Nodes...)
	}
	if len(filtered) > cfg.MaxActiveD0 {
		filtered = filtered[len(filtered)-cfg.MaxActiveD0:]
	}
	return filtered
}

func buildConsolidationNodes(records []EpisodeRecord, cfg d1ClusterConfig) []d1ConsolidationNode {
	nodes := make([]d1ConsolidationNode, 0, len(records))
	for idx, rec := range records {
		norm := normalizeVector(rec.Vector)
		if len(norm) == 0 {
			continue
		}
		nodes = append(nodes, d1ConsolidationNode{
			Record:           rec,
			Index:            idx,
			NormalizedVector: norm,
			SalienceScore:    computeSalience(rec, cfg),
			WeaknessScore:    computeWeakness(rec),
			EstimatedTokens:  estimateNodeTokens(rec, cfg),
			BoundaryAfter:    hasBoundaryAfter(rec, cfg),
		})
	}

	for idx := range nodes {
		nodes[idx].ContextVector = buildContextVector(nodes, idx)
	}
	return nodes
}

func normalizeVector(vec []float32) []float32 {
	if len(vec) == 0 {
		return nil
	}
	var norm float64
	for _, value := range vec {
		norm += float64(value * value)
	}
	if norm == 0 {
		return nil
	}
	scale := float32(1.0 / math.Sqrt(norm))
	result := make([]float32, len(vec))
	for idx, value := range vec {
		result[idx] = value * scale
	}
	return result
}

func buildContextVector(nodes []d1ConsolidationNode, idx int) []float32 {
	base := make([]float32, len(nodes[idx].NormalizedVector))
	if idx == 0 {
		copy(base, nodes[idx].NormalizedVector)
		return base
	}

	weights := []float32{0.6, 0.3, 0.1}
	var total float32
	for offset, weight := range weights {
		source := idx - (offset + 1)
		if source < 0 {
			continue
		}
		total += weight
		addScaledVector(base, nodes[source].NormalizedVector, weight)
	}
	if total == 0 {
		copy(base, nodes[idx].NormalizedVector)
		return base
	}
	return normalizeVector(base)
}

func addScaledVector(dst []float32, src []float32, scale float32) {
	for idx := range dst {
		dst[idx] += src[idx] * scale
	}
}

func computeSalience(rec EpisodeRecord, cfg d1ClusterConfig) float64 {
	if hasTag(rec.Tags, "manual-save") {
		return 1.0
	}
	score := math.Log1p(max(rec.Surprise, 0)) / math.Log1p(1.0)
	if rec.Hits > 0 {
		score += 0.1
	}
	return clamp01(score)
}

func computeWeakness(rec EpisodeRecord) float64 {
	if rec.Retrievals <= 0 {
		return 1.0
	}
	hitRate := float64(rec.Hits) / float64(max(rec.Retrievals, 1))
	return clamp01(1.0 - hitRate)
}

func estimateNodeTokens(rec EpisodeRecord, cfg d1ClusterConfig) int {
	estimate := rec.Tokens
	if estimate <= 0 {
		estimate = 256
	}
	return min(estimate, cfg.PerNodeTokenCap)
}

func hasBoundaryAfter(rec EpisodeRecord, cfg d1ClusterConfig) bool {
	if hasTag(rec.Tags, "surprise-boundary") {
		return true
	}
	return rec.Surprise >= cfg.BoundaryCut
}

func exactPairwiseComponents(nodes []d1ConsolidationNode, cfg d1ClusterConfig) [][]d1ConsolidationNode {
	if len(nodes) == 0 {
		return nil
	}
	boundariesPrefix := buildBoundaryPrefix(nodes)
	uf := newUnionFind(len(nodes))
	for i := 0; i < len(nodes); i++ {
		for j := i + 1; j < len(nodes); j++ {
			if nodes[j].Record.Timestamp.Sub(nodes[i].Record.Timestamp) > cfg.MaxNeighborGap {
				break
			}
			if crossesBoundary(boundariesPrefix, i, j) {
				continue
			}
			if cosineSimilarity(nodes[i].NormalizedVector, nodes[j].NormalizedVector) < cfg.MinNodeSimilarity {
				continue
			}
			if cosineSimilarity(nodes[i].ContextVector, nodes[j].ContextVector) < cfg.MinContextSimilarity {
				continue
			}
			uf.union(i, j)
		}
	}

	componentsMap := make(map[int][]d1ConsolidationNode)
	for idx := range nodes {
		root := uf.find(idx)
		componentsMap[root] = append(componentsMap[root], nodes[idx])
	}

	components := make([][]d1ConsolidationNode, 0, len(componentsMap))
	for _, component := range componentsMap {
		sort.SliceStable(component, func(i, j int) bool {
			return component[i].Index < component[j].Index
		})
		components = append(components, component)
	}
	sort.SliceStable(components, func(i, j int) bool {
		return components[i][0].Index < components[j][0].Index
	})
	return components
}

func buildBoundaryPrefix(nodes []d1ConsolidationNode) []int {
	prefix := make([]int, len(nodes)+1)
	for idx, node := range nodes {
		prefix[idx+1] = prefix[idx]
		if node.BoundaryAfter {
			prefix[idx+1]++
		}
	}
	return prefix
}

func crossesBoundary(prefix []int, i, j int) bool {
	if j <= i {
		return false
	}
	return prefix[j]-prefix[i] > 0
}

func cosineSimilarity(a []float32, b []float32) float64 {
	if len(a) == 0 || len(a) != len(b) {
		return 0
	}
	var dot float64
	for idx := range a {
		dot += float64(a[idx] * b[idx])
	}
	return dot
}

func buildClustersFromComponents(components [][]d1ConsolidationNode, cfg d1ClusterConfig) []d1ConsolidationCluster {
	clusters := make([]d1ConsolidationCluster, 0, len(components))
	for _, component := range components {
		for _, chunk := range splitNodesByGuards(component, cfg.MaxClusterSize, cfg.MaxClusterSpan, cfg.MaxClusterTokens) {
			clusters = append(clusters, newD1Cluster(chunk, false))
		}
	}
	sort.SliceStable(clusters, func(i, j int) bool {
		return clusters[i].StartTime.Before(clusters[j].StartTime)
	})
	return clusters
}

func legacyChunkClusters(records []EpisodeRecord, cfg d1ClusterConfig) []d1ConsolidationCluster {
	nodes := buildConsolidationNodes(records, cfg)
	if len(nodes) == 0 {
		return nil
	}

	chunks := make([][]d1ConsolidationNode, 0)
	current := make([]d1ConsolidationNode, 0, cfg.FallbackChunkSize)
	currentTokens := 0
	for _, node := range nodes {
		if len(current) > 0 && (len(current) >= cfg.FallbackChunkSize || currentTokens+node.EstimatedTokens > cfg.MaxClusterTokens) {
			chunks = append(chunks, current)
			current = nil
			currentTokens = 0
		}
		current = append(current, node)
		currentTokens += node.EstimatedTokens
	}
	if len(current) > 0 {
		chunks = append(chunks, current)
	}

	clusters := make([]d1ConsolidationCluster, 0, len(chunks))
	for _, chunk := range chunks {
		clusters = append(clusters, newD1Cluster(chunk, true))
	}
	assignReplayPriority(clusters, time.Now(), cfg)
	sortClustersByPriority(clusters)
	return clusters
}

func splitNodesByGuards(nodes []d1ConsolidationNode, maxClusterSize int, maxClusterSpan time.Duration, maxClusterTokens int) [][]d1ConsolidationNode {
	if len(nodes) == 0 {
		return nil
	}
	var result [][]d1ConsolidationNode
	current := make([]d1ConsolidationNode, 0, min(len(nodes), maxClusterSize))
	currentStart := nodes[0].Record.Timestamp
	currentTokens := 0
	for _, node := range nodes {
		spanExceeded := len(current) > 0 && node.Record.Timestamp.Sub(currentStart) > maxClusterSpan
		sizeExceeded := len(current) >= maxClusterSize
		tokenExceeded := len(current) > 0 && currentTokens+node.EstimatedTokens > maxClusterTokens
		if spanExceeded || sizeExceeded || tokenExceeded {
			result = append(result, current)
			current = make([]d1ConsolidationNode, 0, min(len(nodes), maxClusterSize))
			currentStart = node.Record.Timestamp
			currentTokens = 0
		}
		if len(current) == 0 {
			currentStart = node.Record.Timestamp
		}
		current = append(current, node)
		currentTokens += node.EstimatedTokens
	}
	if len(current) > 0 {
		result = append(result, current)
	}
	return result
}

func newD1Cluster(nodes []d1ConsolidationNode, usedFallback bool) d1ConsolidationCluster {
	childIDs := make([]string, 0, len(nodes))
	totalTokens := 0
	var salience float64
	var weakness float64
	for _, node := range nodes {
		childIDs = append(childIDs, node.Record.ID)
		totalTokens += node.EstimatedTokens
		salience += node.SalienceScore
		weakness += node.WeaknessScore
	}
	if len(nodes) == 0 {
		return d1ConsolidationCluster{}
	}
	start := nodes[0].Record.Timestamp
	end := nodes[len(nodes)-1].Record.Timestamp
	priority := 0.7*(salience/float64(len(nodes))) + 0.3*(weakness/float64(len(nodes)))
	if len(nodes) == 1 && nodes[0].SalienceScore >= 0.75 {
		priority += 0.15
	}
	return d1ConsolidationCluster{
		Nodes:           nodes,
		Fingerprint:     clusterFingerprint(childIDs),
		ReplayPriority:  priority,
		EstimatedTokens: totalTokens,
		StartTime:       start,
		EndTime:         end,
		UsedFallback:    usedFallback,
	}
}

func clusterFingerprint(childIDs []string) string {
	if len(childIDs) == 0 {
		return ""
	}
	hash := sha1.Sum([]byte(strings.Join(childIDs, "\x1f")))
	return "d1-" + hex.EncodeToString(hash[:8])
}

func assignReplayPriority(clusters []d1ConsolidationCluster, now time.Time, cfg d1ClusterConfig) {
	for idx := range clusters {
		var salience float64
		var weakness float64
		for _, node := range clusters[idx].Nodes {
			salience += node.SalienceScore
			weakness += node.WeaknessScore
		}
		meanSalience := salience / float64(len(clusters[idx].Nodes))
		meanWeakness := weakness / float64(len(clusters[idx].Nodes))
		recency := 1.0
		if cfg.MaxWindow > 0 {
			age := now.Sub(clusters[idx].EndTime)
			recency = clamp01(1.0 - age.Seconds()/cfg.MaxWindow.Seconds())
		}
		clusters[idx].ReplayPriority = 0.55*meanSalience + 0.25*meanWeakness + 0.20*recency
		if len(clusters[idx].Nodes) == 1 && meanSalience >= cfg.HighSalienceCut {
			clusters[idx].ReplayPriority += 0.15
		}
		if clusters[idx].UsedFallback {
			clusters[idx].ReplayPriority -= 0.05
		}
	}
}

func sortClustersByPriority(clusters []d1ConsolidationCluster) {
	sort.SliceStable(clusters, func(i, j int) bool {
		if clusters[i].ReplayPriority == clusters[j].ReplayPriority {
			return clusters[i].StartTime.Before(clusters[j].StartTime)
		}
		return clusters[i].ReplayPriority > clusters[j].ReplayPriority
	})
}

func shouldFallbackToLegacy(clusters []d1ConsolidationCluster, totalNodes int, cfg d1ClusterConfig) bool {
	if len(clusters) == 0 {
		return true
	}
	if len(clusters) == 1 && len(clusters[0].Nodes) == totalNodes && totalNodes > cfg.MaxClusterSize {
		return true
	}
	smallCount := 0
	for _, cluster := range clusters {
		if len(cluster.Nodes) == 0 {
			return true
		}
		if len(cluster.Nodes) < cfg.MinClusterSize && !(len(cluster.Nodes) == 1 && cluster.Nodes[0].SalienceScore >= cfg.HighSalienceCut) {
			smallCount++
		}
	}
	return totalNodes > cfg.MinClusterSize && smallCount == len(clusters)
}

func hasTag(tags []string, target string) bool {
	for _, tag := range tags {
		if tag == target {
			return true
		}
	}
	return false
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

type unionFind struct {
	parent []int
	rank   []int
}

func newUnionFind(size int) *unionFind {
	parent := make([]int, size)
	rank := make([]int, size)
	for idx := range parent {
		parent[idx] = idx
	}
	return &unionFind{parent: parent, rank: rank}
}

func (u *unionFind) find(x int) int {
	if u.parent[x] != x {
		u.parent[x] = u.find(u.parent[x])
	}
	return u.parent[x]
}

func (u *unionFind) union(a int, b int) {
	rootA := u.find(a)
	rootB := u.find(b)
	if rootA == rootB {
		return
	}
	if u.rank[rootA] < u.rank[rootB] {
		u.parent[rootA] = rootB
		return
	}
	if u.rank[rootA] > u.rank[rootB] {
		u.parent[rootB] = rootA
		return
	}
	u.parent[rootB] = rootA
	u.rank[rootA]++
}
