package queryparser

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/ikawaha/kagome/v2/tokenizer"
)

func TestParseJapaneseQueryLightweight(t *testing.T) {
	result := parseJapaneseQueryLightweight(context.Background(), "一番安全で強い案はこれです。")
	if result.TimedOut {
		t.Fatalf("expected no timeout, got timedOut=%v", result.TimedOut)
	}
	if result.Source != sourceName {
		t.Fatalf("expected source %q, got %q", sourceName, result.Source)
	}
	expectedSegments := []string{"一番", "安全", "で", "強い", "案", "は", "これ", "です"}
	if len(result.Segments) != len(expectedSegments) {
		t.Fatalf("expected %d segments, got %d: %#v", len(expectedSegments), len(result.Segments), result.Segments)
	}
	for i, expected := range expectedSegments {
		if result.Segments[i].Text != expected {
			t.Fatalf("segment %d: expected %q, got %q", i, expected, result.Segments[i].Text)
		}
	}
	expectedKeywords := []string{"一番", "安全", "強い", "案", "これ"}
	if len(result.Keywords) != len(expectedKeywords) {
		t.Fatalf("expected %d keywords, got %d: %#v", len(expectedKeywords), len(result.Keywords), result.Keywords)
	}
	for i, expected := range expectedKeywords {
		if result.Keywords[i] != expected {
			t.Fatalf("keyword %d: expected %q, got %q", i, expected, result.Keywords[i])
		}
	}
}

func TestParseJapaneseQueryLightweightMixedScript(t *testing.T) {
	result := parseJapaneseQueryLightweight(context.Background(), "TypeScriptのQueryBuilderが遅いのでGo Parserで改善したい。")
	if result.TimedOut {
		t.Fatalf("expected no timeout, got timedOut=%v", result.TimedOut)
	}
	expectedKeywords := []string{"TypeScript", "QueryBuilder", "遅い", "Go", "Parser", "改善"}
	if len(result.Keywords) != len(expectedKeywords) {
		t.Fatalf("expected %d keywords, got %d: %#v", len(expectedKeywords), len(result.Keywords), result.Keywords)
	}
	for i, expected := range expectedKeywords {
		if result.Keywords[i] != expected {
			t.Fatalf("keyword %d: expected %q, got %q", i, expected, result.Keywords[i])
		}
	}
}

func TestParseJapaneseQueryLightweightTimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result := parseJapaneseQueryLightweight(ctx, "タイムアウト検証")
	if !result.TimedOut {
		t.Fatalf("expected timedOut=true when context is cancelled, got %#v", result)
	}
}

func TestParseJapaneseQueryLightweightEmptyInput(t *testing.T) {
	result := parseJapaneseQueryLightweight(context.Background(), "   ")
	if result.TimedOut {
		t.Fatalf("empty input should not time out: %#v", result)
	}
	if len(result.Segments) != 0 || len(result.Keywords) != 0 {
		t.Fatalf("empty input should return no segments or keywords: %#v", result)
	}
}

func TestParseJapaneseQueryLightweightLatinOnly(t *testing.T) {
	result := parseJapaneseQueryLightweight(context.Background(), "Hello world Go Parser")
	if result.TimedOut {
		t.Fatalf("latin-only input should not time out: %#v", result)
	}
	expectedKeywords := []string{"Hello", "world", "Go", "Parser"}
	if len(result.Keywords) != len(expectedKeywords) {
		t.Fatalf("expected %d latin keywords, got %d: %#v", len(expectedKeywords), len(result.Keywords), result.Keywords)
	}
	for i, expected := range expectedKeywords {
		if result.Keywords[i] != expected {
			t.Fatalf("latin keyword %d: expected %q, got %q", i, expected, result.Keywords[i])
		}
	}
}

func TestParseJapaneseQueryLightweightHanFallback(t *testing.T) {
	result := parseJapaneseQueryLightweight(context.Background(), "漢字漢字漢字")
	if result.TimedOut {
		t.Fatalf("fallback Han input should not time out: %#v", result)
	}
	if len(result.Segments) == 0 || len(result.Keywords) == 0 {
		t.Fatalf("fallback Han input should yield segments and keywords: %#v", result)
	}
}

func TestParseJapaneseQueryKagomeSmoke(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, ok := parseJapaneseQueryKagome(ctx, "すもももももももものうち")
	if !ok {
		t.Fatalf("expected kagome parser to initialize and parse successfully: %#v", result)
	}
	if result.Source != kagomeSourceName {
		t.Fatalf("expected kagome source %q, got %q", kagomeSourceName, result.Source)
	}
	if result.TimedOut {
		t.Fatalf("kagome smoke test should not time out: %#v", result)
	}
	if len(result.Segments) == 0 || len(result.Keywords) == 0 {
		t.Fatalf("kagome smoke test should yield segments and keywords: %#v", result)
	}
	if result.Segments[0].Text == "" {
		t.Fatalf("kagome first segment should not be empty: %#v", result)
	}
}

