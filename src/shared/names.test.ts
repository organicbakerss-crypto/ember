import { describe, expect, it } from 'vitest'
import { entryTerms, nameMatcher } from './names'

const matcher = nameMatcher(
  entryTerms([
    { id: 'mara', name: 'Mara Voss', aliases: ['Mara', 'the Captain'] },
    { id: 'rose', name: 'Rose', aliases: [] },
    { id: 'isles', name: 'Shattered Isles', aliases: [] },
  ]),
)
const found = (text: string) =>
  matcher.find(text).map((m) => `${m.entryId}:${text.slice(m.start, m.end)}`)

describe('nameMatcher', () => {
  it('finds names and aliases as whole words, preferring the longest', () => {
    expect(found('Mara Voss met Mara and the Captain.')).toEqual([
      'mara:Mara Voss',
      'mara:Mara',
      'mara:the Captain',
    ])
  })

  it('is case-sensitive, so ordinary words are not names', () => {
    expect(found('A rose by the door. Rose smiled.')).toEqual(['rose:Rose'])
  })

  it('counts possessives but not longer words', () => {
    expect(found("Mara's boat. Marabou. Rosewood. Mara’s oar.")).toEqual(['mara:Mara', 'mara:Mara'])
  })

  it('never matches inside hyphenated words', () => {
    expect(found('Mara-blue sails. A half-Mara child. Rose‐tinted. Mara - then Rose.')).toEqual([
      'mara:Mara',
      'rose:Rose',
    ])
  })

  it('still matches names that contain a hyphen', () => {
    const m = nameMatcher([{ entryId: 'sc', term: 'Saint-Clair' }])
    expect(m.find('Saint-Clair and Saint-Clair-on-Sea').length).toBe(1)
  })

  it('matches multi-word names across line wrapping and odd spacing', () => {
    expect(found('the  Shattered\nIsles')).toEqual(['isles:Shattered\nIsles'])
  })

  it('treats special characters in names literally', () => {
    const m = nameMatcher([{ entryId: 'x', term: 'K. (Kay)' }])
    expect(m.find('Then K. (Kay) left').length).toBe(1)
  })

  it('ignores one-letter terms and works with no entries', () => {
    expect(nameMatcher([{ entryId: 'a', term: 'A' }]).find('A cat')).toEqual([])
    expect(nameMatcher([]).find('anything')).toEqual([])
  })
})
