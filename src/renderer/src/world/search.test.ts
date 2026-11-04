import { describe, expect, it } from 'vitest'
import type { EntrySummary } from '@shared/ipc'
import { searchEntries } from './search'

const entry = (name: string, extra: Partial<EntrySummary> = {}): EntrySummary => ({
  id: `ent_${name.toLowerCase().replace(/\W/g, '').padEnd(16, '0').slice(0, 16)}`,
  name,
  aliases: [],
  template: 'person',
  facts: {},
  snippet: '',
  portrait: null,
  tags: [],
  pictures: 0,
  mergedFrom: [],
  links: [],
  when: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

const world = [
  entry('Mara Voss', { tags: ['noble houses'], aliases: ['the Fox'] }),
  entry('Odo', { snippet: 'A boatman who knows Mara from childhood.' }),
  entry('Saltmere', {
    template: 'place',
    facts: { climate: [{ id: 'fct_0000000000000001', text: 'Cold and wet', from: null }] },
  }),
  entry('House Voss', { tags: ['Noble houses', 'dead'] }),
  entry('Amara'),
]

describe('world search', () => {
  it('ranks names first, then other names, tags, facts and page text', () => {
    expect(searchEntries(world, 'mara').map((m) => m.entry.name)).toEqual([
      'Mara Voss',
      'Amara',
      'Odo',
    ])
    expect(searchEntries(world, 'voss').map((m) => m.entry.name)).toEqual([
      'House Voss',
      'Mara Voss',
    ])
    expect(searchEntries(world, 'fox')[0]).toMatchObject({ why: 'also called the Fox' })
    expect(searchEntries(world, 'cold')[0]).toMatchObject({ entry: { name: 'Saltmere' } })
    expect(searchEntries(world, 'childhood')[0]!.why).toContain('childhood')
    expect(searchEntries(world, '  ')).toEqual([])
  })

  it('lists everything with a tag for #tag (any case)', () => {
    expect(searchEntries(world, '#noble houses').map((m) => m.entry.name)).toEqual([
      'House Voss',
      'Mara Voss',
    ])
    expect(searchEntries(world, '#dead').map((m) => m.entry.name)).toEqual(['House Voss'])
    expect(searchEntries(world, '#').length).toBe(2)
  })
})
