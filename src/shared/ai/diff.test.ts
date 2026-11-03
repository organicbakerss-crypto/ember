import { describe, expect, it } from 'vitest'
import { applyChanges, diffText } from './diff'

describe('diffText', () => {
  it('finds spelling, punctuation and capital fixes', () => {
    const before = 'mara walked too the harbour , and sighed'
    const after = 'Mara walked to the harbour, and sighed.'
    const changes = diffText(before, after)
    expect(changes.map((c) => [c.before, c.after, c.kind])).toEqual([
      ['mara', 'Mara', 'fix'],
      ['too', 'to', 'fix'],
      [' ', '', 'fix'],
      ['', '.', 'fix'],
    ])
    expect(applyChanges(before, changes)).toBe(after)
  })

  it('marks swapped, added or dropped words as wording', () => {
    const changes = diffText('She walked slowly home.', 'She strolled home quietly.')
    expect(changes.every((c) => c.kind === 'wording')).toBe(true)
    expect(applyChanges('She walked slowly home.', changes)).toBe('She strolled home quietly.')
    expect(diffText('He ran fast.', 'He ran very fast.')[0]!.kind).toBe('wording')
    expect(diffText('a lot of alot', 'a lot of a lot')[0]!.kind).toBe('fix')
  })

  it('applies only the chosen changes', () => {
    const before = 'teh cat sat on teh mat'
    const changes = diffText(before, 'the cat sat on the mat')
    expect(changes).toHaveLength(2)
    expect(applyChanges(before, [changes[1]!])).toBe('teh cat sat on the mat')
    expect(diffText('same', 'same')).toEqual([])
  })
})
