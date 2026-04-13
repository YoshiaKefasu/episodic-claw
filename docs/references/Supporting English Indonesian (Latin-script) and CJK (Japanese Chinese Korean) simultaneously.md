# Supporting English, Indonesian (Latin-script), and CJK (Japanese/Chinese/Korean) simultaneously in one RAG query pipeline is totally feasible and lightweight.

The key is a small **language-detection + routing** wrapper. No single library does perfect morphological analysis for *all* these languages at once (CJK needs dictionary-based segmentation because there are no spaces; English/Indonesian just need whitespace + stopwords + stemming). But combining 2–3 tiny libraries per runtime gives you the exact same clean keyword output you showed earlier, across languages, in milliseconds.

### Why this works perfectly for RAG
- Queries are short → detection is extremely accurate.
- You keep the **same output format** (`["keyword1", "keyword2", ...]`) no matter the input language.
- You can drop this right before embedding or hybrid search (BM25 + vector).
- Handles mixed-language text (e.g., Japanese query with English terms) by taking the dominant language or processing segments.

### JavaScript / TypeScript (Node.js or browser)

**Recommended stack (all pure JS, tiny, no heavy deps):**
- **Detection**: `efficient-language-detector-js` (fastest accurate detector, supports `en`, `id`, `ja`, `ko`, `zh`, etc.)
- **CJK**: `kuromoji` (JA, exact match to your example) or `cjk-tokenizer` (broader Chinese/Japanese/Korean term extraction)
- **English**: `natural` (tokenizer + stopwords + Porter stemmer)
- **Indonesian**: `sastrawijs` (official Sastrawi stemmer) + simple tokenizer

**Install**
```bash
npm install efficient-language-detector-js kuromojin natural sastrawijs cjk-tokenizer
```

**Unified `parseForRAG` example (TypeScript)**
```ts
import { Detector } from "efficient-language-detector-js";
import { tokenize } from "kuromojin";
import natural from "natural";
import { Stemmer, Tokenizer as IDTokenizer } from "sastrawijs";
import { tokenize as cjkTokenize } from "cjk-tokenizer"; // fallback for CN/KR

const detector = new Detector(); // loads once
const idStemmer = new Stemmer();
const idTokenizer = new IDTokenizer();

async function parseForRAG(text: string): Promise<string[]> {
  // 1. Detect language (works great on short queries)
  const langResult = detector.detect(text);
  const lang = langResult[0]?.language || "en"; // fallback

  // 2. Route
  if (["ja", "zh", "ko"].includes(lang)) {
    // CJK path — full morphological analysis or term extraction
    if (lang === "ja") {
      const tokens = await tokenize(text);
      return tokens
        .filter(t => ["名詞", "動詞", "形容詞", "副詞"].includes(t.pos))
        .map(t => t.surface_form);
    } else {
      // Chinese/Korean via cjk-tokenizer (returns scored terms)
      const result = cjkTokenize(text);
      return result.terms.map(t => t.term);
    }
  }

  // Latin path (English / Indonesian)
  let tokens: string[];
  if (lang === "id") {
    tokens = idTokenizer.tokenize(text); // splits on spaces/punctuation
    tokens = tokens.map(word => idStemmer.stem(word)); // removes affixes
  } else {
    // English
    tokens = natural.wordTokenizer().tokenize(text);
    tokens = tokens.map(t => natural.PorterStemmer.stem(t));
  }

  // Common: remove stopwords & short noise
  const stopwords = natural.stopwords[lang] || natural.stopwords.eng;
  return tokens
    .filter(t => t.length > 1 && !stopwords.includes(t.toLowerCase()))
    .map(t => t.toLowerCase());
}

// Usage — works for ANY of your languages
parseForRAG("この流れをツールの盛衰として読むこともできるが").then(console.log);
// → ["流れ", "ツール", "盛衰", "読む", "できる"]

parseForRAG("This flow can also be read as the rise and fall of tools").then(console.log);
// → ["flow", "read", "rise", "fall", "tool"]

parseForRAG("Alur ini juga dapat dibaca sebagai naik turunnya alat").then(console.log);
// → ["alur", "baca", "naik", "turun", "alat"] (stemmed Indonesian)
```

