package vector

import (
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"episodic-core/frontmatter"
	"episodic-core/internal/ai"
	"episodic-core/internal/logger"

	"golang.org/x/time/rate"
)

// stripTelegramMetadata removes Telegram gateway JSON metadata blocks from text.
var telegramMetaPatternsBg = []*regexp.Regexp{
	regexp.MustCompile(`(?i)Conversation info \(untrusted metadata\):[\s\S]*?` + "```json[\\s\\S]*?```"),
	regexp.MustCompile(`(?i)Sender \(untrusted metadata\):[\s\S]*?` + "```json[\\s\\S]*?```"),
	regexp.MustCompile(`(?i)Replied message \(untrusted,? for context\):[\s\S]*?` + "```json[\\s\\S]*?```"),
	regexp.MustCompile(`(?i)\(untrusted metadata\):[\s\S]*?` + "```json[\\s\\S]*?```"),
}

func stripTelegramMetadataBg(text string) string {
	cleaned := text
	for _, p := range telegramMetaPatternsBg {
		cleaned = p.ReplaceAllString(cleaned, "")
	}
	cleaned = regexp.MustCompile(`\n{3,}`).ReplaceAllString(cleaned, "\n\n")
	return strings.TrimSpace(cleaned)
}

// CleanEpisodeFile checks if an episode file contains Telegram metadata blocks
// and rewrites it with cleaned body content. Returns true if the file was modified.
func CleanEpisodeFile(filePath string) bool {
	doc, err := frontmatter.Parse(filePath)
	if err != nil {
		return false
	}

	cleaned := stripTelegramMetadataBg(doc.Body)
	if cleaned == doc.Body {
		return false
	}

	// Rewrite with cleaned body
	doc.Body = cleaned
	if err := frontmatter.Serialize(filePath, doc); err != nil {
		logger.Error(logger.CatBackground, "Failed to rewrite cleaned file %s: %v\n", filePath, err)
		return false
	}

	logger.Error(logger.CatBackground, "Cleaned Telegram metadata from %s (was %d chars, now %d chars)\n",
		filePath, len(doc.Body), len(cleaned))
	return true
}

type BacklogMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func ProcessBackgroundIndexing(filePaths []string, agentWs string, apiKey string, vstore *Store, embedLimiter *rate.Limiter) {
	provider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")

	for _, filePath := range filePaths {
		if strings.HasSuffix(strings.ToLower(filePath), ".md") {
			ProcessMDFileIndex(filePath, agentWs, apiKey, vstore, embedLimiter)
		} else {
			processBacklogFile(filePath, agentWs, provider, embedLimiter, vstore)
		}
	}
}

