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

	"github.com/cockroachdb/pebble"
	"github.com/vmihailenco/msgpack/v5"
	"golang.org/x/time/rate"
)

// RunConsolidation represents the Sleep Consolidation process described in Phase 4.2.
// It finds all unarchived D0 episodes, clusters them, generates D1 summaries using Gemma,
// archives the D0 nodes, and adds semantic edges.
func RunConsolidation(ctx context.Context, agentWs string, apiKey string, vstore *Store, gemmaLimiter *rate.Limiter, embedLimiter *rate.Limiter) error {
	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Starting Consolidation Job...\n")

	// 1. Fetch all raw episodes (D0), assuming "archived" tag is missing.
	// In our system, typical episodes have "auto-record" or "gap-compacted" or "genesis-archive".

	var d0Nodes []EpisodeRecord
	// Since we only added "ListByTag", but we need "All without 'archived' tag"
	// Let's do a full scan of prefixEp and filter.
	vstore.mutex.RLock()
	iter, err := vstore.db.NewIter(&pebble.IterOptions{
		LowerBound: prefixEp,
		UpperBound: []byte("ep;"),
	})
	if err != nil {
		vstore.mutex.RUnlock()
		return fmt.Errorf("failed to iter unarchived nodes: %w", err)
	}
	defer iter.Close()
	
	for iter.First(); iter.Valid(); iter.Next() {
		var rec EpisodeRecord
		if err := msgpack.Unmarshal(iter.Value(), &rec); err == nil {
			isArchived := false
			isD1 := false
			for _, t := range rec.Tags {
				if t == "archived" {
					isArchived = true
				}
				if t == "d1-summary" {
					isD1 = true
				}
			}
			if !isArchived && !isD1 {
				d0Nodes = append(d0Nodes, rec)
			}
		}
	}
	iter.Close()
	vstore.mutex.RUnlock()

	if len(d0Nodes) == 0 {
		fmt.Fprintf(os.Stderr, "[SleepConsolidation] No unarchived D0 nodes found. Exiting.\n")
		return nil
	}

	// Sort chronologically
	sort.Slice(d0Nodes, func(i, j int) bool {
		return d0Nodes[i].Timestamp.Before(d0Nodes[j].Timestamp)
	})

	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Found %d unarchived D0 nodes to process.\n", len(d0Nodes))

	llmRaw := ai.NewGoogleStudioProvider(apiKey, "gemma-3-27b-it")
	embedRaw := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")

	// Wrap providers with retry decorators that coordinate with rate limiters.
	// Retry handles transient 429/5xx; limiters prevent exceeding RPM quota.
	llm, embed := ai.NewRetryPair(llmRaw, embedRaw, gemmaLimiter, embedLimiter)

	// Cluster into chunks of up to 10 (basic temporal clustering)
	// TODO: Future enhancement: employ HNSW Cosine distance clustering.
	chunkSize := 10
	for i := 0; i < len(d0Nodes); i += chunkSize {
		end := min(i+chunkSize, len(d0Nodes))
		cluster := d0Nodes[i:end]

		if err := processCluster(ctx, cluster, agentWs, vstore, llm, embed); err != nil {
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
	cluster []EpisodeRecord,
	agentWs string,
	vstore *Store,
	llm ai.LLMProvider,
	embed ai.EmbeddingProvider,
) error {

	var clusterDocs []string
	var childrenIDs []string

	for _, d0 := range cluster {
		doc, err := frontmatter.Parse(d0.SourcePath)
		if err == nil {
			clusterDocs = append(clusterDocs, fmt.Sprintf("ID: %s\n%s", d0.ID, doc.Body))
			childrenIDs = append(childrenIDs, d0.ID)
		}
	}

	if len(clusterDocs) == 0 {
		return fmt.Errorf("cluster has no readable docs")
	}

	clusterText := strings.Join(clusterDocs, "\n---\n")

	prompt := fmt.Sprintf(`Analyze the following episodic memory logs (D0) representing detailed chronological events.
Extract the overarching rules, facts, high-level summaries, and abstract concepts to form a long-term semantic memory (D1).
Do not simply repeat the conversation. Synthesize it.
Return ONLY the summary/rules markdown text without additional conversational filler.

---
%s
---
`, clusterText)

	// Rate limiting and retry are handled by the RetryLLM/RetryEmbedder decorators.
	// No manual limiter.Wait() needed here.

	d1Body, err := llm.GenerateText(ctx, prompt)
	if err != nil {
		return fmt.Errorf("LLM generation failed: %w", err)
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
			ID:     cid,
			Type:   "child",
		})
	}

	fm := frontmatter.EpisodeMetadata{
		ID:        d1Slug,
		Title:     "Semantic Consolidation: " + strings.ReplaceAll(d1Slug, "-", " "),
		Tags:      []string{"d1-summary"},
		SavedBy:   "auto",
		RelatedTo: edgeList,       // Link to D0 children
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
		Timestamp:  now,
		Vector:     emb,
		SourcePath: outFilePath,
		Edges:      edgeList,
	}); err != nil {
		return fmt.Errorf("failed to add D1 to vector store: %w", err)
	}

	fmt.Fprintf(os.Stderr, "[SleepConsolidation] Generated D1: %s\n", d1Slug)

	// P1-F FIX: Move file I/O out of the UpdateRecord callback.
	// UpdateRecord holds a Write lock on the Vector Store. Doing Parse/Serialize inside it
	// blocks all other operations (Recall, Ingest) for the duration of the disk I/O.
	for _, cid := range childrenIDs {
		// 1. Get current metadata to find the file path
		sourcePath := ""
		if rec, err := vstore.Get(cid); err == nil {
			sourcePath = rec.SourcePath
		}

		newEdge := frontmatter.Edge{
			ID:   d1Slug,
			Type: "parent",
		}

		// 2. Perform file I/O BEFORE taking the lock
		alreadyArchived := false
		if sourcePath != "" {
			d0Doc, d0Err := frontmatter.Parse(sourcePath)
			if d0Err == nil {
				// Check status
				alreadyArchived = slices.Contains(d0Doc.Metadata.Tags, "archived")

				if !alreadyArchived {
					d0Doc.Metadata.Tags = append(d0Doc.Metadata.Tags, "archived")
				}
				d0Doc.Metadata.RelatedTo = append(d0Doc.Metadata.RelatedTo, newEdge)

				// 3. Serialize BEFORE or AFTER the Vector store update.
				// Here we do it before to be safe (if it fails, we might not want to update state).
				if err := frontmatter.Serialize(sourcePath, d0Doc); err != nil {
					fmt.Fprintf(os.Stderr, "[SleepConsolidation] Error serializing D0 node %s: %v\n", sourcePath, err)
				}
			}
		}

		// 4. Finally, update the Vector Store (In-memory/Pebble) with the Write lock
		if err := vstore.UpdateRecord(cid, func(rec *EpisodeRecord) error {
			if !alreadyArchived {
				rec.Tags = append(rec.Tags, "archived")
			}
			rec.Edges = append(rec.Edges, newEdge)
			return nil
		}); err != nil {
			fmt.Fprintf(os.Stderr, "[SleepConsolidation] Error updating D0 node %s: %v\n", cid, err)
		}
	}

	return nil
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

