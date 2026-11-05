/**
 * Before the AI answers a question that isn't about text the writer pointed
 * at, it looks things up: the chapter summaries that touch the question, the
 * world entries it names, and passages of the story that mention them. So it
 * never answers blind.
 */

export interface LookupChapter {
  /** "Chapter 3", "Test scene", with the book's name when there are several. */
  label: string
  title: string
  paragraphs: string[]
  summary: string | null
}

const STOP = new Set(
  `about above after again against also among another anything around because been before being
  below between both could does doing done down during each else ever every from further have
  having here hers herself himself into itself just know like make many might more most much must
  never only other ought ours over same shall should some such than that their theirs them then
  there these they this those though through under until very want were what when where which
  while whom whose will with would your yours yourself chapter chapters story scene scenes book
  happen happens happened tell think thing things write writing wrote said says does doesn didn
  isn wasn aren weren`.split(/\s+/),
)

/** The words worth searching for: names (capitalised) and longer words, lower-cased. */
export function searchTerms(question: string, names: string[] = []): string[] {
  const found = new Set<string>()
  const lower = question.toLowerCase()
  for (const name of names)
    if (name.length > 1 && lower.includes(name.toLowerCase())) found.add(name.toLowerCase())
  for (const word of question.match(/[\p{L}][\p{L}'’-]*/gu) ?? []) {
    let w = word.toLowerCase().replace(/['’]s$/, '')
    if (STOP.has(w)) continue
    // Short words only when capitalised (names: "Odo"); longer ones by their stem.
    if (w.length < 4 && !(w.length >= 2 && /^\p{Lu}/u.test(word))) continue
    if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3)
    else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2)
    else if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
    found.add(w)
  }
  return [...found].slice(0, 20)
}

const hits = (text: string, terms: string[]) => {
  const t = text.toLowerCase()
  let n = 0
  for (const term of terms) if (t.includes(term)) n += term.includes(' ') ? 3 : 1
  return n
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Summaries that touch the question, in story order. */
export function pickSummaries(chapters: LookupChapter[], terms: string[], max = 12): string[] {
  const scored = chapters
    .map((c, i) => ({ c, i, score: c.summary ? hits(`${c.title} ${c.summary}`, terms) : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
  return scored.map(({ c }) => `${c.label} “${c.title || 'Untitled'}”: ${c.summary}`)
}

/** The paragraphs that mention the question's terms most, in story order. */
export function findPassages(
  chapters: LookupChapter[],
  terms: string[],
  max = 8,
  maxChars = 700,
): string[] {
  if (!terms.length) return []
  const all: { label: string; text: string; score: number; order: number }[] = []
  let order = 0
  for (const c of chapters) {
    for (const p of c.paragraphs) {
      order++
      const score = hits(p, terms)
      if (score) all.push({ label: `${c.label} “${c.title || 'Untitled'}”`, text: p, score, order })
    }
  }
  return all
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, max)
    .sort((a, b) => a.order - b.order)
    .map((x) => `(${x.label}) ${clip(x.text, maxChars)}`)
}

/** The story cut into parts of about `words` words, each starting with its chapter's label. */
export function storyParts(chapters: LookupChapter[], words: number): string[] {
  const parts: string[] = []
  let current: string[] = []
  let count = 0
  const push = () => {
    if (current.length) parts.push(current.join('\n\n'))
    current = []
    count = 0
  }
  for (const c of chapters) {
    current.push(`## ${c.label} “${c.title || 'Untitled'}”`)
    for (const p of c.paragraphs) {
      const n = p.split(/\s+/).filter(Boolean).length
      if (count + n > words && count > 0) {
        push()
        current.push(`## ${c.label} “${c.title || 'Untitled'}” (continued)`)
      }
      current.push(p)
      count += n
    }
  }
  push()
  return parts
}
