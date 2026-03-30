package frontmatter

import (
	"bytes"
	"fmt"
	"os"
	"time"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// EpisodeMetadata represents the frontmatter structure of an episode.
type EpisodeMetadata struct {
	ID               string    `yaml:"id"`
	Title            string    `yaml:"title"`
	Created          time.Time `yaml:"created,omitempty"`
	Tags             []string  `yaml:"tags,omitempty"`
	Topics           []string  `yaml:"topics,omitempty"`
	SavedBy          string    `yaml:"saved_by,omitempty"`
	ConsolidationKey string    `yaml:"consolidation_key,omitempty"`
	Surprise         float64   `yaml:"surprise"`
	Depth            int       `yaml:"depth,omitempty"`
	Tokens           int       `yaml:"tokens,omitempty"`
	Sources          []string  `yaml:"sources,omitempty"`
	RelatedTo        []Edge    `yaml:"related_to,omitempty"`
	RefineFailed     bool      `yaml:"refine_failed,omitempty"`
}

type Edge struct {
	ID     string  `yaml:"id"`
	Type   string  `yaml:"type"` // e.g., "temporal", "semantic", "causal"
	Weight float64 `yaml:"weight,omitempty"`
}

// EstimateTokens returns a rough token count for multilingual text.
// Uses Unicode rune count / 3 to handle both CJK (no spaces) and Latin text.
func EstimateTokens(s string) int {
	n := utf8.RuneCountInString(s)
	if n == 0 {
		return 0
	}
	est := n / 3
	if est < 1 {
		return 1
	}
	return est
}

// MarkdownDocument represents a parsed markdown file.
type MarkdownDocument struct {
	Metadata EpisodeMetadata
	Body     string // The rest of the markdown content
}

// Parse extracts the YAML frontmatter and the body from a markdown file.
func Parse(filePath string) (*MarkdownDocument, error) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	doc := &MarkdownDocument{}

	// Split at "---"
	parts := bytes.SplitN(content, []byte("---"), 3)
	if len(parts) >= 3 && len(bytes.TrimSpace(parts[0])) == 0 {
		// Valid frontmatter format found
		if err := yaml.Unmarshal(parts[1], &doc.Metadata); err != nil {
			return nil, fmt.Errorf("failed to parse frontmatter: %w", err)
		}
		doc.Body = string(bytes.TrimLeft(parts[2], "\n\r"))
	} else {
		// No frontmatter found, return everything as body
		doc.Body = string(content)
	}

	return doc, nil
}

// Serialize converts metadata and body back into a markdown file with frontmatter.
// Uses an atomic write pattern (.tmp -> rename) to prevent TOCTOU reading issues (P3-D fix).
func Serialize(filePath string, doc *MarkdownDocument) error {
	var buf bytes.Buffer

	// Write frontmatter
	buf.WriteString("---\n")
	encoder := yaml.NewEncoder(&buf)
	encoder.SetIndent(2)
	if err := encoder.Encode(doc.Metadata); err != nil {
		return fmt.Errorf("failed to serialize frontmatter: %w", err)
	}
	buf.WriteString("---\n\n")
	buf.WriteString(doc.Body)

	tmpPath := filePath + ".tmp"
	if err := os.WriteFile(tmpPath, buf.Bytes(), 0644); err != nil {
		return fmt.Errorf("failed to write tmp file: %w", err)
	}

	if err := os.Rename(tmpPath, filePath); err != nil {
		os.Remove(tmpPath) // Cleanup on error
		return fmt.Errorf("failed to rename tmp file: %w", err)
	}

	return nil
}
