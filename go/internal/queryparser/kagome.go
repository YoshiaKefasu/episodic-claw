package queryparser

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	ipa "github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
)

const kagomeSourceName = "go-japanese-kagome-query-parser"

var (
	kagomeInitOnce     sync.Once
	kagomeReady        chan struct{}
	kagomeTokenizer    *tokenizer.Tokenizer
	kagomeInitErr      error
	newKagomeTokenizer = func() (*tokenizer.Tokenizer, error) {
		return tokenizer.New(ipa.Dict(), tokenizer.OmitBosEos())
	}
)

var kagomeKeywordStopwords = map[string]struct{}{
	"これ":  {},
	"それ":  {},
	"あれ":  {},
	"どれ":  {},
	"この":  {},
	"その":  {},
	"あの":  {},
	"どの":  {},
	"ここ":  {},
	"そこ":  {},
	"あそこ": {},
	"どこ":  {},
	"こちら": {},
	"そちら": {},
	"あちら": {},
	"どちら": {},
	"こっち": {},
	"そっち": {},
	"あっち": {},
	"どっち": {},
	"こんな": {},
	"そんな": {},
	"あんな": {},
	"どんな": {},
	"こう":  {},
	"そう":  {},
	"ああ":  {},
	"どう":  {},
}

// ParseJapaneseQuery prefers Kagome when it is available quickly enough,
// and falls back to the existing lightweight parser when Kagome cannot be
// initialized or times out.
func ParseJapaneseQuery(ctx context.Context, text string) Result {
	if result, ok := parseJapaneseQueryKagome(ctx, text); ok {
		return result
	}
	return parseJapaneseQueryLightweight(ctx, text)
}

func parseJapaneseQueryKagome(ctx context.Context, text string) (Result, bool) {
	tok, err := waitForKagomeTokenizer(ctx)
	if err != nil {
		return Result{}, false
	}

	started := time.Now()
	trimmed := strings.TrimSpace(text)
	result := Result{Source: kagomeSourceName}
	if trimmed == "" {
		result.ElapsedMs = elapsedMsSince(started)
		return result, true
	}

	segments := make([]Segment, 0, 16)
	keywords := make([]string, 0, 12)
	seen := make(map[string]struct{}, 16)
	cursor := 0

	appendKeyword := func(value string) {
		term := strings.TrimSpace(value)
		if term == "" {
			return
		}
		key := strings.ToLower(term)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		keywords = append(keywords, term)
	}

	for _, token := range tok.Analyze(trimmed, tokenizer.Search) {
		if ctx != nil && ctx.Err() != nil {
			result.TimedOut = true
			break
		}

		surface := strings.TrimSpace(token.Surface)
		if surface == "" {
			cursor += len(token.Surface)
			continue
		}

		start := locateTokenOffset(trimmed, cursor, surface)
		if start < 0 {
			start = cursor
		}
		end := start + len(surface)
		cursor = end

		features := token.Features()
		pos1 := featureAt(features, 0)
		baseForm := featureAt(features, 6)
		reading := featureAt(features, 7)
		if baseForm == "" || baseForm == "*" {
			baseForm = surface
		}
		if reading == "" || reading == "*" {
			reading = surface
		}

		kind := kagomeTokenKind(pos1)
		segments = append(segments, Segment{
			Text:    surface,
			Reading: reading,
			Lemma:   baseForm,
			Kind:    string(kind),
			Start:   start,
			End:     end,
		})

		if shouldCountKagomeKeyword(surface, pos1) {
			appendKeyword(surface)
		}
	}

	result.Segments = segments
	result.Keywords = keywords
	result.ElapsedMs = elapsedMsSince(started)
	if result.TimedOut {
		return Result{}, false
	}
	return result, true
}

func waitForKagomeTokenizer(ctx context.Context) (*tokenizer.Tokenizer, error) {
	startKagomeTokenizerInit()

	waitCtx := ctx
	if waitCtx == nil {
		waitCtx = context.Background()
	}
	if _, ok := waitCtx.Deadline(); !ok {
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithTimeout(waitCtx, 150*time.Millisecond)
		defer cancel()
	}

	select {
	case <-kagomeReady:
		if kagomeTokenizer != nil {
			return kagomeTokenizer, nil
		}
		if kagomeInitErr != nil {
			return nil, kagomeInitErr
		}
		return nil, errors.New("kagome tokenizer unavailable")
	case <-waitCtx.Done():
		return nil, waitCtx.Err()
	}
}

func startKagomeTokenizerInit() {
	kagomeInitOnce.Do(func() {
		kagomeReady = make(chan struct{})
		go func() {
			defer close(kagomeReady)

			tok, err := newKagomeTokenizer()
			if err != nil {
				kagomeInitErr = err
				return
			}

			kagomeTokenizer = tok
		}()
	})
}

// WarmUpKagomeTokenizer starts Kagome initialization in the background.
func WarmUpKagomeTokenizer() {
	startKagomeTokenizerInit()
}

func locateTokenOffset(text string, cursor int, surface string) int {
	if cursor < 0 {
		cursor = 0
	}
	if cursor >= len(text) {
		return -1
	}
	remaining := text[cursor:]
	idx := strings.Index(remaining, surface)
	if idx < 0 {
		return -1
	}
	return cursor + idx
}

func featureAt(features []string, index int) string {
	if index < 0 || index >= len(features) {
		return ""
	}
	return features[index]
}

func kagomeTokenKind(pos1 string) tokenKind {
	switch pos1 {
	case "助詞":
		return kindParticle
	case "助動詞":
		return kindAux
	default:
		return kindContent
	}
}

func shouldCountKagomeKeyword(surface, pos1 string) bool {
	if surface == "" {
		return false
	}
	if _, ok := kagomeKeywordStopwords[surface]; ok {
		return false
	}
	switch pos1 {
	case "助詞", "助動詞", "記号", "代名詞":
		return false
	default:
		return true
	}
}

func elapsedMsSince(start time.Time) float64 {
	return float64(time.Since(start).Microseconds()) / 1000.0
}
