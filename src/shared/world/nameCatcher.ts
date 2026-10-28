/**
 * The name catcher: capitalised words that keep coming up in the manuscript
 * but aren't in the world yet. Only certain signals count: a word must appear
 * at least three times, at least once in the middle of a sentence (so it isn't
 * just a sentence start), and never mostly in lower case. Suggestions go to
 * the inbox, never a popup.
 */
import { splitSentences } from '../analysis/sentences'

export interface NameSuggestion {
  name: string
  count: number
  /** Chapter (id) of the first time it appears mid-sentence. */
  chapterId: string
  /** The sentence it first appears in mid-sentence. */
  quote: string
}

export const MIN_NAME_COUNT = 3

/** Capitalised words that are not names. */
const NOT_NAMES = new Set(
  [
    'i',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
    'mr',
    'mrs',
    'ms',
    'miss',
    'dr',
    'sir',
    'madam',
    'lord',
    'lady',
    'king',
    'queen',
    'prince',
    'princess',
    'captain',
    'god',
    'oh',
    'ok',
    'okay',
    'chapter',
  ].map((w) => w.toLowerCase()),
)

const WORD = /[\p{L}][\p{L}\p{M}'’-]*/gu

interface Tally {
  name: string
  count: number
  midSentence: number
  first: { chapterId: string; quote: string } | null
}

/**
 * @param known words of names and aliases already in the world (any case)
 * @param ignore lower-case words that are never names (filler words) and rejected names
 */
export function catchNames(
  chapters: readonly { id: string; paragraphs: readonly string[] }[],
  known: Iterable<string>,
  ignore: Iterable<string>,
): NameSuggestion[] {
  const knownSet = new Set([...known].map((w) => w.toLowerCase()))
  const ignoreSet = new Set([...ignore].map((w) => w.toLowerCase()))
  const tallies = new Map<string, Tally>()
  const lower = new Map<string, number>()

  for (const chapter of chapters) {
    for (const paragraph of chapter.paragraphs) {
      for (const sentence of splitSentences(paragraph)) {
        const text = paragraph.slice(sentence.start, sentence.end)
        let firstWord = true
        for (const m of text.matchAll(WORD)) {
          const word = m[0].replace(/['’]s$/u, '').replace(/[-'’]+$/u, '')
          const atStart = firstWord
          firstWord = false
          if (word.length < 2) continue
          const key = word.toLowerCase()
          if (!/^\p{Lu}/u.test(word)) {
            lower.set(key, (lower.get(key) ?? 0) + 1)
            continue
          }
          if (word === word.toUpperCase()) continue // shouting or acronyms
          if (NOT_NAMES.has(key) || knownSet.has(key) || ignoreSet.has(key)) continue
          const tally = tallies.get(word) ?? { name: word, count: 0, midSentence: 0, first: null }
          tally.count++
          if (!atStart) {
            tally.midSentence++
            tally.first ??= { chapterId: chapter.id, quote: text.trim() }
          }
          tallies.set(word, tally)
        }
      }
    }
  }

  const order = new Map(chapters.map((c, i) => [c.id, i]))
  return [...tallies.values()]
    .filter(
      (t) =>
        t.count >= MIN_NAME_COUNT &&
        t.midSentence > 0 &&
        t.first &&
        (lower.get(t.name.toLowerCase()) ?? 0) < t.midSentence,
    )
    .map((t) => ({ name: t.name, count: t.count, ...t.first! }))
    .sort(
      (a, b) =>
        order.get(a.chapterId)! - order.get(b.chapterId)! ||
        b.count - a.count ||
        a.name.localeCompare(b.name),
    )
}
