import { describe, expect, it } from 'vitest'
import { planPageBreaks, type Line } from './pageBreaks'

// Lines of 30px, one after another.
const lines = (n: number, height = 30, start = 0): Line[] =>
  Array.from({ length: n }, (_, i) => ({
    top: start + i * height,
    bottom: start + (i + 1) * height,
  }))

const geometry = { contentHeight: 100, pitch: 200 } // text area 100px; next page's text starts 200px lower

describe('planPageBreaks', () => {
  it('keeps short text on one page', () => {
    expect(planPageBreaks(lines(3), geometry)).toEqual({ breaks: [], pages: 1 })
  })

  it('moves the first line that would cross the bottom to the next page', () => {
    // Lines end at 30, 60, 90, 120: the fourth crosses 100, so it starts page 2 at 200.
    const { breaks, pages } = planPageBreaks(lines(4), geometry)
    expect(breaks).toEqual([{ line: 3, space: 110 }])
    expect(pages).toBe(2)
  })

  it('keeps breaking page after page', () => {
    // Three lines fit per page: 10 lines need 4 pages, breaking before lines 3, 6 and 9.
    const { breaks, pages } = planPageBreaks(lines(10), geometry)
    expect(breaks.map((b) => b.line)).toEqual([3, 6, 9])
    expect(pages).toBe(4)
    // Every moved line lands exactly at the top of its page's text area.
    let shift = 0
    const tops = lines(10).map((l, i) => {
      const b = breaks.find((x) => x.line === i)
      if (b) shift += b.space
      return l.top + shift
    })
    expect(tops[3]).toBe(200)
    expect(tops[6]).toBe(400)
    expect(tops[9]).toBe(600)
  })

  it('accounts for a heading above the first line', () => {
    const { breaks } = planPageBreaks(lines(3, 30, 50), geometry) // 50px title, then lines
    expect(breaks).toEqual([{ line: 1, space: 120 }]) // the second line (80–110) crosses 100
  })

  it('does not loop on a line taller than a page', () => {
    const { breaks, pages } = planPageBreaks([{ top: 0, bottom: 250 }], geometry)
    expect(breaks).toEqual([])
    expect(pages).toBeGreaterThanOrEqual(1)
  })

  it('handles no lines', () => {
    expect(planPageBreaks([], geometry)).toEqual({ breaks: [], pages: 1 })
  })
})