func TestParseJapaneseQueryKagomeOffsets(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	source := "すもももももももものうち"
	result, ok := parseJapaneseQueryKagome(ctx, source)
	if !ok {
		t.Fatalf("expected kagome parser to initialize and parse successfully: %#v", result)
	}
	if len(result.Segments) == 0 {
		t.Fatalf("expected kagome offsets smoke to yield segments: %#v", result)
	}
	for i, seg := range result.Segments {
		if seg.Start < 0 || seg.End < seg.Start || seg.End > len(source) {
			t.Fatalf("offset smoke segment %d has invalid offsets: %#v", i, seg)
		}
		if source[seg.Start:seg.End] != seg.Text {
			t.Fatalf("offset smoke segment %d mismatch: source[%d:%d]=%q text=%q", i, seg.Start, seg.End, source[seg.Start:seg.End], seg.Text)
		}
		if i > 0 && seg.Start < result.Segments[i-1].End {
			t.Fatalf("offset smoke segments overlap: prev=%#v current=%#v", result.Segments[i-1], seg)
		}
	}
}

func TestParseJapaneseQueryKagomeGolden(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, ok := parseJapaneseQueryKagome(ctx, "一番安全で強い案はこれです。")
	if !ok {
		t.Fatalf("expected kagome parser to initialize and parse successfully: %#v", result)
	}

	expectedKeywords := []string{"一番", "安全", "強い", "案"}
	assertStringSliceEqual(t, "kagome golden keywords", result.Keywords, expectedKeywords)

	expectedSegments := []string{"一番", "安全", "で", "強い", "案", "は", "これ", "です", "。"}
	assertSegmentTextsEqual(t, "kagome golden segments", "一番安全で強い案はこれです。", result.Segments, expectedSegments)
}

func TestParseJapaneseQueryKagomeStopwordExclusion(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, ok := parseJapaneseQueryKagome(ctx, "これそれあれどれここそこあそこどここのそのあのどの")
	if !ok {
		t.Fatalf("expected kagome parser to initialize and parse successfully: %#v", result)
	}
	if len(result.Keywords) != 0 {
		t.Fatalf("expected stopwords/こそあど to be excluded from keywords, got %#v", result.Keywords)
	}
}

func TestParseJapaneseQueryKagomeLatinRetention(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, ok := parseJapaneseQueryKagome(ctx, "TypeScriptのQueryBuilderが遅いのでGo Parserで改善したい。")
	if !ok {
		t.Fatalf("expected kagome parser to initialize and parse successfully: %#v", result)
	}

	expectedKeywords := []string{"TypeScript", "QueryBuilder", "遅い", "Go", "Parser", "改善"}
	assertStringSliceContainsAll(t, "kagome latin retention", result.Keywords, expectedKeywords)
	assertStringSliceNotContainsAny(t, "kagome latin retention stopwords", result.Keywords, []string{"の", "が", "で", "たい"})
}

func TestParseJapaneseQueryFallsBackWhenKagomeInitFails(t *testing.T) {
	originalOnce := kagomeInitOnce
	originalReady := kagomeReady
	originalTokenizer := kagomeTokenizer
	originalErr := kagomeInitErr
	originalFactory := newKagomeTokenizer
	defer func() {
		kagomeInitOnce = originalOnce
		kagomeReady = originalReady
		kagomeTokenizer = originalTokenizer
		kagomeInitErr = originalErr
		newKagomeTokenizer = originalFactory
	}()

	kagomeInitOnce = sync.Once{}
	kagomeReady = nil
	kagomeTokenizer = nil
	kagomeInitErr = nil
	newKagomeTokenizer = func() (*tokenizer.Tokenizer, error) {
		return nil, errors.New("forced kagome init failure")
	}

	result := ParseJapaneseQuery(context.Background(), "一番安全で強い案はこれです。")
	if result.Source != sourceName {
		t.Fatalf("expected lightweight fallback source %q, got %q", sourceName, result.Source)
	}
	if result.TimedOut {
		t.Fatalf("fallback result should not time out: %#v", result)
	}
	if len(result.Keywords) == 0 {
		t.Fatalf("fallback result should preserve lightweight keywords: %#v", result)
	}
}

func assertStringSliceEqual(t *testing.T, label string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: expected %d items, got %d: %#v", label, len(want), len(got), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: item %d expected %q, got %q", label, i, want[i], got[i])
		}
	}
}

func assertStringSliceContainsAll(t *testing.T, label string, got, want []string) {
	t.Helper()
	for _, expected := range want {
		found := false
		for _, item := range got {
			if item == expected {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s: expected %q to be present in %#v", label, expected, got)
		}
	}
}

func assertStringSliceNotContainsAny(t *testing.T, label string, got, forbidden []string) {
	t.Helper()
	for _, disallowed := range forbidden {
		for _, item := range got {
			if item == disallowed {
				t.Fatalf("%s: unexpected %q found in %#v", label, disallowed, got)
			}
		}
	}
}

func assertSegmentTextsEqual(t *testing.T, label, source string, segments []Segment, want []string) {
	t.Helper()
	if len(segments) != len(want) {
		t.Fatalf("%s: expected %d segments, got %d: %#v", label, len(want), len(segments), segments)
	}
	for i, expected := range want {
		if segments[i].Text != expected {
			t.Fatalf("%s: segment %d expected %q, got %q", label, i, expected, segments[i].Text)
		}
	}
	for i, seg := range segments {
		if seg.Start < 0 || seg.End < seg.Start {
			t.Fatalf("%s: segment %d has invalid offsets: %#v", label, i, seg)
		}
		if seg.End > len(source) {
			t.Fatalf("%s: segment %d extends beyond input: %#v", label, i, seg)
		}
		if source[seg.Start:seg.End] != seg.Text {
			t.Fatalf("%s: segment %d offset/text mismatch: source[%d:%d]=%q text=%q", label, i, seg.Start, seg.End, source[seg.Start:seg.End], seg.Text)
		}
	}
}
