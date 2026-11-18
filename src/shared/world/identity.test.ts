import { describe, expect, it } from 'vitest'
import { entryTerms, nameMatcher } from '../names'
import { foldsAt, identityLines, shownNames } from './identity'

const PETE = 'ent_pete000000000000'
const JOSH = 'ent_josh000000000000'
const RODNEY = 'ent_rodney0000000000'
const MASK = 'ent_mask000000000000'
const KING = 'ent_king000000000000'
const ch = (id: string) => ({ kind: 'chapter' as const, chapterId: id })
const positions = new Map([
  ['chp_1', 0],
  ['chp_5', 4],
  ['chp_9', 8],
])

const entries = [
  {
    id: PETE,
    name: 'Uncle Pete',
    aliases: [],
    names: [
      { id: 'n1', name: 'Dad', usedBy: [JOSH], kind: 'nickname' as const, from: null },
      { id: 'n2', name: 'Pete', usedBy: [], kind: 'nickname' as const, from: null },
    ],
    // The masked man is Pete, revealed in chapter 5; Pete becomes the King in chapter 9.
    identities: [
      { kind: 'same' as const, entryId: MASK, at: ch('chp_5') },
      { kind: 'becomes' as const, entryId: KING, at: ch('chp_9') },
    ],
  },
  { id: JOSH, name: 'Josh', aliases: [] },
  { id: RODNEY, name: 'Rodney', aliases: [] },
  { id: MASK, name: 'The Masked Man', aliases: [] },
  { id: KING, name: 'The King', aliases: [] },
]

describe('names only some people use', () => {
  it('“Dad” means Uncle Pete only where Josh is (narrating or in the scene)', () => {
    const text = 'Dad poured the coffee. Pete was late.'
    const everywhere = nameMatcher(entryTerms(entries)).find(text)
    expect(everywhere.map((m) => text.slice(m.start, m.end))).toEqual(['Pete'])
    const joshHere = nameMatcher(entryTerms(entries, new Set([JOSH]))).find(text)
    expect(joshHere.map((m) => [text.slice(m.start, m.end), m.entryId])).toEqual([
      ['Dad', PETE],
      ['Pete', PETE],
    ])
    expect(nameMatcher(entryTerms(entries, new Set([RODNEY]))).find('Dad')).toEqual([])
  })
})

describe('who someone is over the story', () => {
  it('two entries are two people until it’s revealed, then one', () => {
    expect(foldsAt(entries, 0, positions).has(MASK)).toBe(false)
    expect(foldsAt(entries, 4, positions).get(MASK)).toBe(PETE)
    expect(shownNames(PETE, entries, foldsAt(entries, 4, positions))).toEqual([
      'Uncle Pete',
      'The Masked Man',
    ])
  })

  it('someone who becomes someone else shows as them from then on (chains followed)', () => {
    const later = foldsAt(entries, 8, positions)
    expect(later.get(PETE)).toBe(KING)
    // The mask was Pete, and Pete is now the King.
    expect(later.get(MASK)).toBe(KING)
    // "Now" (no moment) is the end of the story.
    expect(foldsAt(entries, null, positions).get(PETE)).toBe(KING)
  })

  it('says it in words for the AI', () => {
    const when = (a: { kind: string; chapterId?: string } | null) =>
      a?.kind === 'chapter' ? `Ch ${a.chapterId!.slice(4)}` : null
    const lines = identityLines(entries[0]!, entries, when as never)
    expect(lines).toEqual([
      'Other names: Dad (what Josh calls them); Pete',
      'Same person as The Masked Man (revealed in Ch 5; before that they seem to be two people)',
      'Becomes The King (from Ch 9)',
    ])
    expect(identityLines(entries[4]!, entries, when as never)).toEqual([
      'Was Uncle Pete (until Ch 9)',
    ])
  })
})
