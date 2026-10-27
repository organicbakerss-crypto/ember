/**
 * Where page breaks go. Given the lines of a chapter as laid out on one long
 * sheet (tops and bottoms, measured from the top of the first page's text
 * area), decide which lines start a new page and how much space to put
 * before each so it lands at the top of the next sheet.
 */
export interface Line {
  top: number
  bottom: number
}

export interface PageGeometry {
  /** Height of the text area of one page (paper height minus top and bottom margins). */
  contentHeight: number
  /** Distance from the top of one page's text area to the next (paper height plus the gap). */
  pitch: number
}

export interface PageBreak {
  /** Index of the line that starts the new page. */
  line: number
  /** Space to insert before it. */
  space: number
}

export function planPageBreaks(
  lines: Line[],
  geometry: PageGeometry,
): { breaks: PageBreak[]; pages: number } {
  const { contentHeight, pitch } = geometry
  const breaks: PageBreak[] = []
  let page = 0
  let shift = 0
  lines.forEach((line, index) => {
    const top = line.top + shift
    const bottom = line.bottom + shift
    const pageEnd = page * pitch + contentHeight
    // A line that would cross the bottom of the text area moves to the next page.
    // (A line taller than a whole page stays put rather than looping.)
    if (bottom > pageEnd + 0.5 && top > page * pitch + 0.5) {
      const nextTop = (page + 1) * pitch
      const space = nextTop - top
      breaks.push({ line: index, space })
      shift += space
      page++
      // Very tall content (taller than a page) can still spill; keep counting pages.
      while (
        line.bottom + shift > page * pitch + contentHeight + 0.5 &&
        line.top + shift > page * pitch
      )
        page++
    } else if (top >= pageEnd) {
      page = Math.floor(top / pitch)
    }
  })
  return { breaks, pages: page + 1 }
}
