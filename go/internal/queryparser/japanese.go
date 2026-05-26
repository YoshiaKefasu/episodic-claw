package queryparser

import (
	"context"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const sourceName = "go-japanese-query-parser"

type Segment struct {
	Text    string `json:"text"`
	Reading string `json:"reading,omitempty"`
	Lemma   string `json:"lemma,omitempty"`
	Kind    string `json:"kind"`
	Start   int    `json:"start"`
	End     int    `json:"end"`
}

type Result struct {
	Segments  []Segment `json:"segments"`
	Keywords  []string  `json:"keywords"`
	ElapsedMs float64   `json:"elapsedMs"`
	TimedOut  bool      `json:"timedOut"`
	Source    string    `json:"source"`
}

type tokenKind string

const (
	kindParticle tokenKind = "particle"
	kindAux      tokenKind = "aux"
	kindContent  tokenKind = "content"
	kindLatin    tokenKind = "latin"
)

type lexiconEntry struct {
	Text string
	Kind tokenKind
}

type scriptKind int

const (
	scriptOther scriptKind = iota
	scriptHan
	scriptHiragana
	scriptKatakana
	scriptLatin
	kanjiHiraMixed
)

var particleAffixes = []string{
	"じゃなかった",
	"じゃない",
	"では",
	"には",
	"へは",
	"から",
	"まで",
	"より",
	"でも",
	"だけ",
	"ほど",
	"など",
	"について",
	"として",
	"にて",
	"とは",
	"って",
	"ので",
	"だって",
	"からも",
	"しか",
	"くらい",
	"ぐらい",
	"までに",
	"までの",
	"としても",
	"などの",
	"もの",
	"こと",
	"ほう",
	"たり",
	"です",
	"でした",
	"の",
	"は",
	"が",
	"を",
	"に",
	"で",
	"も",
	"へ",
	"と",
	"や",
	"か",
	"ね",
	"よ",
	"ぞ",
	"な",
	"さ",
	"だ",
	"た",
	"て",
	"ら",
	"り",
	"る",
}

var auxAffixes = []string{
	"している",
	"していた",
	"できない",
	"かもしれない",
	"でしたら",
	"して",
	"したい",
	"した",
	"する",
	"できる",
	"なかった",
	"ました",
	"ません",
	"ませんでした",
	"なく",
	"ない",
	"だった",
	"たい",
	"れる",
	"られる",
	"させる",
	"せる",
	"よう",
	"みたい",
	"っぽい",
	"そう",
	"そうだ",
	"そうです",
	"でしょう",
	"ようだ",
	"らしい",
	"う",
}

var contentLexicon = []string{
	"改善",
	"改善案",
	"安全",
	"一番",
	"強い",
	"案",
	"これ",
	"速度",
	"大事",
	"エージェント",
	"メッセージ",
	"遅延",
	"返信",
	"時間",
	"日本語",
	"文節",
	"検索",
	"理解",
	"確認",
	"評価",
	"精度",
	"遅い",
	"速い",
	"実装",
	"計測",
	"反映",
	"注入",
	"入力",
	"出力",
	"結果",
	"候補",
	"解析",
	"分割",
}

var orderedAffixes []lexiconEntry
var orderedContent []string

func init() {
	orderedAffixes = make([]lexiconEntry, 0, len(particleAffixes)+len(auxAffixes))
	for _, term := range particleAffixes {
		orderedAffixes = append(orderedAffixes, lexiconEntry{Text: term, Kind: kindParticle})
	}
	for _, term := range auxAffixes {
		orderedAffixes = append(orderedAffixes, lexiconEntry{Text: term, Kind: kindAux})
	}
	sort.SliceStable(orderedAffixes, func(i, j int) bool {
		li := len([]rune(orderedAffixes[i].Text))
		lj := len([]rune(orderedAffixes[j].Text))
		if li == lj {
			return orderedAffixes[i].Text > orderedAffixes[j].Text
		}
		return li > lj
	})

	orderedContent = append([]string(nil), contentLexicon...)
	sort.SliceStable(orderedContent, func(i, j int) bool {
		li := len([]rune(orderedContent[i]))
		lj := len([]rune(orderedContent[j]))
		if li == lj {
			return orderedContent[i] > orderedContent[j]
		}
		return li > lj
	})
}

func parseJapaneseQueryLightweight(ctx context.Context, text string) Result {
	started := time.Now()
	trimmed := strings.TrimSpace(text)
	result := Result{Source: sourceName}
	if trimmed == "" {
		result.ElapsedMs = float64(time.Since(started).Microseconds()) / 1000.0
		return result
	}

	segments := make([]Segment, 0, 16)
	keywords := make([]string, 0, 12)
	seen := make(map[string]struct{}, 16)
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
	appendSegment := func(text string, kind tokenKind, start, end int) {
		if text == "" || end <= start {
			return
		}
		segment := Segment{Text: text, Reading: text, Lemma: text, Kind: string(kind), Start: start, End: end}
		segments = append(segments, segment)
		if kind == kindContent || kind == kindLatin {
			appendKeyword(text)
		}
	}

	for i := 0; i < len(trimmed); {
		if ctx != nil && ctx.Err() != nil {
			result.TimedOut = true
			break
		}

		r, size := utf8.DecodeRuneInString(trimmed[i:])
		if r == utf8.RuneError && size == 1 {
			i++
			continue
		}
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			i += size
			continue
		}

		if isLatinWordRune(r) {
			start := i
			j := i + size
			for j < len(trimmed) {
				r2, s2 := utf8.DecodeRuneInString(trimmed[j:])
				if !isLatinWordRune(r2) {
					break
				}
				j += s2
			}
			if token := trimmed[start:j]; len(token) >= 2 {
				appendSegment(token, kindLatin, start, j)
			}
			i = j
			continue
		}

		if isJapaneseRune(r) {
			start := i
			j := i + size
			for j < len(trimmed) {
				r2, s2 := utf8.DecodeRuneInString(trimmed[j:])
				if !isJapaneseRune(r2) {
					break
				}
				j += s2
			}
			token := trimmed[start:j]
			for _, seg := range parseJapaneseToken(ctx, token, start) {
				appendSegment(seg.Text, tokenKind(seg.Kind), seg.Start, seg.End)
			}
			i = j
			continue
		}

		i += size
	}

	result.Segments = segments
	result.Keywords = keywords
	result.ElapsedMs = float64(time.Since(started).Microseconds()) / 1000.0
	return result
}

