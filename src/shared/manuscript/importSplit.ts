/**
 * Splitting an imported document into chapters. The document arrives as a
 * list of top-level pieces (headings and paragraphs); a chapter starts at a
 * heading, or at a line like "Chapter 3: The Storm" or "Prologue". The
 * writer sees the proposed splits and fixes them before anything is created.
 */

export interface ImportUnit {
  /** Lower-case tag: h1…h6, p, ul, ol, blockquote, hr, … */
  tag: string
  text: string
}

export type SplitMode = 'auto' | 'headings' | 'lines' | 'none'

export interface ImportStart {
  /** The piece the chapter starts at. */
  at: number
  title: string
  type: 'chapter' | 'interlude'
  /** The starting piece is the heading itself (it becomes the title, not text). */
  consumes: boolean
}

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred'
const CHAPTER_LINE = new RegExp(
  `^(?:chapter|ch\\.?)\\s+(?:\\d+|[ivxlcdm]+|(?:${NUMBER_WORDS})(?:[\\s-]+(?:${NUMBER_WORDS}))*)\\b\\s*[:.\\-–—]?\\s*(.*)$`,
  'i',
)
const SPECIAL_LINE = /^(prologue|epilogue|interlude|afterword|foreword)\b\s*[:.\-–—]?\s*(.*)$/i
const MAX_TITLE = 200

/** A line that starts a chapter, and the title it gives ("" when it's only a number). */
export function chapterLine(text: string): { title: string; type: ImportStart['type'] } | null {
  const t = text.trim()
  if (!t || t.length > 120) return null
  const chapter = CHAPTER_LINE.exec(t)
  if (chapter) return { title: chapter[1]!.trim().slice(0, MAX_TITLE), type: 'chapter' }
  const special = SPECIAL_LINE.exec(t)
  if (special) {
    const word = special[1]!.charAt(0).toUpperCase() + special[1]!.slice(1).toLowerCase()
    const type = word === 'Interlude' ? 'interlude' : 'chapter'
    const rest = special[2]!.trim()
    // An interlude is labelled "Interlude" already; others keep their word as the title.
    return {
      title: (type === 'interlude' ? rest : rest ? `${word}: ${rest}` : word).slice(0, MAX_TITLE),
      type,
    }
  }
  return null
}

/** A paragraph that is only a scene-break mark: "* * *", "#", "⁂", "~~~", "---". */
export function isSceneBreakLine(text: string): boolean {
  return /^\s*(?:[*#~⁂•·_=-]\s*){1,7}$/.test(text) && text.trim().length > 0
}

const isHeading = (u: ImportUnit) => /^h[1-6]$/.test(u.tag)

/** Where chapters start, by the chosen rule. */
export function proposeSplits(units: ImportUnit[], mode: SplitMode): ImportStart[] {
  const starts: ImportStart[] = []
  if (mode !== 'none') {
    // The top heading level used in the document marks chapters (usually Heading 1).
    const levels = units.filter(isHeading).map((u) => Number(u.tag[1]))
    const top = levels.length ? Math.min(...levels) : null
    units.forEach((u, at) => {
      if (!u.text.trim()) return
      const line = chapterLine(u.text)
      const heading = top !== null && u.tag === `h${top}`
      if ((mode === 'auto' || mode === 'lines') && line) {
        starts.push({ at, ...line, consumes: true })
      } else if ((mode === 'auto' || mode === 'headings') && heading) {
        // A heading that reads like "Chapter 1: Arrival" gives the same title as the line would.
        const named = line ?? { title: u.text.trim().slice(0, MAX_TITLE), type: 'chapter' as const }
        starts.push({ at, ...named, consumes: true })
      } else if (mode === 'headings' && line && isHeading(u)) {
        starts.push({ at, ...line, consumes: true })
      }
    })
  }
  // Whatever comes before the first chapter (a title page, notes) is its own piece.
  if (!starts.length || starts[0]!.at > 0) {
    starts.unshift({ at: 0, title: '', type: 'chapter', consumes: false })
  }
  return starts
}

/** Counts words (as the app does) in some pieces. */
export function unitsWords(units: ImportUnit[]): number {
  return units.reduce(
    (n, u) => n + (u.text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0),
    0,
  )
}

/** The pieces a chapter holds: from its start (after its heading) to the next chapter. */
export function chapterUnits(
  units: ImportUnit[],
  starts: ImportStart[],
  index: number,
): ImportUnit[] {
  const s = starts[index]!
  const end = starts[index + 1]?.at ?? units.length
  return units.slice(s.at + (s.consumes ? 1 : 0), end)
}
