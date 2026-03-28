package vector

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"episodic-core/frontmatter"
	"episodic-core/internal/ai"

	"golang.org/x/time/rate"
)

type BacklogMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func ProcessBackgroundIndexing(filePaths []string, agentWs string, apiKey string, vstore *Store, embedLimiter *rate.Limiter) {
	provider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")
	
	for _, filePath := range filePaths {
		processBacklogFile(filePath, agentWs, provider, embedLimiter, vstore)
	}
}

func processBacklogFile(filePath string, agentWs string, provider *ai.GoogleStudioProvider, limiter *rate.Limiter, vstore *Store) {
	fmt.Fprintf(os.Stderr, "[Background] Starting index of legacy file: %s\n", filePath)

	const maxBacklogBytes = 50 * 1024 * 1024 // 50MB guard against OOM
	if info, statErr := os.Stat(filePath); statErr == nil && info.Size() > maxBacklogBytes {
		fmt.Fprintf(os.Stderr, "[Background] Skipping oversized backlog file %s (%d bytes > 50MB)\n", filePath, info.Size())
		return
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[Background] Failed to read backlog file %s: %v\n", filePath, err)
		return
	}

	var msgs []BacklogMessage
	if err := json.Unmarshal(data, &msgs); err != nil {
		fmt.Fprintf(os.Stderr, "[Background] Failed to parse backlog file %s: %v\n", filePath, err)
		return
	}

	// Chunk messages into groups of ~10 for meaningful context
	chunkSize := 10
	var chunks [][]BacklogMessage

	for i := 0; i < len(msgs); i += chunkSize {
		end := i + chunkSize
		if end > len(msgs) {
			end = len(msgs)
		}
		chunks = append(chunks, msgs[i:end])
	}

	now := time.Now()
	var prevVector []float32 // tracks previous chunk's embedding for Surprise computation

	for i, chunk := range chunks {
		var sb strings.Builder
		for _, m := range chunk {
			sb.WriteString(m.Role + ": " + m.Content + "\n")
		}
		summary := sb.String()

		preview := slugify(summary)
		if len(preview) > 30 {
			preview = preview[:30]
		}
		hashSum := md5.Sum([]byte(summary))
		hashStr := hex.EncodeToString(hashSum[:])[:8]
		slug := fmt.Sprintf("archive-%s-%05d-%s", hashStr, i, preview)

		// Idempotency check: Skip if already processed in Pebble DB
		if rec, err := vstore.Get(slug); err == nil {
			fmt.Fprintf(os.Stderr, "[Background] Chunk %d (%s) already processed, skipping\n", i, slug)
			prevVector = rec.Vector
			continue
		}

		// Await rate limit before making API call
		bgCtx, bgCancel := context.WithTimeout(context.Background(), 30*time.Second)
		waitErr := limiter.Wait(bgCtx)
		bgCancel()
		if waitErr != nil {
			fmt.Fprintf(os.Stderr, "[Background] Limiter Wait error: %v\n", waitErr)
			continue
		}

		emb, err := provider.EmbedContent(context.Background(), summary)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[Background] Failed to embed chunk %d: %v\n", i, err)
			prevVector = nil // Break surprise context chain on embed failure to prevent artificial spike later
			continue
		}

		// Compute Surprise as cosine distance from the previous chunk's vector.
		// The first chunk has no prior context, so its Surprise remains 0.0 (neutral).
		var surprise float64
		if prevVector != nil {
			surprise = CosineDistance(prevVector, emb)
		}
		prevVector = emb

		dirPath := filepath.Join(agentWs, 
			fmt.Sprintf("%04d", now.Year()), 
			fmt.Sprintf("%02d", now.Month()), 
			fmt.Sprintf("%02d", now.Day()))
		
		if mkErr := os.MkdirAll(dirPath, 0755); mkErr != nil {
			fmt.Fprintf(os.Stderr, "[Background] Failed to create directory %s: %v\n", dirPath, mkErr)
			continue
		}
		outFilePath := filepath.Join(dirPath, slug+".md")

		fm := frontmatter.EpisodeMetadata{
			ID:       slug,
			Title:    slug,
			Created:  now,
			Tags:     []string{"genesis-archive"},
			SavedBy:  "auto",
			Tokens:   frontmatter.EstimateTokens(summary),
			Surprise: surprise,
		}
		doc := &frontmatter.MarkdownDocument{
			Metadata: fm,
			Body:     summary,
		}
		if err := frontmatter.Serialize(outFilePath, doc); err != nil {
			fmt.Fprintf(os.Stderr, "[Background] Failed to serialize chunk %s: %v\n", slug, err)
			continue
		}

		// Surprise is computed as cosine distance from the previous chunk.
		// The first chunk (prevVector was nil) keeps Surprise=0.0 (neutral, no comparison context).
		if err := vstore.Add(context.Background(), EpisodeRecord{
			ID:         slug,
			Title:      slug,
			Tags:       []string{"genesis-archive"},
			Timestamp:  now,
			Vector:     emb,
			SourcePath: outFilePath,
			Tokens:     frontmatter.EstimateTokens(summary),
			Surprise:   surprise,
		}); err != nil {
			fmt.Fprintf(os.Stderr, "[Background] Failed to add %s to vector store: %v\n", slug, err)
			continue
		}

		bgProgress := fmt.Sprintf("%d/%d chunks processed", i+1, len(chunks))
		vstore.SetMeta("bg_progress", []byte(bgProgress))
		
		if (i+1)%10 == 0 || i == len(chunks)-1 {
			fmt.Fprintf(os.Stderr, "[Background] Progress: %s\n", bgProgress)
		}
	}
	
	fmt.Fprintf(os.Stderr, "[Background] Completed indexing for legacy file %s\n", filePath)
}
