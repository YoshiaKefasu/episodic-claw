package vector

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"episodic-core/internal/logger"

	"github.com/blevesearch/bleve/v2"
	"github.com/blevesearch/bleve/v2/analysis/lang/cjk"
	"github.com/cockroachdb/pebble"
	"github.com/vmihailenco/msgpack/v5"
)

// openLexicalIndex initializes the Bleve Inverted Index (Pure Go Lexical Engine)
func openLexicalIndex(dbDir string) (bleve.Index, error) {
	lexPath := filepath.Join(dbDir, "lexical")
	idx, err := bleve.Open(lexPath)
	if err == nil {
		return idx, nil
	}
	if err != bleve.ErrorIndexPathDoesNotExist {
		return nil, fmt.Errorf("failed to open existing bleve index: %w", err)
	}

	// Create new index
	mapping := bleve.NewIndexMapping()
	docMapping := bleve.NewDocumentMapping()

	// Create a text field mapping
	textFieldMapping := bleve.NewTextFieldMapping()
	// CJK analyzer unigram-tokenizes CJK scripts (Han, Hiragana, Katakana, Hangul)
	// and uses whitespace tokenization for Latin scripts.
	textFieldMapping.Analyzer = cjk.AnalyzerName

	docMapping.AddFieldMappingsAt("Content", textFieldMapping)
	mapping.DefaultMapping = docMapping

	idx, err = bleve.New(lexPath, mapping)
	if err != nil {
		return nil, fmt.Errorf("failed to create bleve index: %w", err)
	}

	return idx, nil
}

// lexicalWorker processes background synchronization of Lexical Engine pulling from Pebble WAL Queue
func (s *Store) lexicalWorker(ctx context.Context) {
	pollInterval := 500 * time.Millisecond
	maxPollInterval := 5 * time.Second
	timer := time.NewTimer(pollInterval)
	defer timer.Stop()

	backoff := 1 * time.Second
	maxBackoff := 60 * time.Second

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			// Poll Pebble for sys_lexq:*
			iter, err := s.db.NewIter(&pebble.IterOptions{
				LowerBound: prefixLexQ,
				UpperBound: []byte("sys_lexq;"), // ; is after :
			})
			if err != nil {
				logger.Info(logger.CatLexical, "Failed to create iter: %v", err)
				timer.Reset(pollInterval)
				continue
			}

			// Read up to 1000 tasks
			batchKeys := make([][]byte, 0, 1000)

			type lexTask struct {
				key    []byte
				action string
				id     string
			}
			var tasks []lexTask

			for iter.First(); iter.Valid() && len(tasks) < 1000; iter.Next() {
				keyCopy := append([]byte(nil), iter.Key()...)
				valCopy := append([]byte(nil), iter.Value()...)

				// parse key sys_lexq:{ts}:{id}
				parts := strings.SplitN(string(keyCopy), ":", 3)
				if len(parts) == 3 {
					tasks = append(tasks, lexTask{
						key:    keyCopy,
						action: string(valCopy),
						id:     parts[2],
					})
				} else {
					// invalid key format, just queue for deletion
					batchKeys = append(batchKeys, keyCopy)
				}
			}
			iter.Close()

			if len(tasks) == 0 {
				if len(batchKeys) > 0 {
					dbBatch := s.db.NewBatch()
					for _, k := range batchKeys {
						dbBatch.Delete(k, nil)
					}
					_ = dbBatch.Commit(pebble.Sync)
					dbBatch.Close()
				}
				pollInterval *= 2
				if pollInterval > maxPollInterval {
					pollInterval = maxPollInterval
				}
				backoff = 1 * time.Second
				timer.Reset(pollInterval)
				continue
			}

			pollInterval = 500 * time.Millisecond

			bleveBatch := s.lexical.NewBatch()

			for _, task := range tasks {
				batchKeys = append(batchKeys, task.key)
				action := task.action

				// [v0.4.20] Skip tasks with empty ID — Bleve rejects document ID ""
				if task.id == "" {
					logger.Warn(logger.CatLexical, "Skipping lexical task with empty document ID (action=%s, key=%s)", action, string(task.key))
					continue
				}

				if action == "ADD" || action == "UPDATE" {
					epKey := append(append([]byte(nil), prefixEp...), []byte(task.id)...)
					val, closer, err := s.db.Get(epKey)
					if err == pebble.ErrNotFound {
						bleveBatch.Delete(task.id)
						continue
					} else if err != nil {
						logger.Info(logger.CatLexical, "Error reading record %s: %v", task.id, err)
						continue
					}

					var rec EpisodeRecord
					err = msgpack.Unmarshal(val, &rec)
					closer.Close()
					if err != nil {
						continue
					}

					// Pollution control
					if rec.PruneState == "merged" || rec.PruneState == "tombstone" {
						bleveBatch.Delete(task.id)
						continue
					}

					content := rec.Title + "\n" + strings.Join(rec.Topics, " ") + "\n" + strings.Join(rec.Tags, " ")
					if rec.SourcePath != "" {
						if bytes, err := os.ReadFile(rec.SourcePath); err == nil {
							content += "\n\n" + string(bytes)
						}
					}

					data := struct {
						Content string `json:"Content"`
					}{Content: content}

					if err := bleveBatch.Index(task.id, data); err != nil {
						logger.Info(logger.CatLexical, "Failed to add index command for %s: %v", task.id, err)
					}
				} else if action == "DELETE" {
					bleveBatch.Delete(task.id)
				}
			}

			// Try Commit to Bleve
			if err := s.lexical.Batch(bleveBatch); err != nil {
				logger.Info(logger.CatLexical, "Failed to commit bleve batch: %v (Backing off %v)", err, backoff)
				time.Sleep(backoff)
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
				timer.Reset(pollInterval)
				continue
			}

			// Success, clear from DB Queue
			dbBatch := s.db.NewBatch()
			for _, k := range batchKeys {
				dbBatch.Delete(k, nil)
			}
			if err := dbBatch.Commit(pebble.Sync); err != nil {
				logger.Info(logger.CatLexical, "Failed to clear DB WAL queue: %v", err)
			}
			dbBatch.Close()

			backoff = 1 * time.Second
			if len(tasks) == 1000 {
				timer.Reset(1 * time.Millisecond) // immediate
			} else {
				timer.Reset(pollInterval)
			}
		}
	}
}
