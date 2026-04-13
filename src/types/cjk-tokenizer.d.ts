declare module "cjk-tokenizer" {
  interface TokenizeOptions {
    minFrequency?: number;
    maxPhraseLength?: number;
    filterSubString?: boolean;
  }

  interface TokenInfo {
    stem: string;
    minSize: number;
    maxSize: number;
    count: number;
    words: Record<string, number[]>;
  }

  export function tokenizeChinese(
    text: string,
    options?: TokenizeOptions
  ): Record<string, TokenInfo>;

  export function tokenizeEnglish(
    text: string,
    options?: TokenizeOptions
  ): Record<string, TokenInfo>;

  export function tokenizeJapanese(
    text: string,
    options?: TokenizeOptions
  ): Record<string, TokenInfo>;

  export function tokenize(
    text: string,
    options?: TokenizeOptions & { languages?: string[] }
  ): Record<string, TokenInfo>;
}