// ProcessMDFileIndex indexes a single Markdown episode file.
// It implements Smart Dedup: if the MD body has not changed (ContentHash match),
// the expensive Gemini Embed API call is bypassed entirely.
func ProcessMDFileIndex(filePath string, agentWs string, apiKey string, vstore *Store, embedLimiter *rate.Limiter) {
	doc, err := frontmatter.Parse(filePath)
	if err != nil {
		logger.Info(logger.CatBackground, "Failed to parse %s: %v\n", filePath, err)
		return
	}

	// Lazy Migration: Clean Telegram metadata blocks from existing files
	if CleanEpisodeFile(filePath) {
		// Re-parse after cleaning
		doc, err = frontmatter.Parse(filePath)
		if err != nil {
			logger.Info(logger.CatBackground, "Failed to re-parse cleaned file %s: %v\n", filePath, err)
			return
		}
	}

	body := strings.TrimSpace(doc.Body)
	if body == "" {
		logger.Info(logger.CatBackground, "Skipping empty body: %s\n", filePath)
		return
	}

	meta := doc.Metadata

	// Smart Dedup: compute SHA-256 of the body, compare with stored hash.
	newHash := contentHash(body)
	normalizedPath := filepath.ToSlash(filepath.Clean(filePath))

	existingRec, fetchErr := vstore.GetByPath(normalizedPath)
	if fetchErr == nil && existingRec.ContentHash == newHash {
		// [R2 RESOLUTION] Check if metadata has changed
		metaChanged := existingRec.Title != meta.Title || existingRec.Depth != meta.Depth || existingRec.Surprise != meta.Surprise
		if !metaChanged && !meta.Created.IsZero() && !existingRec.Timestamp.Equal(meta.Created) {
			metaChanged = true
		}
		if !metaChanged {
			if len(existingRec.Tags) != len(meta.Tags) {
				metaChanged = true
			} else {
				for i, t := range meta.Tags {
					if existingRec.Tags[i] != t {
						metaChanged = true
						break
					}
				}
			}
		}
		if !metaChanged {
			if len(existingRec.Topics) != len(meta.Topics) {
				metaChanged = true
			} else {
				for i, t := range meta.Topics {
					if existingRec.Topics[i] != t {
						metaChanged = true
						break
					}
				}
			}
		}
		if !metaChanged {
			if len(existingRec.Edges) != len(meta.RelatedTo) {
				metaChanged = true
			} else {
				for i, t := range meta.RelatedTo {
					if existingRec.Edges[i] != t {
						metaChanged = true
						break
					}
				}
			}
		}

		if !metaChanged {
			logger.Info(logger.CatBackground, "Smart Dedup: body and metadata unchanged for %s — skipping embed\n", filePath)
			return
		}

		logger.Info(logger.CatBackground, "Smart Dedup: metadata changed for %s — updating record without re-embed\n", filePath)

		id := existingRec.ID
		created := meta.Created
		if created.IsZero() {
			created = existingRec.Timestamp
		}

		rec := EpisodeRecord{
			ID:          id,
			Title:       meta.Title,
			Tags:        meta.Tags,
			Topics:      meta.Topics,
			Timestamp:   created,
			Vector:      existingRec.Vector, // Reuse existing vector
			SourcePath:  normalizedPath,
			Depth:       meta.Depth,
			Tokens:      meta.Tokens,
			Surprise:    meta.Surprise,
			ContentHash: newHash,
		}
		if len(meta.RelatedTo) > 0 {
			rec.Edges = meta.RelatedTo
		}

		if delErr := vstore.DeleteByPath(normalizedPath); delErr != nil {
			logger.Info(logger.CatBackground, "Failed to remove stale record for %s: %v\n", filePath, delErr)
		}
		if err := vstore.Add(context.Background(), rec); err != nil {
			logger.Info(logger.CatBackground, "Failed to update metadata for %s: %v\n", filePath, err)
		}
		return
	}

	// Body has changed (or no record exists) — re-embed.
	provider := ai.NewGoogleStudioProvider(apiKey, "gemini-embedding-2-preview")

	bgCtx, bgCancel := context.WithTimeout(context.Background(), 1*time.Hour)
	waitErr := embedLimiter.Wait(bgCtx)
	bgCancel()
	if waitErr != nil {
		logger.Info(logger.CatBackground, "Rate limiter timeout for %s: %v\n", filePath, waitErr)
		return
	}

	emb, err := provider.EmbedContent(context.Background(), body)
	if err != nil {
		logger.Info(logger.CatBackground, "Embed failed for %s: %v\n", filePath, err)
		return
	}

	id := strings.TrimSpace(meta.ID)
	if id == "" {
		// Derive ID from path relative to agentWs
		rel, relErr := filepath.Rel(agentWs, filePath)
		if relErr != nil {
			rel = filePath
		}
		id = strings.TrimSuffix(filepath.ToSlash(rel), ".md")
	}

	now := time.Now()
	created := meta.Created
	if created.IsZero() {
		created = now
	}

	rec := EpisodeRecord{
		ID:          id,
		Title:       meta.Title,
		Tags:        meta.Tags,
		Topics:      meta.Topics,
		Timestamp:   created,
		Vector:      emb,
		SourcePath:  normalizedPath,
		Depth:       meta.Depth,
		Tokens:      meta.Tokens,
		Surprise:    meta.Surprise,
		ContentHash: newHash,
	}
	if len(meta.RelatedTo) > 0 {
		rec.Edges = meta.RelatedTo
	}

	// If a record already exists for this path, delete it first (Upsert semantics).
	if fetchErr == nil {
		if delErr := vstore.DeleteByPath(normalizedPath); delErr != nil {
			logger.Info(logger.CatBackground, "Failed to remove stale record for %s: %v\n", filePath, delErr)
		}
	}

	if err := vstore.Add(context.Background(), rec); err != nil {
		logger.Info(logger.CatBackground, "Failed to add record for %s: %v\n", filePath, err)
		return
	}

	logger.Info(logger.CatBackground, "Indexed %s (hash=%s)\n", filePath, newHash)
}

