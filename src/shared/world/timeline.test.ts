import { describe, expect, it } from 'vitest'
import type { FactValue, MapFile } from '../schema'
import { currentValue } from './facts'
import { mapAt } from './maps'
import { relationshipAt } from './relationships'
import { anchorOf, buildTimeline, eraAt, orderBetween } from './timeline'

const chapters = [{ id: 'ch_a' }, { id: 'ch_b' }, { id: 'ch_c' }]
const timed = [
  { id: 'flood', template: 'event', when: { kind: 'history' as const, order: 2 } },
  { id: 'ash', template: 'era', when: { kind: 'history' as const, order: 1 } },
  { id: 'iron', template: 'era', when: { kind: 'chapter' as const, chapterId: 'ch_b' } },
  { id: 'burning', template: 'event', when: { kind: 'chapter' as const, chapterId: 'ch_b' } },
  { id: 'later', template: 'event', when: null },
  { id: 'lost', template: 'event', when: { kind: 'chapter' as const, chapterId: 'ch_gone' } },
]

describe('the timeline', () => {
  const t = buildTimeline(timed, chapters)

  it('puts history before the story, then chapters with their events', () => {
    expect(t.stops.map((s) => `${s.kind}:${s.id}@${s.position}`)).toEqual([
      'era:ash@-2',
      'event:flood@-1',
      'chapter:ch_a@0',
      'chapter:ch_b@1',
      'era:iron@1',
      'event:burning@1',
      'chapter:ch_c@2',
    ])
    expect(t.history).toEqual(['ash', 'flood'])
    expect(t.during.get('ch_b')).toEqual(['iron', 'burning'])
    // Not placed, or placed in a chapter that's gone: off the timeline.
    expect(t.unplaced).toEqual(['later', 'lost'])
  })

  it('runs each era up to the next', () => {
    expect(t.eras).toEqual([
      { id: 'ash', start: -2, end: 1 },
      { id: 'iron', start: 1, end: 3 },
    ])
    expect(eraAt(t, -1)).toBe('ash')
    expect(eraAt(t, 0)).toBe('ash')
    expect(eraAt(t, 2)).toBe('iron')
    expect(eraAt(t, null)).toBe('iron')
  })

  it('orders between neighbours without renumbering', () => {
    expect(orderBetween(1, 2)).toBe(1.5)
    expect(orderBetween(undefined, 2)).toBe(1)
    expect(orderBetween(4, undefined)).toBe(5)
    expect(orderBetween(undefined, undefined)).toBe(0)
  })

  it('makes facts from an event true from that event on', () => {
    const v = (text: string, from: FactValue['from']): FactValue => ({
      id: `fact_${text}`,
      text,
      from,
    })
    const status = [
      v('young', null),
      v('drowned', { kind: 'event', entryId: 'flood' }),
      v('rebuilt', { kind: 'chapter', chapterId: 'ch_c' }),
    ]
    expect(currentValue(status, -2, t.positions)?.text).toBe('young')
    expect(currentValue(status, -1, t.positions)?.text).toBe('drowned')
    expect(currentValue(status, 1, t.positions)?.text).toBe('drowned')
    expect(currentValue(status, null, t.positions)?.text).toBe('rebuilt')
    // An event not on the timeline counts as already true.
    const off = [v('a', null), v('b', { kind: 'event', entryId: 'later' })]
    expect(currentValue(off, -2, t.positions)?.text).toBe('b')
  })

  it('starts and ends relationships at events; ended ones are solid before the end', () => {
    const rel = {
      formatVersion: 1,
      id: 'rel_1',
      worldId: 'wld_1',
      from: 'ent_a',
      to: 'ent_b',
      type: 'friends',
      label: '',
      kin: null,
      over: true,
      start: { kind: 'event' as const, entryId: 'flood' },
      end: { kind: 'chapter' as const, chapterId: 'ch_c' },
      createdAt: '',
      updatedAt: '',
    }
    expect(relationshipAt(rel, -2, t.positions)).toBeNull()
    expect(relationshipAt(rel, 0, t.positions)).toEqual({ over: false })
    expect(relationshipAt(rel, 2, t.positions)).toEqual({ over: true })
  })

  it('shows the map version in effect at a moment', () => {
    const map = (id: string, versionOf: string | null, from: MapFile['from']) => ({
      id,
      versionOf,
      from,
      createdAt: id,
    })
    const base = map('m0', null, null)
    const maps = [
      base,
      map('m2', 'm0', { kind: 'chapter', chapterId: 'ch_c' }),
      map('m1', 'm0', { kind: 'event', entryId: 'flood' }),
    ]
    expect(mapAt(maps, base, -2, t.positions).id).toBe('m0')
    expect(mapAt(maps, base, 0, t.positions).id).toBe('m1')
    expect(mapAt(maps, base, 2, t.positions).id).toBe('m2')
    expect(mapAt(maps, base, null, t.positions).id).toBe('m2')
  })

  it('anchors at a stop', () => {
    expect(anchorOf(t.stops[1]!)).toEqual({ kind: 'event', entryId: 'flood' })
    expect(anchorOf(t.stops[2]!)).toEqual({ kind: 'chapter', chapterId: 'ch_a' })
  })
})
