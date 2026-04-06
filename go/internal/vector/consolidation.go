package vector

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"episodic-core/frontmatter"
	"episodic-core/internal/ai"

	"golang.org/x/time/rate"
)

// RunConsolidation represents the Sleep Consolidation process described in Phase 4.2.
// It finds all unarchived D0 episodes, clusters them, generates D1 summaries using Gemma,
// archives the D0 nodes, and adds semantic edges.
func RunConsolidation(ctx context.Context, agentWs string, apiKey string, vstore *Store, gemmaLimiter *rate.Limiter, embedLimiter *rate.Limiter) error {
	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Starting Consolidation Job...\n")

	d0Nodes, err := collectActiveD0Nodes(vstore)
	if err != nil {
		return err
	}

	if len(d0Nodes) == 0 {
		fmt.Fprintf(os.Stderr, "[SleepConsolidation] No unarchived D0 nodes found. Exiting.\n")
		return nil
	}

	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Found %d unarchived D0 nodes to process.\n", len(d0Nodes))

	llmRaw := ai.NewGoogleStudioProvider(apiKey, "gemma-3-27b-it")
	embedRaw := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")

	// Wrap providers with retry decorators that coordinate with rate limiters.
	// Retry handles transient 429/5xx; limiters prevent exceeding RPM quota.
	llm, embed := ai.NewRetryPair(llmRaw, embedRaw, gemmaLimiter, embedLimiter)

	now := time.Now()
	cfg := defaultD1ClusterConfig()
	clusters, err := buildD1Clusters(d0Nodes, now, cfg)
	if err != nil {
		return fmt.Errorf("failed to build consolidation clusters: %w", err)
	}
	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Built %d consolidation cluster(s).\n", len(clusters))

	existingKeys, err := loadExistingConsolidationKeys(vstore)
	if err != nil {
		return fmt.Errorf("failed to load existing consolidation keys: %w", err)
	}

	for _, cluster := range clusters {
		if err := processCluster(ctx, cluster, agentWs, vstore, llm, embed, cfg, existingKeys); err != nil {
			fmt.Fprintf(os.Stderr, "[SleepConsolidation] Error processing cluster: %v\n", err)
		}
	}

	// Run RefineSemanticEdges after D1 creation
	if err := RefineSemanticEdges(agentWs, vstore); err != nil {
		fmt.Fprintf(os.Stderr, "[SleepConsolidation] RefineSemanticEdges error: %v\n", err)
	}

	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Consolidation Job Completed.\n")
	return nil
}

