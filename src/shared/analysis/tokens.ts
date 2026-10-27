/** Words with their positions in a piece of text. Same rule as the word counter. */
export interface Token {
  start: number
  end: number
  text: string
  /** Lowercase, with curly apostrophes made straight. */
  lower: string
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

export function tokenize(text: string, offset = 0): Token[] {
  const tokens: Token[] = []
  for (const m of text.matchAll(WORD)) {
    tokens.push({
      start: offset + m.index,
      end: offset + m.index + m[0].length,
      text: m[0],
      lower: m[0].toLowerCase().replace(/’/g, "'"),
    })
  }
  return tokens
}

/** True for tokens that are just numbers (not words to compare). */
export const isNumber = (token: Token) => /^\p{N}+$/u.test(token.text)
