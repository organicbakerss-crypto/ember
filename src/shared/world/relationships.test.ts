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