func processCluster(
	ctx context.Context,
	cluster d1ConsolidationCluster,
	agentWs string,
	vstore *Store,
	llm ai.LLMProvider,
	embed ai.EmbeddingProvider,
	cfg d1ClusterConfig,
	existingKeys map[string]string,
) error {
	if existingID := strings.TrimSpace(existingKeys[cluster.Fingerprint]); existingID != "" {
		fmt.Fprintf(os.Stderr, "[SleepConsolidation] Reusing existing D1 %s for fingerprint %s\n", existingID, cluster.Fingerprint)
		_, selectedRecords, _, err := prepareClusterInputs(cluster, cfg, vstore)
		if err != nil {
			return err
		}
		childIDs := make([]string, 0, len(selectedRecords))
		for _, rec := range selectedRecords {
			childIDs = append(childIDs, rec.ID)
		}
		_ = vstore.PromoteReplayStateToParent(childIDs, existingID, time.Now())
		return linkClusterChildren(selectedRecords, existingID, vstore)
	}

	clusterDocs, selectedRecords, d1Topics, err := prepareClusterInputs(cluster, cfg, vstore)
	if err != nil {
		return err
	}
	if len(clusterDocs) == 0 || len(selectedRecords) == 0 {
		return fmt.Errorf("cluster has no readable non-empty docs")
	}
	childrenIDs := make([]string, 0, len(selectedRecords))
	for _, rec := range selectedRecords {
		childrenIDs = append(childrenIDs, rec.ID)
	}

	clusterText := strings.Join(clusterDocs, "\n---\n")

	prompt := buildConsolidationPrompt(clusterText, len(selectedRecords) == 1)

	// Rate limiting and retry are handled by the RetryLLM/RetryEmbedder decorators.
	// No manual limiter.Wait() needed here.

	d1Body, err := llm.GenerateText(ctx, prompt)
	if err != nil {
		return fmt.Errorf("LLM generation failed: %w", err)
	}

	if strings.TrimSpace(d1Body) == "" {
		return fmt.Errorf("generated empty D1 body")
	}

	// Generate topics from D1 body using LLM (same language as content).
	// If LLM fails, fall back to aggregated topics from child D0s (d1Topics from L97).
	topicsPrompt := fmt.Sprintf(`Extract 3-5 topic keywords from this memory summary.
Use the same language as the content.
Return ONLY a comma-separated list of topics, nothing else.

%s`, d1Body[:min(len(d1Body), 500)])
	topicsStr, topicsErr := llm.GenerateText(ctx, topicsPrompt)
	if topicsErr == nil && strings.TrimSpace(topicsStr) != "" {
		var llmTopics []string
		for _, t := range strings.Split(topicsStr, ",") {
			t = strings.TrimSpace(t)
			if t != "" {
				llmTopics = append(llmTopics, t)
			}
		}
		if validated, _ := ValidateTopics(llmTopics); len(validated) > 0 {
			d1Topics = validated
		}
	}
	// Final fallback: ensure at least one topic exists
	if len(d1Topics) == 0 {
		d1Topics = []string{"memory"}
	}

	// Generate a short, human-readable title (max ~8 words) from the D1 body.
	// The title should be in the same language as the D1 body content.
	titlePrompt := fmt.Sprintf(`Generate a very short title (max 8 words) for this memory summary.
Use the same language as the content below.
Return ONLY the title text, nothing else.

%s`, d1Body[:min(len(d1Body), 500)])
	titleStr, titleErr := llm.GenerateText(ctx, titlePrompt)
	if titleErr != nil || strings.TrimSpace(titleStr) == "" {
		// Fallback: use first ~60 chars of the body as title
		truncated := strings.TrimSpace(d1Body)
		if len(truncated) > 60 {
			truncated = truncated[:60] + "..."
		}
		titleStr = truncated
	}
	d1Title := strings.TrimSpace(titleStr)
	// Sanitize title: remove newlines, limit length
	d1Title = strings.ReplaceAll(d1Title, "\n", " ")
	d1Title = strings.ReplaceAll(d1Title, "\r", " ")
	if len([]rune(d1Title)) > 120 {
		runes := []rune(d1Title)
		d1Title = string(runes[:120]) + "..."
	}

	slugPrompt := fmt.Sprintf("Generate a very short, url-safe identifier (using hyphens, max 4 words) representing this topic:\n%s", d1Body[:min(len(d1Body), 300)])
	slugStr, slugErr := llm.GenerateText(ctx, slugPrompt)
	if slugErr != nil {
		slugStr = "d1-summary-generated"
	}
	d1Slug := slugify(slugStr) + fmt.Sprintf("-%d", time.Now().UnixNano()/1000000)

	emb, err := embed.EmbedContent(ctx, d1Body)
	if err != nil {
		return fmt.Errorf("Embedding failed: %w", err)
	}

	now := time.Now()
	dirPath := filepath.Join(agentWs,
		fmt.Sprintf("%04d", now.Year()),
		fmt.Sprintf("%02d", now.Month()),
		fmt.Sprintf("%02d", now.Day()))

	os.MkdirAll(dirPath, 0755)
	outFilePath := filepath.Join(dirPath, d1Slug+".md")

	edgeList := []frontmatter.Edge{}
	for _, cid := range childrenIDs {
		edgeList = append(edgeList, frontmatter.Edge{
			ID:   cid,
			Type: "child",
		})
	}

	fm := frontmatter.EpisodeMetadata{
		ID:               d1Slug,
		Title:            d1Title,
		Tags:             []string{"d1-summary"},
		Topics:           d1Topics,
		SavedBy:          "auto",
		ConsolidationKey: cluster.Fingerprint,
		RelatedTo:        edgeList, // Link to D0 children
	}

	doc := &frontmatter.MarkdownDocument{
		Metadata: fm,
		Body:     d1Body,
	}

	if err := frontmatter.Serialize(outFilePath, doc); err != nil {
		return fmt.Errorf("failed to serialize D1: %w", err)
	}

	if err := vstore.Add(ctx, EpisodeRecord{
		ID:         d1Slug,
		Title:      fm.Title,
		Tags:       fm.Tags,
		Topics:     fm.Topics,
		Timestamp:  now,
		Vector:     emb,
		SourcePath: outFilePath,
		Edges:      edgeList,
	}); err != nil {
		return fmt.Errorf("failed to add D1 to vector store: %w", err)
	}
	_ = vstore.PromoteReplayStateToParent(childrenIDs, d1Slug, now)
	existingKeys[cluster.Fingerprint] = d1Slug

	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Generated D1: %s\n", d1Slug)
	return linkClusterChildren(selectedRecords, d1Slug, vstore)
}