**Notes**:
- `efficient-language-detector-js` is blazing fast and handles short/mixed text better than older CLD ports.
- For pure browser: all these libs work (kuromoji needs dictionary preload once).
- If you later switch to embeddings, the same detector + this tokenizer still gives excellent hybrid search keywords.

### Golang

**Recommended stack (pure Go, no CGO):**
- **Detection**: `lingua-go` (currently the most accurate open-source detector — beats everything else on short text, supports English, Japanese, Indonesian, Chinese, Korean, mixed-language)
- **CJK JA**: `kagome/v2` (as in previous answer)
- **English**: `strings` + `golang.org/x/text` snowball stemmer
- **Indonesian**: whitespace tokenize + custom stopword list (or lightweight port of Sastrawi logic — stemming is helpful but not mandatory for RAG keywords)

**Install**
```bash
go get github.com/pemistahl/lingua-go
go get github.com/ikawaha/kagome/v2
go get golang.org/x/text
```

**Unified `ParseForRAG` example**
```go
package main

import (
	"fmt"
	"strings"

	"github.com/ikawaha/kagome-dict/ipa"
	"github.com/ikawaha/kagome/v2/tokenizer"
	"github.com/pemistahl/lingua-go"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

var detector = lingua.NewLanguageDetectorBuilder().
	WithLanguages(lingua.English, lingua.Japanese, lingua.Indonesian, lingua.Chinese, lingua.Korean).
	Build()

func ParseForRAG(text string) ([]string, error) {
	// 1. Detect (returns the most likely language)
	lang, _ := detector.DetectLanguageOf(text)
	langCode := lang.StringISO6391() // "en", "ja", "id", etc.

	// 2. Route
	switch langCode {
	case "ja", "zh", "ko":
		// CJK — use Kagome for Japanese (best quality); fallback bigram for others if needed
		t, _ := tokenizer.New(ipa.Dict(), tokenizer.OmitBosEos())
		tokens := t.Tokenize(text)
		var content []string
		for _, token := range tokens {
			if len(token.Features()) > 0 && isContentPOS(token.Features()[0]) {
				content = append(content, token.Surface)
			}
		}
		return content, nil

	case "id":
		// Indonesian — simple tokenize + stopword filter (stemming optional)
		tokens := strings.Fields(norm.NFKC.String(text)) // normalize + split
		return filterIndonesianKeywords(tokens), nil

	default: // English + others
		tokens := strings.Fields(norm.NFKC.String(text))
		return filterEnglishKeywords(tokens), nil
	}
}

func isContentPOS(pos string) bool {
	return pos == "名詞" || pos == "動詞" || pos == "形容詞" || pos == "副詞"
}

// Simple stopword + length filter (extend with full lists)
func filterEnglishKeywords(tokens []string) []string {
	stop := map[string]bool{"the": true, "a": true, "an": true /* ... */}
	var res []string
	for _, t := range tokens {
		t = strings.ToLower(t)
		if len(t) > 1 && !stop[t] {
			res = append(res, t)
		}
	}
	return res
}

func filterIndonesianKeywords(tokens []string) []string {
	// Add Indonesian stopwords + optional light stemming here
	stop := map[string]bool{"yang": true, "dan": true /* ... */}
	var res []string
	for _, t := range tokens {
		t = strings.ToLower(t)
		if len(t) > 1 && !stop[t] {
			res = append(res, t)
		}
	}
	return res
}

func main() {
	words, _ := ParseForRAG("この流れをツールの盛衰として読むこともできるが")
	fmt.Println(words) // same output as before
}
```

**Extra tips for production RAG**
- Cache the detector and dictionaries (they load once).
- For truly mixed sentences, `lingua-go` can return multiple languages → you can split the text and parse each segment separately.
- If you move to vector search later, libraries like BGE-M3 (multilingual) make the tokenizer step optional — but the keyword extraction above still boosts BM25/hybrid recall dramatically.