func parseJapaneseToken(ctx context.Context, token string, start int) []Segment {
	if token == "" {
		return nil
	}
	if kind, ok := classifyExactAffix(token); ok {
		return []Segment{makeSegment(token, kind, start)}
	}

	core, coreStart, prefixSegments, suffixSegments := peelAffixes(token, start)
	if core == "" {
		segments := append([]Segment{}, prefixSegments...)
		segments = append(segments, suffixSegments...)
		return segments
	}

	segments := make([]Segment, 0, 8)
	segments = append(segments, prefixSegments...)
	segments = append(segments, splitJapaneseCore(ctx, core, coreStart)...)
	segments = append(segments, suffixSegments...)
	return segments
}

func peelAffixes(token string, start int) (core string, coreStart int, prefixSegments []Segment, suffixSegments []Segment) {
	core = token
	coreStart = start
	for changed := true; changed && core != ""; {
		changed = false
		if kind, affix, ok := matchAffixPrefix(core); ok && len(core) > len(affix) {
			prefixSegments = append(prefixSegments, makeSegment(affix, kind, coreStart))
			core = core[len(affix):]
			coreStart += len(affix)
			changed = true
			continue
		}
		if kind, affix, ok := matchAffixSuffix(core); ok && len(core) > len(affix) {
			affixStart := coreStart + len(core) - len(affix)
			suffixSegments = append([]Segment{makeSegment(affix, kind, affixStart)}, suffixSegments...)
			core = core[:len(core)-len(affix)]
			changed = true
		}
	}
	return core, coreStart, prefixSegments, suffixSegments
}

func splitJapaneseCore(ctx context.Context, core string, start int) []Segment {
	if ctx != nil && ctx.Err() != nil {
		return nil
	}
	groups := splitByScript(core, start)
	groups = mergeShortKana(groups)
	segments := make([]Segment, 0, len(groups))
	for _, group := range groups {
		if ctx != nil && ctx.Err() != nil {
			break
		}
		if kind, ok := classifyExactAffix(group.text); ok {
			segments = append(segments, makeSegment(group.text, kind, group.start))
			continue
		}
		switch group.kind {
		case scriptHan:
			segments = append(segments, splitHanGroup(group.text, group.start)...)
		case scriptHiragana:
			segments = append(segments, splitHiraganaGroup(group.text, group.start)...)
		case scriptKatakana, kanjiHiraMixed:
			segments = append(segments, makeSegment(group.text, kindContent, group.start))
		default:
			segments = append(segments, makeSegment(group.text, kindContent, group.start))
		}
	}
	return segments
}

func splitHiraganaGroup(text string, start int) []Segment {
	if text == "" {
		return nil
	}
	segments := make([]Segment, 0, 4)
	remaining := text
	offset := 0
	for remaining != "" {
		if kind, affix, ok := matchAffixPrefix(remaining); ok && len(remaining) > len(affix) {
			segments = append(segments, makeSegment(affix, kind, start+offset))
			remaining = remaining[len(affix):]
			offset += len(affix)
			continue
		}
		if kind, ok := classifyExactAffix(remaining); ok {
			segments = append(segments, makeSegment(remaining, kind, start+offset))
		} else {
			segments = append(segments, makeSegment(remaining, kindContent, start+offset))
		}
		break
	}
	return segments
}