func buildConsolidationPrompt(clusterText string, singleton bool) string {
	if singleton {
		return fmt.Sprintf(`Analyze the following episodic memory log (D0) as a single high-salience event.
Keep the D1 summary narrow, concrete, and local to this one episode.
Do not over-generalize beyond the event itself.
IMPORTANT: Write the summary in the SAME LANGUAGE as the original content. If the content is in Japanese, write in Japanese. If in English, write in English. Do not translate or mix languages.
Return ONLY the summary/rules markdown text without additional conversational filler.

---
%s
---
`, clusterText)
	}

	return fmt.Sprintf(`Analyze the following episodic memory logs (D0) representing detailed chronological events.
Extract the overarching rules, facts, high-level summaries, and abstract concepts to form a long-term semantic memory (D1).
Do not simply repeat the conversation. Synthesize it.
IMPORTANT: Write the summary in the SAME LANGUAGE as the original content. If the content is in Japanese, write in Japanese. If in English, write in English. Do not translate or mix languages.
Return ONLY the summary/rules markdown text without additional conversational filler.

---
%s
---
`, clusterText)
}

func prepareClusterInputs(cluster d1ConsolidationCluster, cfg d1ClusterConfig, vstore *Store) ([]string, []EpisodeRecord, []string, error) {
	clusterRecords := make([]EpisodeRecord, 0, len(cluster.Nodes))
	clusterDocs := make([]string, 0, len(cluster.Nodes))
	remainingTokens := cfg.MaxClusterTokens

	for _, node := range cluster.Nodes {
		rec := node.Record
		doc, err := frontmatter.Parse(rec.SourcePath)
		if err != nil {
			quarantineConsolidationRecord(vstore, rec, fmt.Sprintf("parse failed: %v", err))
			continue
		}
		body := strings.TrimSpace(doc.Body)
		if body == "" {
			fmt.Fprintf(os.Stderr, "[SleepConsolidation] Skipping empty D0 body for %s\n", rec.ID)
			quarantineConsolidationRecord(vstore, rec, "empty body")
			continue
		}
		cappedBody := trimBodyToTokenLimit(body, min(cfg.PerNodeTokenCap, remainingTokens))
		bodyTokens := frontmatter.EstimateTokens(cappedBody)
		if bodyTokens <= 0 {
			quarantineConsolidationRecord(vstore, rec, "token cap trimmed body to empty")
			continue
		}
		clusterDocs = append(clusterDocs, fmt.Sprintf("ID: %s\n%s", rec.ID, cappedBody))
		clusterRecords = append(clusterRecords, rec)
		remainingTokens -= bodyTokens
		if remainingTokens <= 0 {
			break
		}
	}

	if len(clusterDocs) == 0 {
		return nil, nil, nil, fmt.Errorf("cluster has no readable non-empty docs")
	}
	return clusterDocs, clusterRecords, aggregateClusterTopics(clusterRecords), nil
}

func trimBodyToTokenLimit(body string, tokenLimit int) string {
	body = strings.TrimSpace(body)
	if body == "" || tokenLimit <= 0 {
		return ""
	}
	if frontmatter.EstimateTokens(body) <= tokenLimit {
		return body
	}
	runes := []rune(body)
	if len(runes) == 0 {
		return ""
	}
	maxRunes := max(1, tokenLimit*3)
	if maxRunes >= len(runes) {
		return body
	}
	return strings.TrimSpace(string(runes[:maxRunes])) + "\n\n[truncated for consolidation budget]"
}

