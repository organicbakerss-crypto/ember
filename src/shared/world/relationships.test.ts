import { describe, expect, it } from 'vitest'
import type { RelationshipFile } from '../schema'
import {
  bandStops,
  boardLines,
  BUILT_IN_RELATIONSHIP_TYPES as TYPES,
  describeLine,
  familyTree,
  relationshipAt,
  relationshipText,
} from './relationships'

let n = 0
const rel = (
  from: string,
  to: string,
  type: string,
  extra: Partial<RelationshipFile> = {},
): RelationshipFile => ({
  formatVersion: 1,
  id: `rel_${n++}`,
  worldId: 'wld',
  from,
  to,
  type,
  label: '',
  kin: null,
  over: false,
  start: null,
  end: null,
  createdAt: '',
  updatedAt: '',
  ...extra,
})
const positions = new Map([
  ['c1', 0],
  ['c2', 1],
  ['c3', 2],
])
const ch = (chapterId: string) => ({ kind: 'chapter' as const, chapterId })
const colour = (id: string) => TYPES.find((t) => t.id === id)!.colour

describe('lines on the board', () => {
  it('shows one line per pair, with "met" only when nothing else is there', () => {
    const lines = boardLines(
      [rel('mara', 'odo', 'met'), rel('odo', 'mara', 'rivals'), rel('mara', 'kael', 'met')],
      TYPES,
      { at: null, positions },
    )
    expect(lines).toHaveLength(2)
    const pair = lines.find((l) => l.b === 'odo' || l.a === 'odo')!
    expect(pair.colours).toEqual([colour('rivals')])
    expect(lines.find((l) => l.b === 'mara' || l.a === 'kael')!.colours).toEqual([colour('met')])
  })

  it('blends types along the line in time order, or uses the strongest when blending is off', () => {
    const rels = [
      rel('mara', 'odo', 'romance', { start: ch('c3') }),
      rel('mara', 'odo', 'rivals', { start: ch('c1') }),
    ]
    const [line] = boardLines(rels, TYPES, { at: null, positions })
    expect(line!.colours).toEqual([colour('rivals'), colour('romance')])
    expect(describeLine(line!, TYPES, positions)).toBe('Rivals, then romance')
    const [plain] = boardLines(rels, TYPES, { at: null, positions, blend: false })
    expect(plain!.colours).toEqual([colour('romance')])
  })

  it('is dashed when every relationship on it is over; respects time and hidden types', () => {
    const fought = rel('a', 'b', 'enemies', { start: ch('c1'), end: ch('c2') })
    expect(boardLines([fought], TYPES, { at: null, positions })[0]!.over).toBe(true)
    expect(relationshipAt(fought, 0, positions)).toEqual({ over: false })
    expect(relationshipAt(rel('a', 'b', 'friends', { start: ch('c3') }), 1, positions)).toBeNull()
    expect(
      boardLines([fought], TYPES, { at: null, positions, hidden: new Set(['enemies']) }),
    ).toEqual([])
  })

  it('makes bands that hold their colour and fade, never averaged', () => {
    expect(bandStops(['#f00'])).toEqual([{ offset: 0, colour: '#f00' }])
    const stops = bandStops(['#f00', '#0f0', '#00f'])
    expect(stops.map((s) => s.colour)).toEqual(['#f00', '#f00', '#0f0', '#0f0', '#00f', '#00f'])
    expect(stops[0]!.offset).toBe(0)
    expect(stops.at(-1)!.offset).toBe(1)
  })
})

describe('family tree', () => {
  it('puts parents above children and partners side by side', () => {
    const tree = familyTree([
      rel('mum', 'mara', 'family', { kin: 'parent' }),
      rel('dad', 'mara', 'family', { kin: 'parent' }),
      rel('mum', 'dad', 'family', { kin: 'partner' }),
      rel('mara', 'odo', 'family', { kin: 'sibling' }),
      rel('mara', 'kid', 'family', { kin: 'parent' }),
      rel('mara', 'pal', 'friends'),
    ])
    const g = Object.fromEntries(tree.nodes.map((n) => [n.id, n.generation]))
    expect(g).toEqual({ mum: 0, dad: 0, mara: 1, odo: 1, kid: 2 })
    const col = Object.fromEntries(tree.nodes.map((n) => [n.id, n.column]))
    expect(Math.abs(col['mum']! - col['dad']!)).toBe(1)
    expect(tree.children.find((c) => c.child === 'mara')!.parents.sort()).toEqual(['dad', 'mum'])
    expect(tree.siblings).toEqual([['mara', 'odo']])
  })
})

describe('text form', () => {
  it('writes a relationship with names, ids, type and time', () => {
    const names = new Map([
      ['mara', 'Mara'],
      ['odo', 'Odo'],
    ])
    const text = relationshipText(
      rel('mara', 'odo', 'family', { label: 'sister of', kin: 'sibling', start: ch('c1') }),
      names,
      TYPES,
      (id) => (id === 'c1' ? 'Ch 1' : undefined),
    )
    expect(text).toBe('Mara [mara] — sister of → Odo [odo] (family, siblings, from Ch 1)')
  })
})

describe('one-way and faint ties', () => {
  it('works for, heard of and betrayed point one way; exes is both ways', () => {
    const one = TYPES.filter((t) => t.oneWay).map((t) => t.id)
    expect(one).toEqual(['works', 'heard', 'betrayed'])
    expect(TYPES.find((t) => t.id === 'exes')!.oneWay).toBeUndefined()
  })

  it('draws an arrow at whoever it points to, both when it goes both ways', () => {
    const [line] = boardLines([rel('a', 'b', 'works')], TYPES, { at: null, positions })
    expect(line!.arrows).toEqual({ toA: false, toB: true })
    const [back] = boardLines([rel('b', 'a', 'betrayed')], TYPES, { at: null, positions })
    expect(back!.arrows).toEqual({ toA: true, toB: false })
    const [mutual] = boardLines(
      [rel('a', 'b', 'betrayed'), rel('b', 'a', 'betrayed', { start: ch('c2') })],
      TYPES,
      { at: null, positions },
    )
    expect(mutual!.arrows).toEqual({ toA: true, toB: true })
    const [friends] = boardLines([rel('a', 'b', 'friends')], TYPES, { at: null, positions })
    expect(friends!.arrows).toEqual({ toA: false, toB: false })
  })

  it('“heard of” is faint and, like “met”, only shows when nothing stronger does', () => {
    const [heard] = boardLines([rel('a', 'b', 'heard')], TYPES, { at: null, positions })
    expect(heard!.faint).toBe(true)
    const [both] = boardLines([rel('a', 'b', 'heard'), rel('a', 'b', 'works')], TYPES, {
      at: null,
      positions,
    })
    expect(both!.relationships.map((r) => r.type)).toEqual(['works'])
    expect(both!.faint).toBe(false)
  })

  it('reads the right way round, with names', () => {
    const names: Record<string, string> = { a: 'Rodney', b: 'Josh' }
    const [line] = boardLines([rel('a', 'b', 'works')], TYPES, { at: null, positions })
    expect(describeLine(line!, TYPES, positions, (id) => names[id]!)).toBe('Rodney works for Josh')
  })
})
