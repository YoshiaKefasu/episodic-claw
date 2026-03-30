package vector

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

var systemTags = map[string]struct{}{
	"auto-segmented":    {},
	"chunked":           {},
	"surprise-boundary": {},
	"size-limit":        {},
	"force-flush":       {},
	"gap-compacted":     {},
	"archived":          {},
	"d1-summary":        {},
	"manual-save":       {},
	"genesis-archive":   {},
	"auto-record":       {},
}

// ValidateTopics normalizes user-facing topics and removes low-quality entries.
// It keeps the caller's language/script but applies NFKC + trim + dedupe.
func ValidateTopics(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}

	out := make([]string, 0, min(len(raw), 10))
	seen := make(map[string]struct{}, len(raw))

	for _, item := range raw {
		topic := sanitizeTopic(item)
		if topic == "" {
			continue
		}
		key := topicKey(topic)
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		if looksLikeGarbageTopic(topic) {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, topic)
		if len(out) >= 10 {
			break
		}
	}

	return out, nil
}

// LegacyTopicsFromTags converts pre-topics-era tags into topics by dropping
// known system lifecycle tags and normalizing the remainder.
func LegacyTopicsFromTags(tags []string) []string {
	if len(tags) == 0 {
		return nil
	}

	filtered := make([]string, 0, len(tags))
	for _, tag := range tags {
		tag = sanitizeTopic(tag)
		if tag == "" {
			continue
		}
		if isSystemTag(tag) {
			continue
		}
		filtered = append(filtered, tag)
	}

	topics, _ := ValidateTopics(filtered)
	return topics
}

func sanitizeTopic(raw string) string {
	topic := strings.TrimSpace(raw)
	if topic == "" {
		return ""
	}
	return strings.TrimSpace(norm.NFKC.String(topic))
}

func topicKey(topic string) string {
	if topic == "" {
		return ""
	}
	return strings.ToLower(norm.NFKC.String(strings.TrimSpace(topic)))
}

func isSystemTag(tag string) bool {
	_, ok := systemTags[topicKey(tag)]
	return ok
}

func looksLikeGarbageTopic(topic string) bool {
	if topic == "" {
		return true
	}
	if utf8.RuneCountInString(topic) > 50 {
		return true
	}
	if strings.ContainsAny(topic, "\r\n\t") {
		return true
	}
	if len(strings.Fields(topic)) > 6 {
		return true
	}

	lowered := strings.ToLower(topic)
	badPhrases := []string{
		"as an ai",
		"here is",
		"here are",
		"以下は",
		"要約",
		"まとめ",
		"もちろん",
		"了解",
		"承知",
	}
	for _, phrase := range badPhrases {
		if strings.Contains(lowered, phrase) {
			return true
		}
	}

	// Reject strings that are mostly punctuation or symbols.
	letterCount := 0
	for _, r := range topic {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			letterCount++
		}
	}
	return letterCount == 0
}