func linkClusterChildren(children []EpisodeRecord, parentID string, vstore *Store) error {
	for _, child := range children {
		cid := child.ID
		sourcePath := ""
		if rec, err := vstore.Get(cid); err == nil {
			sourcePath = rec.SourcePath
		}

		newEdge := frontmatter.Edge{
			ID:   parentID,
			Type: "parent",
		}

		alreadyArchived := false
		if sourcePath != "" {
			d0Doc, d0Err := frontmatter.Parse(sourcePath)
			if d0Err == nil {
				alreadyArchived = slices.Contains(d0Doc.Metadata.Tags, "archived")
				if !alreadyArchived {
					d0Doc.Metadata.Tags = append(d0Doc.Metadata.Tags, "archived")
				}
				if len(d0Doc.Metadata.Topics) == 0 {
					d0Doc.Metadata.Topics = LegacyTopicsFromTags(d0Doc.Metadata.Tags)
				}
				if !hasRelatedEdge(d0Doc.Metadata.RelatedTo, newEdge) {
					d0Doc.Metadata.RelatedTo = append(d0Doc.Metadata.RelatedTo, newEdge)
				}
				if err := frontmatter.Serialize(sourcePath, d0Doc); err != nil {
					fmt.Fprintf(os.Stderr, "[SleepConsolidation] Error serializing D0 node %s: %v\n", sourcePath, err)
				}
			}
		}

		if err := vstore.UpdateRecord(cid, func(rec *EpisodeRecord) error {
			if !alreadyArchived && !hasTag(rec.Tags, "archived") {
				rec.Tags = append(rec.Tags, "archived")
			}
			if !hasRelatedEdge(rec.Edges, newEdge) {
				rec.Edges = append(rec.Edges, newEdge)
			}
			// Phase 4.1: Flag as merged so it's hidden from active D0 queries
			rec.PruneState = "merged"
			rec.CanonicalParent = parentID
			return nil
		}); err != nil {
			fmt.Fprintf(os.Stderr, "[SleepConsolidation] Error updating D0 node %s: %v\n", cid, err)
		}
	}
	return nil
}

func hasRelatedEdge(edges []frontmatter.Edge, target frontmatter.Edge) bool {
	for _, edge := range edges {
		if edge.ID == target.ID && edge.Type == target.Type {
			return true
		}
	}
	return false
}

type clusterTopicStat struct {
	Topic     string
	Count     int
	CoveredBy map[string]struct{}
}

func aggregateClusterTopics(cluster []EpisodeRecord) []string {
	if len(cluster) == 0 {
		return nil
	}

	stats := make(map[string]*clusterTopicStat)
	totalChildren := len(cluster)

	for _, d0 := range cluster {
		topics, _ := ValidateTopics(d0.Topics)
		if len(topics) == 0 {
			topics = LegacyTopicsFromTags(d0.Tags)
		}
		if len(topics) == 0 {
			continue
		}
		seen := make(map[string]struct{})
		for _, topic := range topics {
			key := topicKey(topic)
			if key == "" {
				continue
			}
			if _, ok := seen[key]; ok {
				continue
			}
			seen[key] = struct{}{}
			stat := stats[key]
			if stat == nil {
				stat = &clusterTopicStat{
					Topic:     topic,
					CoveredBy: make(map[string]struct{}),
				}
				stats[key] = stat
			}
			stat.Count++
			stat.CoveredBy[d0.ID] = struct{}{}
		}
	}

	if len(stats) == 0 {
		return nil
	}

	type scoredTopic struct {
		topic    string
		count    int
		coverage float64
		runes    int
	}
	scored := make([]scoredTopic, 0, len(stats))
	for _, stat := range stats {
		coverage := 0.0
		if totalChildren > 0 {
			coverage = float64(len(stat.CoveredBy)) / float64(totalChildren)
		}
		scored = append(scored, scoredTopic{
			topic:    stat.Topic,
			count:    stat.Count,
			coverage: coverage,
			runes:    len([]rune(stat.Topic)),
		})
	}

	sort.Slice(scored, func(i, j int) bool {
		if scored[i].count != scored[j].count {
			return scored[i].count > scored[j].count
		}
		if scored[i].coverage != scored[j].coverage {
			return scored[i].coverage > scored[j].coverage
		}
		if scored[i].runes != scored[j].runes {
			return scored[i].runes < scored[j].runes
		}
		return scored[i].topic < scored[j].topic
	})

	limit := min(len(scored), 10)
	topics := make([]string, 0, limit)
	for i := 0; i < limit; i++ {
		topics = append(topics, scored[i].topic)
	}
	return topics
}

