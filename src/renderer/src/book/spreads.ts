/**
 * Book mode's spreads. Page 0 is the title page, then the chapters. Spread
 * -1 is the closed book (only the cover, on the right); spread s ≥ 0 shows
 * page 2s on the left and 2s+1 on the right, so opening the cover shows the
 * title page on the left and Chapter 1 on the right.
 */
export type Face = number | 'cover' | null

export const leftOf = (s: number): Face => (s < 0 ? null : 2 * s)
export const rightOf = (s: number): Face => (s < 0 ? 'cover' : 2 * s + 1)

/** The last spread with a page on it. */
export const lastSpread = (pages: number) => Math.max(0, Math.floor((pages - 1) / 2))

/** What a turn shows: the pages that stay put, and the leaf that turns (its two sides). */
export function turn(s: number, dir: 1 | -1): { left: Face; right: Face; front: Face; back: Face } {
  return dir === 1
    ? { left: leftOf(s), right: rightOf(s + 1), front: rightOf(s), back: leftOf(s + 1) }
    : { left: leftOf(s - 1), right: rightOf(s), front: leftOf(s), back: rightOf(s - 1) }
}