// contentHash returns the first 16 hex characters of the SHA-256 of s.
func contentHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:16]
}

func processBacklogFile(filePath string, agentWs string, provider *ai.GoogleStudioProvider, limiter *rate.Limiter, vstore *Store) {
	logger.Info(logger.CatBackground, "Starting index of legacy file: %s\n", filePath)

	const maxBacklogBytes = 50 * 1024 * 1024 // 50MB guard against OOM
	if info, statErr := os.Stat(filePath); statErr == nil && info.Size() > maxBacklogBytes {
		logger.Info(logger.CatBackground, "Skipping oversized backlog file %s (%d bytes > 50MB)\n", filePath, info.Size())
		return
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		logger.Info(logger.CatBackground, "Failed to read backlog file %s: %v\n", filePath, err)
		return
	}

	var msgs []BacklogMessage
	if err := json.Unmarshal(data, &msgs); err != nil {
		logger.Info(logger.CatBackground, "Failed to parse backlog file %s: %v\n", filePath, err)
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
			sb.WriteString(m.Role + ": " + stripTelegramMetadataBg(m.Content) + "\n")
		}
		summary := sb.String()
		if strings.TrimSpace(summary) == "" {
			logger.Info(logger.CatBackground, "Skipping empty chunk %d in %s\n", i, filePath)
			prevVector = nil
			continue
		}

		preview := slugify(summary)
		if len(preview) > 30 {
			preview = preview[:30]
		}
		hashSum := md5.Sum([]byte(summary))
		hashStr := hex.EncodeToString(hashSum[:])[:8]
		slug := fmt.Sprintf("archive-%s-%05d-%s", hashStr, i, preview)

		// Idempotency check: Skip if already processed in Pebble DB
		if rec, err := vstore.Get(slug); err == nil {
			logger.Info(logger.CatBackground, "Chunk %d (%s) already processed, skipping\n", i, slug)
			prevVector = rec.Vector
			continue
		}

		// Await rate limit before making API call
		bgCtx, bgCancel := context.WithTimeout(context.Background(), 30*time.Second)
		waitErr := limiter.Wait(bgCtx)
		bgCancel()
		if waitErr != nil {
			logger.Info(logger.CatBackground, "Limiter Wait error: %v\n", waitErr)
			continue
		}

		emb, err := provider.EmbedContent(context.Background(), summary)
		if err != nil {
			logger.Info(logger.CatBackground, "Failed to embed chunk %d: %v\n", i, err)
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
			logger.Info(logger.CatBackground, "Failed to create directory %s: %v\n", dirPath, mkErr)
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
			logger.Info(logger.CatBackground, "Failed to serialize chunk %s: %v\n", slug, err)
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
			logger.Info(logger.CatBackground, "Failed to add %s to vector store: %v\n", slug, err)
			continue
		}

		bgProgress := fmt.Sprintf("%d/%d chunks processed", i+1, len(chunks))
		vstore.SetMeta("bg_progress", []byte(bgProgress))

		if (i+1)%10 == 0 || i == len(chunks)-1 {
			logger.Info(logger.CatBackground, "Progress: %s\n", bgProgress)
		}
	}

	logger.Info(logger.CatBackground, "Completed indexing for legacy file %s\n", filePath)

	// Clean up the temp backlog file after processing (fixes race condition with TS-side deletion)
	if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
		logger.Info(logger.CatBackground, "Failed to cleanup temp file %s: %v\n", filePath, err)
	}
}
