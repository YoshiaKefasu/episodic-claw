package frontmatter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
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

// Parse extracts metadata and the body from a markdown file.
// Supports three formats (in order of precedence):
// 1. Invisible Footer (v0.4.0+): <!-- episodic-meta\n{json}\n-->
// 2. YAML Frontmatter (v0.3.x): ---\nyaml...\n---
// 3. No metadata: entire file is body
func Parse(filePath string) (*MarkdownDocument, error) {
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}
	return ParseContent(content)
}

// ParseContent parses metadata from raw content bytes.
func ParseContent(content []byte) (*MarkdownDocument, error) {
	doc := &MarkdownDocument{}

	// 1. Try Invisible Footer (v0.4.0+)
	if rec, body, ok := parseFooterMetadata(content); ok {
		doc.Metadata = *rec
		doc.Body = body
		return doc, nil
	}

	// 2. Try YAML Frontmatter (v0.3.x)
	parts := bytes.SplitN(content, []byte("---"), 3)
	if len(parts) >= 3 && len(bytes.TrimSpace(parts[0])) == 0 {
		if err := yaml.Unmarshal(parts[1], &doc.Metadata); err != nil {
			// Malformed YAML — treat as plain text
			doc.Body = string(content)
			return doc, nil
		}
		doc.Body = string(bytes.TrimLeft(parts[2], "\n\r"))
		return doc, nil
	}

	// 3. No metadata found — entire file is body
	doc.Body = string(content)
	return doc, nil
}

// FooterMetadata is the JSON structure stored in the HTML comment footer.
type FooterMetadata struct {
	ID               string    `json:"id"`
	Title            string    `json:"title,omitempty"`
	Created          time.Time `json:"created"`
	Tags             []string  `json:"tags"`
	Topics           []string  `json:"topics,omitempty"`
	SavedBy          string    `json:"saved_by,omitempty"`
	ConsolidationKey string    `json:"consolidation_key,omitempty"`
	Surprise         float64   `json:"surprise"`
	Depth            int       `json:"depth,omitempty"`
	Tokens           int       `json:"tokens,omitempty"`
	Sources          []string  `json:"sources,omitempty"`
	RelatedTo        []Edge    `json:"related_to,omitempty"`
	RefineFailed     bool      `json:"refine_failed,omitempty"`
}

const footerMarker = "<!-- episodic-meta"

// parseFooterMetadata extracts metadata from the Invisible Footer format.
// Returns (record, body, true) if footer found, (nil, content, false) otherwise.
func parseFooterMetadata(content []byte) (*EpisodeMetadata, string, bool) {
	idx := bytes.LastIndex(content, []byte(footerMarker))
	if idx < 0 {
		return nil, string(content), false
	}

	endMarker := []byte("-->")
	remaining := content[idx:]
	endIdx := bytes.Index(remaining, endMarker)
	if endIdx < 0 {
		return nil, string(content), false // Incomplete footer
	}

	jsonStr := strings.TrimSpace(string(remaining[len(footerMarker):endIdx]))
	var fm FooterMetadata
	if err := json.Unmarshal([]byte(jsonStr), &fm); err != nil {
		return nil, string(content), false // Invalid JSON — not a valid footer
	}

	body := strings.TrimRight(string(content[:idx]), "\n")
	return &EpisodeMetadata{
		ID:               fm.ID,
		Title:            fm.Title,
		Created:          fm.Created,
		Tags:             fm.Tags,
		Topics:           fm.Topics,
		SavedBy:          fm.SavedBy,
		ConsolidationKey: fm.ConsolidationKey,
		Surprise:         fm.Surprise,
		Depth:            fm.Depth,
		Tokens:           fm.Tokens,
		Sources:          fm.Sources,
		RelatedTo:        fm.RelatedTo,
		RefineFailed:     fm.RefineFailed,
	}, body, true
}

// Serialize writes the episode as body text with Invisible Footer metadata.
// Uses atomic write (.tmp -> rename) to prevent TOCTOU issues.
func Serialize(filePath string, doc *MarkdownDocument) error {
	// Build footer JSON
	fm := FooterMetadata{
		ID:               doc.Metadata.ID,
		Title:            doc.Metadata.Title,
		Created:          doc.Metadata.Created,
		Tags:             doc.Metadata.Tags,
		Topics:           doc.Metadata.Topics,
		SavedBy:          doc.Metadata.SavedBy,
		ConsolidationKey: doc.Metadata.ConsolidationKey,
		Surprise:         doc.Metadata.Surprise,
		Depth:            doc.Metadata.Depth,
		Tokens:           doc.Metadata.Tokens,
		Sources:          doc.Metadata.Sources,
		RelatedTo:        doc.Metadata.RelatedTo,
		RefineFailed:     doc.Metadata.RefineFailed,
	}

	metaJSON, err := json.Marshal(fm)
	if err != nil {
		return fmt.Errorf("failed to serialize footer metadata: %w", err)
	}

	var buf bytes.Buffer
	buf.WriteString(doc.Body)
	buf.WriteString("\n\n<!-- episodic-meta\n")
	buf.Write(metaJSON)
	buf.WriteString("\n-->\n")

	tmpPath := filePath + ".tmp"
	if err := os.WriteFile(tmpPath, buf.Bytes(), 0644); err != nil {
		return fmt.Errorf("failed to write tmp file: %w", err)
	}

	if err := os.Rename(tmpPath, filePath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("failed to rename tmp file: %w", err)
	}

	return nil
}
