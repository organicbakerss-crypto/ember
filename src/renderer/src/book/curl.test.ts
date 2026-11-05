import { describe, expect, it } from 'vitest'
import { curlShape, reachable } from './curl'

const W = 400
const H = 600
const apply = (m: number[], p: { x: number; y: number }) => ({
  x: m[0]! * p.x + m[2]! * p.y + m[4]!,
  y: m[1]! * p.x + m[3]! * p.y + m[5]!,
})
const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  expect(a.x).toBeCloseTo(b.x, 4)
  expect(a.y).toBeCloseTo(b.y, 4)
}

describe('page curl', () => {
  it('is flat until pulled', () => {
    expect(curlShape(1, W, H, { x: W, y: H }, { x: W, y: H })).toBeNull()
  })

  it('a corner pulled in folds the page; the back’s corner lands on the pointer', () => {
    const corner = { x: W, y: H }
    const to = { x: W - 200, y: H - 50 }
    const s = curlShape(1, W, H, corner, to)!
    expect(s.lifted.length).toBeGreaterThanOrEqual(3)
    // The back page's own bottom-left corner (0, H) is the sheet's corner (W, H) seen from behind:
    // it must be drawn at the pointer.
    close(apply(s.backMatrix, { x: 0, y: H }), to)
    // Points on the fold stay where they are.
    close(apply(s.backMatrix, { x: W - s.fold.x, y: s.fold.y }), s.fold)
  })

  it('a full turn lays the back flat on the left page', () => {
    const s = curlShape(1, W, H, { x: W, y: H }, { x: -W, y: H })!
    // Fold at the spine: the back page's box maps onto x −W…0 unmirrored.
    close(apply(s.backMatrix, { x: 0, y: 0 }), { x: -W, y: 0 })
    close(apply(s.backMatrix, { x: W, y: H }), { x: 0, y: H })
  })

  it('turning back lifts the left page and lands its back on the right', () => {
    const s = curlShape(-1, W, H, { x: -W, y: H }, { x: W, y: H })!
    close(apply(s.backMatrix, { x: 0, y: 0 }), { x: 0, y: 0 })
    close(apply(s.backMatrix, { x: W, y: H }), { x: W, y: H })
  })

  it('keeps the corner within reach of the spine', () => {
    const p = reachable({ x: -900, y: H }, { x: W, y: H }, W, H)
    expect(Math.hypot(p.x, p.y - H)).toBeCloseTo(W, 4)
  })
})