type scriptGroup struct {
	text  string
	start int
	kind  scriptKind
}

func splitByScript(text string, start int) []scriptGroup {
	groups := make([]scriptGroup, 0, 8)
	for i := 0; i < len(text); {
		r, size := utf8.DecodeRuneInString(text[i:])
		kind := runeScript(r)
		if kind == scriptOther || unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			i += size
			continue
		}
		j := i + size
		for j < len(text) {
			r2, s2 := utf8.DecodeRuneInString(text[j:])
			k2 := runeScript(r2)
			if k2 != kind {
				break
			}
			j += s2
		}
		groups = append(groups, scriptGroup{text: text[i:j], start: start + i, kind: kind})
		i = j
	}
	return groups
}

func mergeShortKana(groups []scriptGroup) []scriptGroup {
	if len(groups) <= 1 {
		return groups
	}
	out := make([]scriptGroup, 0, len(groups))
	for i := 0; i < len(groups); i++ {
		current := groups[i]
		if current.kind == scriptHan && i+1 < len(groups) && groups[i+1].kind == scriptHiragana && utf8.RuneCountInString(groups[i+1].text) <= 2 {
			if _, ok := classifyExactAffix(groups[i+1].text); ok {
				out = append(out, current)
				continue
			}
			out = append(out, scriptGroup{
				text:  current.text + groups[i+1].text,
				start: current.start,
				kind:  kanjiHiraMixed,
			})
			i++
			continue
		}
		out = append(out, current)
	}
	return out
}

func splitHanGroup(text string, start int) []Segment {
	if text == "" {
		return nil
	}
	segments := make([]Segment, 0, 4)
	remaining := text
	offset := 0
	for remaining != "" {
		if kind, matched, ok := matchContentPrefix(remaining); ok {
			segStart := start + offset
			segments = append(segments, Segment{Text: matched, Reading: matched, Lemma: matched, Kind: string(kind), Start: segStart, End: segStart + len(matched)})
			remaining = remaining[len(matched):]
			offset += len(matched)
			continue
		}
		prefix, bytesUsed := takeRunes(remaining, 2)
		if prefix == "" {
			break
		}
		segStart := start + offset
		segments = append(segments, makeSegment(prefix, kindContent, segStart))
		remaining = remaining[bytesUsed:]
		offset += bytesUsed
	}
	return segments
}

func matchAffixPrefix(text string) (tokenKind, string, bool) {
	for _, entry := range orderedAffixes {
		if strings.HasPrefix(text, entry.Text) {
			return entry.Kind, entry.Text, true
		}
	}
	return "", "", false
}

func matchAffixSuffix(text string) (tokenKind, string, bool) {
	for _, entry := range orderedAffixes {
		if strings.HasSuffix(text, entry.Text) {
			return entry.Kind, entry.Text, true
		}
	}
	return "", "", false
}

func classifyExactAffix(text string) (tokenKind, bool) {
	for _, entry := range orderedAffixes {
		if text == entry.Text {
			return entry.Kind, true
		}
	}
	return "", false
}

func matchContentPrefix(text string) (tokenKind, string, bool) {
	for _, term := range orderedContent {
		if strings.HasPrefix(text, term) {
			return kindContent, term, true
		}
	}
	return "", "", false
}

func makeSegment(text string, kind tokenKind, start int) Segment {
	return Segment{Text: text, Reading: text, Lemma: text, Kind: string(kind), Start: start, End: start + len(text)}
}

func takeRunes(text string, count int) (string, int) {
	if text == "" || count <= 0 {
		return "", 0
	}
	idx := 0
	for i := 0; i < count && idx < len(text); i++ {
		_, size := utf8.DecodeRuneInString(text[idx:])
		idx += size
	}
	if idx == 0 {
		return "", 0
	}
	return text[:idx], idx
}

func runeScript(r rune) scriptKind {
	switch {
	case unicode.In(r, unicode.Han):
		return scriptHan
	case unicode.In(r, unicode.Hiragana):
		return scriptHiragana
	case unicode.In(r, unicode.Katakana) || r == 'ー':
		return scriptKatakana
	case ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z') || ('0' <= r && r <= '9'):
		return scriptLatin
	default:
		return scriptOther
	}
}

func isJapaneseRune(r rune) bool {
	return unicode.In(r, unicode.Han) || unicode.In(r, unicode.Hiragana) || unicode.In(r, unicode.Katakana) || r == 'ー'
}

func isLatinWordRune(r rune) bool {
	return ('a' <= r && r <= 'z') || ('A' <= r && r <= 'Z') || ('0' <= r && r <= '9')
}
