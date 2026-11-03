/**
 * What changed between a paragraph and the AI's cleaned-up version. The app
 * works this out itself, so every change is shown, including any the AI
 * wasn't asked to make.
 *
 * A change is a span of the original replaced by new text. Spelling,
 * punctuation, spacing and capitals are `fix`es. Anything that swaps,
 * adds or drops a word is `wording`: the AI shouldn't do that, so those
 * start unticked.
 */
export interface TextChange {
  /** Offsets into the original paragraph. */
  start: number
  end: number
  before: string
  after: string
  kind: 'fix' | 'wording'
}

/** Words, runs of spaces, and single punctuation marks. */
export function tokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\s+|[^\p{L}\p{N}\s]/gu) ?? []
}

const MAX_CELLS = 400_000

/** The changes that turn `before` into `after` (empty when they're the same). */
export function diffText(before: string, after: string): TextChange[] {
  if (before === after) return []
  const a = tokens(before)
  const b = tokens(after)
  // Common start and end trimmed, then a longest-common-subsequence on the middle.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)
  const ops: { a: string[]; b: string[]; same: boolean }[] = []
  if (am.length * bm.length > MAX_CELLS) {
    ops.push({ a: am, b: bm, same: false })
  } else {
    const n = am.length
    const m = bm.length
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i]![j] =
          am[i] === bm[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    let i = 0
    let j = 0
    const push = (x: string[], y: string[], same: boolean) => {
      const last = ops[ops.length - 1]
      if (last && last.same === same) {
        last.a.push(...x)
        last.b.push(...y)
      } else ops.push({ a: [...x], b: [...y], same })
    }
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        push([am[i]!], [bm[j]!], true)
        i++
        j++
      } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
        push([], [bm[j]!], false)
        j++
      } else {
        push([am[i]!], [], false)
        i++
      }
    }
  }

  const changes: TextChange[] = []
  let offset = a.slice(0, head).join('').length
  for (const op of ops) {
    const x = op.a.join('')
    if (!op.same) {
      const y = op.b.join('')
      changes.push({
        start: offset,
        end: offset + x.length,
        before: x,
        after: y,
        kind: kindOf(x, y),
      })
    }
    offset += x.length
  }
  return changes
}

const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
const wordsOf = (s: string) => s.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []

/** Spelling, punctuation, spacing and capitals are fixes; other word changes are wording. */
function kindOf(before: string, after: string): TextChange['kind'] {
  const wa = wordsOf(before)
  const wb = wordsOf(after)
  if (wa.length !== wb.length) {
    // Splitting or joining a word ("alot" → "a lot") is spelling.
    return letters(before) === letters(after) ? 'fix' : 'wording'
  }
  for (let k = 0; k < wa.length; k++) {
    const x = wa[k]!.toLowerCase()
    const y = wb[k]!.toLowerCase()
    if (x === y) continue
    // A misspelling is close to the right word.
    if (editDistance(x, y) > Math.max(2, Math.floor(Math.max(x.length, y.length) / 3)))
      return 'wording'
  }
  return 'fix'
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = temp
    }
  }
  return row[b.length]!
}

/** Applies the chosen changes to a paragraph. */
export function applyChanges(text: string, changes: TextChange[]): string {
  let out = ''
  let at = 0
  for (const c of [...changes].sort((x, y) => x.start - y.start)) {
    out += text.slice(at, c.start) + c.after
    at = c.end
  }
  return out + text.slice(at)
}
