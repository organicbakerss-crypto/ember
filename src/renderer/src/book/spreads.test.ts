import { describe, expect, it } from 'vitest'
import { lastSpread, leftOf, rightOf, turn } from './spreads'

describe('book spreads', () => {
  it('starts closed (cover on the right), then title page left and chapter 1 right', () => {
    expect([leftOf(-1), rightOf(-1)]).toEqual([null, 'cover'])
    expect([leftOf(0), rightOf(0)]).toEqual([0, 1])
    expect([leftOf(3), rightOf(3)]).toEqual([6, 7])
  })

  it('opening the cover turns it to show the title page on its back', () => {
    expect(turn(-1, 1)).toEqual({ left: null, right: 1, front: 'cover', back: 0 })
    // Turning forward from 0–1 to 2–3: page 1 turns over to reveal 2 on its back.
    expect(turn(0, 1)).toEqual({ left: 0, right: 3, front: 1, back: 2 })
    // And back again; turning back from the first spread closes the book.
    expect(turn(1, -1)).toEqual({ left: 0, right: 3, front: 2, back: 1 })
    expect(turn(0, -1)).toEqual({ left: null, right: 1, front: 0, back: 'cover' })
  })

  it('knows the last spread', () => {
    expect(lastSpread(1)).toBe(0)
    expect(lastSpread(2)).toBe(0)
    expect(lastSpread(3)).toBe(1)
    expect(lastSpread(10)).toBe(4)
  })
})
