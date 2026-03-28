package indexer

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"episodic-core/frontmatter"
)

// CachedEpisode stores the metadata and the modification time
type CachedEpisode struct {
	Metadata  frontmatter.EpisodeMetadata `json:"metadata"`
	UpdatedAt int64                       `json:"updated_at"`
}

// IndexCache wraps the metadata map for disk storage
type IndexCache struct {
	Episodes map[string]CachedEpisode `json:"episodes"`
}

var currentCache *IndexCache
var cacheFilePath string

// InitCache setups the index cache location
func InitCache(dir string) {
	cacheFilePath = filepath.Join(dir, ".episodic_index.json")
	currentCache = &IndexCache{
		Episodes: make(map[string]CachedEpisode),
	}
	
	data, err := os.ReadFile(cacheFilePath)
	if err == nil {
		json.Unmarshal(data, currentCache)
	}
}

// SaveCache flushes the current map to disk
func SaveCache() error {
	if cacheFilePath == "" {
		return nil
	}
	data, err := json.MarshalIndent(currentCache, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(cacheFilePath, data, 0644)
}

// BuildIndex traverses the directory and updates ONLY changed markdown files based on ModTime/existence.
func BuildIndex(dir string) ([]frontmatter.EpisodeMetadata, error) {
	if cacheFilePath == "" {
		InitCache(dir)
	}

	validKeys := make(map[string]bool)

	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && strings.HasSuffix(strings.ToLower(info.Name()), ".md") {
			relPath, _ := filepath.Rel(dir, path)
			validKeys[relPath] = true

			// Check if file is missing from cache or has been modified
			if cached, exists := currentCache.Episodes[relPath]; !exists || info.ModTime().Unix() > cached.UpdatedAt {
				doc, err := frontmatter.Parse(path)
				if err == nil {
					currentCache.Episodes[relPath] = CachedEpisode{
						Metadata:  doc.Metadata,
						UpdatedAt: info.ModTime().Unix(),
					}
				}
			}
		}
		return nil
	})

	if err != nil {
		return nil, err
	}

	// Remove deleted files from cache
	for k := range currentCache.Episodes {
		if !validKeys[k] {
			delete(currentCache.Episodes, k)
		}
	}

	SaveCache()

	// Build return slice
	var index []frontmatter.EpisodeMetadata
	for _, cached := range currentCache.Episodes {
		index = append(index, cached.Metadata)
	}

	return index, nil
}
