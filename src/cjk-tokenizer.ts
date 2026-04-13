import { tokenize } from "kuromojin";
import type { DetectedLanguage } from "./lang-detect";

// cjk-tokenizer is CJS-only — use dynamic require to avoid ESM import issues
let _cjkTokenizer: typeof import("cjk-tokenizer") | null = null;
function getCjkTokenizer(): typeof import("cjk-tokenizer") | null {
  if (!_cjkTokenizer) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      _cjkTokenizer = require("cjk-tokenizer");
    } catch {
      _cjkTokenizer = null;
    }
  }
  return _cjkTokenizer;
}

export interface CjkTokenizeResult {
  keywords: string[];
  lang: DetectedLanguage;
}

const JA_CONTENT_POS = new Set(["名詞", "動詞", "形容詞", "副詞"]);

/**
 * 日本語形態素解析。
 * kuromojin は初回呼び出し時に辞書をロードする（async, ~100ms）。
 * 2回目以降は内部キャッシュで同期並みに高速。
 */
async function tokenizeJapanese(text: string): Promise<string[]> {
  const tokens = await tokenize(text);
  return tokens
    .filter((t) => JA_CONTENT_POS.has(t.pos))
    .map((t) => t.surface_form);
}

/**
 * 中国語トークナイズ — cjk-tokenizer の tokenizeChinese を使用。
 * bigram（2文字）抽出で検索に最適なtermを返す。
 * minFrequency=1 で1回しか出現しない単語も含む（クエリ用途）。
 */
function tokenizeChinese(text: string): string[] {
  const ct = getCjkTokenizer();
  if (!ct) {
    // Fallback: simple regex bigram
    const cjkChars = text.match(/[\p{Script=Han}]/gu) || [];
    return bigramFromChars(cjkChars);
  }

  const result = ct.tokenizeChinese(text, {
    minFrequency: 1,
    maxPhraseLength: 2,
    filterSubString: false,
  });

  // result is { [term: string]: { word, count, ... } }
  // Extract term keys, filter 1-char noise
  return Object.keys(result).filter((t) => t.length >= 2);
}

/**
 * 韓国語トークナイザ — Hangul bigram（2文字スライディングウィンドウ）。
 * cjk-tokenizer は韓国語に対応していないため、
 * Hangul文字を2文字ずつ切り出すヒューリスティックを使用。
 */
function tokenizeKorean(text: string): string[] {
  const hangulChars = text.match(/[\p{Script=Hangul}]/gu) || [];
  return bigramFromChars(hangulChars);
}

/**
 * 文字配列から2文字スライディングウィンドウでbigramを生成。
 * 例: ['한', '국', '어'] → ['한국', '국어']
 */
function bigramFromChars(chars: string[]): string[] {
  if (chars.length < 2) return [];
  const bigrams = new Set<string>();
  for (let i = 0; i <= chars.length - 2; i++) {
    bigrams.add(chars[i] + chars[i + 1]);
  }
  return Array.from(bigrams);
}

/**
 * CJK テキストを言語に応じてトークナイズ。
 * - JA: kuromojin (形態素解析 + POSフィルタ)
 * - ZH: cjk-tokenizer (bigram抽出)
 * - KO: Hangul bigram (2文字スライディングウィンドウ)
 */
export async function tokenizeCjk(
  text: string,
  lang: DetectedLanguage
): Promise<CjkTokenizeResult> {
  if (lang === "ja") {
    const keywords = await tokenizeJapanese(text);
    return { keywords, lang };
  }

  if (lang === "zh") {
    const keywords = tokenizeChinese(text);
    return { keywords, lang };
  }

  if (lang === "ko") {
    const keywords = tokenizeKorean(text);
    return { keywords, lang };
  }

  // Fallback: regex for unknown CJK
  const cjkMatches =
    text.match(
      /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hiragana}\p{Script=Hangul}]{2,}/gu
    ) || [];
  return { keywords: cjkMatches, lang };
}
