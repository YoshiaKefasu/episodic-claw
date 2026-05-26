package queryparser

import (
	"context"
	"testing"
	"time"
)

const benchmarkJapaneseText = "TypeScriptのQueryBuilderが遅いのでGo Parserで改善したい。"

func BenchmarkParseJapaneseQueryLightweight(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = parseJapaneseQueryLightweight(context.Background(), benchmarkJapaneseText)
	}
}

func BenchmarkParseJapaneseQueryLightweightThrottled(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		time.Sleep(5 * time.Millisecond)
		_ = parseJapaneseQueryLightweight(context.Background(), benchmarkJapaneseText)
	}
}

// BenchmarkParseJapaneseQueryKagomeCold measures a process-cold first parse,
// before main.go's background warm-up can finish.
func BenchmarkParseJapaneseQueryKagomeCold(b *testing.B) {
	b.ReportAllocs()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for i := 0; i < b.N; i++ {
		if _, ok := parseJapaneseQueryKagome(ctx, benchmarkJapaneseText); !ok {
			b.Fatal("kagome parser should initialize during cold benchmark")
		}
	}
}

func BenchmarkParseJapaneseQueryKagomeWarm(b *testing.B) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, ok := parseJapaneseQueryKagome(ctx, benchmarkJapaneseText); !ok {
		b.Fatal("kagome parser should initialize before benchmark")
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, ok := parseJapaneseQueryKagome(context.Background(), benchmarkJapaneseText); !ok {
			b.Fatal("kagome parser should stay available during warm benchmark")
		}
	}
}

func BenchmarkParseJapaneseQueryKagomeWarmThrottled(b *testing.B) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, ok := parseJapaneseQueryKagome(ctx, benchmarkJapaneseText); !ok {
		b.Fatal("kagome parser should initialize before throttled benchmark")
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		time.Sleep(5 * time.Millisecond)
		if _, ok := parseJapaneseQueryKagome(context.Background(), benchmarkJapaneseText); !ok {
			b.Fatal("kagome parser should stay available during throttled benchmark")
		}
	}
}
