/**
 * Splits fiction into sentences. Handles:
 * - dialogue: `"Where?" she asked.` stays one sentence (the tag continues it),
 *   while `He said, "Go." Then he left.` is two;
 * - `?` and `!` inside quotes, and runs like `?!` or `!!`;
 * - ellipses (`...` or `…`): a break only if the next word starts a sentence;
 * - em dashes, which never end a sentence;
 * - abbreviations (Mr., Dr., St., e.g.) and initials (J. R. Tolkien).
 * A line break or a paragraph end always ends a sentence.
 */
export interface Range {
  start: number
  end: number
}

const TERMINATORS = '.!?…'
const CLOSERS = `"'”’»)]`
const OPENERS = `"'“‘«([`
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'mx',
  'dr',
  'st',
  'mt',
  'jr',
  'sr',
  'prof',
  'rev',
  'hon',
  'capt',
  'lt',
  'col',
  'gen',
  'sgt',
  'cpl',
  'maj',
  'adm',
  'cmdr',
  'fr',
  'vs',
  'etc',
  'no',
  'vol',
  'ch',
  'fig',
  'approx',
  'dept',
  'inc',
  'ltd',
  'co',
  'ave',
  'blvd',
  'rd',
])

export function splitSentences(text: string): Range[] {
  const ranges: Range[] = []
  let start = 0
  const push = (end: number) => {
    let s = start
    while (s < end && /\s/.test(text[s]!)) s++
    let e = end
    while (e > s && /\s/.test(text[e - 1]!)) e--
    if (e > s && /[\p{L}\p{N}]/u.test(text.slice(s, e))) ranges.push({ start: s, end: e })
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '\n') {
      push(i)
      start = i + 1
      continue
    }
    if (!TERMINATORS.includes(c)) continue

    let j = i
    while (j < text.length && TERMINATORS.includes(text[j]!)) j++
    const run = text.slice(i, j)
    while (j < text.length && CLOSERS.includes(text[j]!)) j++

    if (run === '.' && isAbbreviation(text, i)) {
      i = j - 1
      continue
    }
    if (j >= text.length) break
    if (!/\s/.test(text[j]!)) {
      i = j - 1 // e.g. "3.14", "e.g.x", "...and"
      continue
    }
    let k = j
    while (k < text.length && text[k] === ' ') k++
    const next = text[k]
    // A lowercase word after the punctuation continues the sentence
    // (a dialogue tag, or an ellipsis in the middle of a thought).
    if (next !== undefined && next !== '\n' && /\p{Ll}/u.test(next)) {
      i = j - 1
      continue
    }
    if (
      next === undefined ||
      next === '\n' ||
      /[\p{Lu}\p{N}]/u.test(next) ||
      OPENERS.includes(next) ||
      next === '—' ||
      next === '-'
    ) {
      push(j)
      start = j
    }
    i = j - 1
  }
  push(text.length)
  return ranges
}

function isAbbreviation(text: string, dot: number): boolean {
  let s = dot
  while (s > 0 && /[\p{L}.]/u.test(text[s - 1]!)) s--
  const word = text.slice(s, dot).toLowerCase()
  if (ABBREVIATIONS.has(word)) return true
  if (/^(?:[a-z]\.)+[a-z]$/.test(word)) return true // e.g, i.e, a.m
  // A single capital letter is an initial (J. R. Tolkien), unless it's the pronoun I.
  return word.length === 1 && /\p{Lu}/u.test(text[s]!) && text[s] !== 'I'
}