// RefineSemanticEdges finds pairs of D1 nodes that are close in vector space
// and links them with a "semantic" edge.
func RefineSemanticEdges(agentWs string, vstore *Store) error {
	fmt.Fprintf(os.Stderr, "[RefineSemantic] Checking semantic associations...\n")

	d1Nodes, err := vstore.ListByTag("d1-summary")
	if err != nil {
		return err
	}

	if len(d1Nodes) < 2 {
		return nil
	}

	// Very simple NxN or search graph
	for _, n1 := range d1Nodes {
		// P0-C FIX: use SearchGraph() which acquires RLock before touching the HNSW graph.
		// Direct vstore.graph.Search() without a lock would race with concurrent Add() calls.
		candidates := vstore.SearchGraph(n1.Vector, 10, 10)

		for _, cand := range candidates {
			if cand.ID == 0 {
				continue
			}

			dist := cand.Dist
			// Guard against NaN: NaN < 0.85 == false (IEEE 754), so NaN would slip through the filter.
			if math.IsNaN(float64(dist)) {
				continue
			}
			// Convert L2 squared distance to similarity score
			sim := 1.0 / (1.0 + dist)
			if sim < 0.85 { // equivalent to cosine dist ~0.15
				continue
			}

			idStr, _ := vstore.GetIDByUint32(cand.ID)
			if idStr == n1.ID || idStr == "" {
				continue // self or not found
			}

			// Add semantic edge conditionally
			hasEdge := false
			for _, e := range n1.Edges {
				if e.ID == idStr {
					hasEdge = true
					break
				}
			}
			if !hasEdge {
				// P1-F FIX: Read the file BEFORE acquiring the write lock in UpdateRecord.
				// Doing frontmatter.Parse inside the callback causes blocking disk I/O
				// while the global mutex is held, freezing all Recall/Ingest operations.
				sourcePath := ""
				if rec, err := vstore.Get(n1.ID); err == nil {
					sourcePath = rec.SourcePath
				}

				newEdge := frontmatter.Edge{ID: idStr, Type: "semantic", Weight: float64(sim)}

				// Mutate only in-memory record inside the lock.
				if err := vstore.UpdateRecord(n1.ID, func(rec *EpisodeRecord) error {
					rec.Edges = append(rec.Edges, newEdge)
					return nil
				}); err != nil {
					fmt.Fprintf(os.Stderr, "[RefineSemantic] UpdateRecord failed for %s: %v\n", n1.ID, err)
					continue
				}

				// Do file I/O AFTER releasing the write lock.
				if sourcePath != "" {
					if doc, docErr := frontmatter.Parse(sourcePath); docErr == nil {
						// Secondary dedup: verify on-disk file doesn't already have this edge.
						// Guards against DB/file divergence where the in-memory check above is stale.
						fileHasEdge := false
						for _, e := range doc.Metadata.RelatedTo {
							if e.ID == idStr {
								fileHasEdge = true
								break
							}
						}
						if !fileHasEdge {
							doc.Metadata.RelatedTo = append(doc.Metadata.RelatedTo, newEdge)
							if err := frontmatter.Serialize(sourcePath, doc); err != nil {
								fmt.Fprintf(os.Stderr, "[RefineSemantic] Error serializing node %s: %v\n", sourcePath, err)
							}
						}
					} else {
						// In-memory edge was added but disk write skipped.
						// DB and .md file are temporarily inconsistent until next HealingWorker pass.
						fmt.Fprintf(os.Stderr, "[RefineSemantic] Parse failed for %s: %v (in-memory edge added, disk skipped)\n", sourcePath, docErr)
					}
				}

				fmt.Fprintf(os.Stderr, "[RefineSemantic] Linked %s <-> %s\n", n1.ID, idStr)
			}
		}
	}

	return nil
}
