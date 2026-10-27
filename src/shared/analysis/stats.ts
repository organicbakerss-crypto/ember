/**
 * Descriptive text statistics, computed locally. Not quality scores.
 * Input is a list of paragraphs (a line break inside one is written `\n`).
 */
import { dialogueRanges } from './dialogue'
import { splitSentences } from './sentences'
import { stem } from './stem'
import { isNumber, tokenize, type Token } from './tokens'

export const WORDS_PER_PAGE = 250
export const READING_WPM = 250
const VARIETY_WINDOW = 100

export interface TextStats {
  words: number
  /** Novel pages: words ÷ 250. */
  pages: number
  readingMinutes: number
  sentences: number
  avgSentenceWords: number
  longestSentenceWords: number
  paragraphs: number
  avgParagraphWords: number
  longestParagraphWords: number
  /** Share of words inside quotation marks, 0–100. */
  dialoguePercent: number
  /** Distinct words per 100 (moving average over 100-word windows), 0–100. */
  varietyPercent: number
  lyAdverbs: number
}

/** Words that end in -ly but are rarely -ly adverbs. */
const NOT_LY_ADVERBS = new Set([
  'only',
  'family',
  'early',
  'reply',
  'holy',
  'ugly',
  'belly',
  'ally',
  'apply',
  'supply',
  'rely',
  'fly',
  'july',
  'italy',
  'lily',
  'emily',
  'molly',
  'sally',
  'holly',
  'jelly',
  'bully',
  'folly',
  'silly',
  'lonely',
  'lovely',
  'friendly',
  'likely',
  'unlikely',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'elderly',
  'costly',
  'deadly',
  'lively',
  'orderly',
  'ghastly',
  'curly',
  'burly',
  'surly',
  'chilly',
  'hilly',
  'jolly',
  'smelly',
  'woolly',
  'wily',
  'oily',
  'only',
  'butterfly',
  'dragonfly',
  'firefly',
  'anomaly',
  'monopoly',
  'assembly',
  'homily',
  'rally',
  'tally',
  'gully',
])

export interface AnalysisWordOptions {
  /** Lowercase filler words to leave out. */
  fillers: ReadonlySet<string>
  /** Lowercase words from character and place names. */
  names: ReadonlySet<string>
  includeNames: boolean
}

export function isContentWord(token: Token, options: AnalysisWordOptions): boolean {
  const lower = token.lower.replace(/'s$/, '')
  if (lower.length < 2 || isNumber(token)) return false
  if (options.fillers.has(token.lower) || options.fillers.has(lower)) return false
  if (!options.includeNames && options.names.has(lower)) return false
  return true
}

export function computeStats(paragraphs: string[]): TextStats {
  let words = 0
  let sentences = 0
  let sentenceTotal = 0
  let longestSentence = 0
  let paragraphCount = 0
  let longestParagraph = 0
  let dialogueWords = 0
  let lyAdverbs = 0
  const all: string[] = []

  for (const text of paragraphs) {
    const tokens = tokenize(text)
    if (!tokens.length) continue
    paragraphCount++
    words += tokens.length
    longestParagraph = Math.max(longestParagraph, tokens.length)
    for (const s of splitSentences(text)) {
      const n = tokens.filter((t) => t.start >= s.start && t.start < s.end).length
      if (!n) continue
      sentences++
      sentenceTotal += n
      longestSentence = Math.max(longestSentence, n)
    }
    const speech = dialogueRanges(text)
    for (const t of tokens) {
      if (speech.some((r) => t.start >= r.start && t.start < r.end)) dialogueWords++
      if (t.lower.length >= 5 && t.lower.endsWith('ly') && !NOT_LY_ADVERBS.has(t.lower)) lyAdverbs++
      all.push(t.lower)
    }
  }

  return {
    words,
    pages: words / WORDS_PER_PAGE,
    readingMinutes: words / READING_WPM,
    sentences,
    avgSentenceWords: sentences ? sentenceTotal / sentences : 0,
    longestSentenceWords: longestSentence,
    paragraphs: paragraphCount,
    avgParagraphWords: paragraphCount ? words / paragraphCount : 0,
    longestParagraphWords: longestParagraph,
    dialoguePercent: words ? (dialogueWords / words) * 100 : 0,
    varietyPercent: variety(all),
    lyAdverbs,
  }
}

/** Moving-average type-token ratio, so long and short texts compare fairly. */
function variety(words: string[]): number {
  if (!words.length) return 0
  if (words.length <= VARIETY_WINDOW) return (new Set(words).size / words.length) * 100
  const counts = new Map<string, number>()
  const add = (w: string, d: number) => {
    const n = (counts.get(w) ?? 0) + d
    if (n) counts.set(w, n)
    else counts.delete(w)
  }
  for (let i = 0; i < VARIETY_WINDOW; i++) add(words[i]!, 1)
  let total = counts.size
  let windows = 1
  for (let i = VARIETY_WINDOW; i < words.length; i++) {
    add(words[i]!, 1)
    add(words[i - VARIETY_WINDOW]!, -1)
    total += counts.size
    windows++
  }
  return (total / windows / VARIETY_WINDOW) * 100
}

export interface RepeatedWord {
  /** The form used most often. */
  word: string
  stem: string
  count: number
}

/** The most-used content words (simple forms counted together). */
export function repeatedWords(
  paragraphs: string[],
  options: AnalysisWordOptions,
  limit = 20,
): RepeatedWord[] {
  const byStem = new Map<string, { count: number; forms: Map<string, number> }>()
  for (const text of paragraphs) {
    for (const t of tokenize(text)) {
      if (!isContentWord(t, options)) continue
      const key = stem(t.lower)
      const entry = byStem.get(key) ?? { count: 0, forms: new Map() }
      entry.count++
      entry.forms.set(t.lower, (entry.forms.get(t.lower) ?? 0) + 1)
      byStem.set(key, entry)
    }
  }
  return [...byStem.entries()]
    .filter(([, e]) => e.count > 1)
    .map(([key, e]) => ({
      stem: key,
      count: e.count,
      word: [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0]![0],
    }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, limit)
}
