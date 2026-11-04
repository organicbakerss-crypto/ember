import { describe, expect, it } from 'vitest'
import { canMerge, mergeFile } from './merge'

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>
const VOL = 'series/s1/volumes/v1'
const WORLD = 'worlds/w1'
const from = { device: 'Laptop' }

const outline = (items: unknown[]) => ({ formatVersion: 1, volumeId: 'v1', items })
const ch = (id: string) => ({ type: 'chapter', id })
const arc = (id: string, chapterIds: string[], name = 'Arc') => ({
  type: 'arc',
  id,
  name,
  finished: false,
  chapterIds,
})

function merge(unit: string, rel: string, b: unknown, m: unknown, t: unknown) {
  const r = mergeFile(unit, rel, b === null ? null : enc(b), enc(m), enc(t), from)
  if (!r) throw new Error('not merged')
  return { value: dec(r.bytes), clean: r.clean, copy: r.copy }
}

describe('merging a file changed on both computers', () => {
  it('leaves chapters, entries and images to the copy rules', () => {
    expect(canMerge(VOL, 'chapters/c1.json')).toBe(false)
    expect(canMerge(WORLD, 'entries/e1.json')).toBe(false)
    expect(canMerge(WORLD, 'images/abc.png')).toBe(false)
    expect(canMerge(VOL, 'outline.json')).toBe(true)
    expect(canMerge('series/s1', 'ai/cnv_1.json')).toBe(true)
  })

  it('outline: a reorder here and a new chapter there are both kept', () => {
    const base = outline([ch('a'), ch('b'), ch('c')])
    const mine = outline([ch('c'), ch('a'), ch('b')])
    const theirs = outline([ch('a'), ch('b'), ch('d'), ch('c')])
    const { value, clean } = merge(VOL, 'outline.json', base, mine, theirs)
    expect((value['items'] as { id: string }[]).map((i) => i.id)).toEqual(['c', 'a', 'b', 'd'])
    expect(clean).toBe(true)
  })

  it('outline: the side that reordered sets the order', () => {
    const base = outline([ch('a'), ch('b'), ch('c')])
    const mine = outline([ch('a'), ch('b'), ch('c'), ch('x')])
    const theirs = outline([ch('b'), ch('a'), ch('c')])
    const { value } = merge(VOL, 'outline.json', base, mine, theirs)
    expect((value['items'] as { id: string }[]).map((i) => i.id)).toEqual(['b', 'a', 'c', 'x'])
  })

  it('outline: a chapter moved into an arc there, another removed here', () => {
    const base = outline([ch('a'), ch('b'), arc('arc1', ['c'])])
    const mine = outline([ch('a'), arc('arc1', ['c'])]) // b deleted here
    const theirs = outline([ch('b'), arc('arc1', ['c', 'a'], 'Renamed')]) // a moved into the arc
    const { value, clean } = merge(VOL, 'outline.json', base, mine, theirs)
    expect(value['items']).toEqual([arc('arc1', ['c', 'a'], 'Renamed')])
    expect(clean).toBe(true)
  })

  it('outline: a chapter moved to two places is listed once', () => {
    const base = outline([ch('a'), arc('x', []), arc('y', [])])
    const mine = outline([arc('x', ['a']), arc('y', [])])
    const theirs = outline([arc('x', []), arc('y', ['a'])])
    const { value } = merge(VOL, 'outline.json', base, mine, theirs)
    const all = JSON.stringify(value).match(/"a"/g) ?? []
    expect(all).toHaveLength(1)
  })

  it('board: portraits moved on each side are both kept', () => {
    const board = (positions: Record<string, { x: number; y: number }>, updatedAt: string) => ({
      formatVersion: 1,
      worldId: 'w1',
      positions,
      updatedAt,
    })
    const base = board({ e1: { x: 0, y: 0 }, e2: { x: 0, y: 0 } }, '2026-01-01')
    const mine = board({ e1: { x: 0.5, y: 0.5 }, e2: { x: 0, y: 0 } }, '2026-01-02')
    const theirs = board(
      { e1: { x: 0, y: 0 }, e2: { x: 0.2, y: 0.2 }, e3: { x: 1, y: 1 } },
      '2026-01-03',
    )
    const { value, clean } = merge(WORLD, 'board.json', base, mine, theirs)
    expect(value['positions']).toEqual({
      e1: { x: 0.5, y: 0.5 },
      e2: { x: 0.2, y: 0.2 },
      e3: { x: 1, y: 1 },
    })
    expect(value['updatedAt']).toBe('2026-01-03')
    expect(clean).toBe(true)
  })

  it('the same value changed differently keeps this one and says so', () => {
    const base = { formatVersion: 1, id: 'm1', name: 'Map', regions: [{ id: 'r1', fill: 'red' }] }
    const mine = { ...base, regions: [{ id: 'r1', fill: 'blue' }] }
    const theirs = { ...base, name: 'World', regions: [{ id: 'r1', fill: 'green' }, { id: 'r2' }] }
    const { value, clean } = merge(WORLD, 'maps/m1.json', base, mine, theirs)
    expect(value['name']).toBe('World')
    expect(value['regions']).toEqual([{ id: 'r1', fill: 'blue' }, { id: 'r2' }])
    expect(clean).toBe(false)
  })

  it('without the agreed version nothing counts as removed', () => {
    const mine = { formatVersion: 1, names: ['a', 'b'] }
    const theirs = { formatVersion: 1, names: ['a', 'c'] }
    const { value } = merge(WORLD, 'rejected.json', null, mine, theirs)
    expect([...(value['names'] as string[])].sort()).toEqual(['a', 'b', 'c'])
  })

  it('conversations: the one that went further wins, with a rename from the other', () => {
    const msg = (content: string) => ({ role: 'user', content, at: '2026-01-01', read: null })
    const base = { id: 'cnv_1', title: 'Old', messages: [msg('hi')] }
    const mine = { ...base, title: 'New' }
    const theirs = { ...base, messages: [msg('hi'), msg('more')] }
    const { value, clean, copy } = merge('series/s1', 'ai/cnv_1.json', base, mine, theirs)
    expect(value['title']).toBe('New')
    expect(value['messages']).toEqual([msg('hi'), msg('more')])
    expect(clean).toBe(true)
    expect(copy).toBeUndefined()
  })

  it('conversations continued differently become two', () => {
    const msg = (content: string) => ({ role: 'user', content, at: '2026-01-01', read: null })
    const base = { id: 'cnv_1', title: 'Names', messages: [msg('hi')] }
    const mine = { ...base, messages: [msg('hi'), msg('here')] }
    const theirs = { ...base, messages: [msg('hi'), msg('there')] }
    const { value, copy } = merge('series/s1', 'ai/cnv_1.json', base, mine, theirs)
    expect(value['messages']).toEqual(mine.messages)
    expect(copy?.name).toBe('Names (from Laptop)')
    const other = dec(copy!.bytes)
    expect(other['messages']).toEqual(theirs.messages)
    expect(copy!.rel).toBe(`ai/${String(other['id'])}.json`)
  })

  it('gives up on files that are not JSON', () => {
    expect(mergeFile(WORLD, 'board.json', null, enc({}), new Uint8Array([1, 2]), from)).toBeNull()
  })
})
