import { describe, expect, it } from 'vitest'
import { applyTidy, parseTidy, tidyBatches, tidyText } from './tidy'
import type { MemoryNodeFile, MemoryPoint } from '../schema'

const T = '2026-03-03T05:00:00.000Z'
let n = 0
const pt = (text: string, state: MemoryPoint['state'] = 'fixed'): MemoryPoint => ({
  id: `pnt_${String(++n).padStart(16, '0')}`,
  text,
  state,
  sources: [],
  createdAt: T,
  updatedAt: T,
})
const node = (
  id: number,
  title: string,
  points: MemoryPoint[],
  over: Partial<MemoryNodeFile> = {},
): MemoryNodeFile => ({
  formatVersion: 1,
  id: `nod_${String(id).padStart(16, '0')}`,
  title,
  state: 'fixed',
  summary: '',
  volumeId: null,
  entryIds: [],
  links: [],
  parentId: null,
  loose: false,
  pos: null,
  points,
  history: [],
  createdAt: T,
  updatedAt: T,
  ...over,
})

describe('tidy up', () => {
  const eye = node(1, 'The Saint’s Eye', [
    pt('It must be pawned off'),
    pt('The dealer is the fence', 'unfixed'),
  ])
  const relic = node(2, 'The relic', [pt('It glows at night', 'whim')])
  const heist = node(3, 'Casino heist', [
    pt('It happens on a holiday'),
    pt('Josh drives the getaway car'),
  ])
  const josh = node(4, 'Josh', [])
  const loose = node(
    5,
    'Loose ends',
    [pt('Pawn shop owner is Odo'), pt('Odo owes Josh money'), pt('A song plays')],
    { loose: true },
  )
  const gone = node(6, 'Second heist', [pt('Rejected idea')], { state: 'rejected' })
  const all = [eye, relic, heist, josh, loose, gone]

  it('shows the AI everything but rejected topics, with short keys', () => {
    const { text, keys } = tidyText(all)
    expect(text).toContain('T1 “The Saint’s Eye” (fixed)')
    expect(text).toContain('[LOOSE ENDS]')
    expect(text).not.toContain('Second heist')
    expect(keys.node.get('T3')).toBe(heist.id)
    expect([...keys.point.values()]).toContain(heist.points[1]!.id)
  })

  it('keeps only suggestions that make sense', () => {
    const { keys } = tidyText(all)
    const pkey = (id: string) => [...keys.point].find(([, v]) => v === id)![0]
    const reply = JSON.stringify({
      links: [
        { a: 'T1', b: 'T3', why: 'The heist is for the Eye' },
        { a: 'T3', b: 'T1', why: 'again' },
        { a: 'T1', b: 'T99', why: 'made up' },
        { a: 'T1', b: 'T5', why: 'loose ends never linked' },
      ],
      merges: [{ keep: 'T1', merge: ['T2'], title: '', why: 'Same relic' }],
      moves: [
        { point: pkey(heist.points[1]!.id), to: 'T4', why: 'About Josh' },
        { point: pkey(heist.points[0]!.id), to: 'T3', why: 'already there' },
      ],
      files: [
        {
          points: [pkey(loose.points[0]!.id), pkey(loose.points[1]!.id)],
          to: null,
          title: 'Odo',
          why: 'Both about Odo',
        },
        { points: [pkey(eye.points[0]!.id)], to: 'T3', why: 'not a loose end' },
      ],
      splits: [{ point: pkey(eye.points[1]!.id), title: 'The fence', why: 'Grown big' }],
    })
    const s = parseTidy(`Sure: ${reply}`, keys, all)
    expect(s.map((x) => x.kind)).toEqual(['link', 'merge', 'move', 'file', 'split'])
    expect(s[1]).toMatchObject({ keep: eye.id, merge: [relic.id], title: 'The Saint’s Eye' })
    expect(parseTidy('no json', keys, all)).toEqual([])
  })

  it('makes the kept changes in a safe order, never touching fixed / unfixed / whim', () => {
    const r = applyTidy(all, [
      { kind: 'link', a: relic.id, b: heist.id, why: '' }, // relic is merged first: the link follows it
      { kind: 'merge', keep: eye.id, merge: [relic.id], title: 'The Saint’s Eye', why: '' },
      { kind: 'move', point: heist.points[1]!.id, to: josh.id, why: '' },
      {
        kind: 'file',
        points: [loose.points[0]!.id, loose.points[1]!.id],
        to: null,
        title: 'Odo',
        why: '',
      },
      { kind: 'split', point: eye.points[1]!.id, title: 'The fence', why: '' },
    ])
    expect(r.remove).toEqual([relic.id])
    const saved = new Map(r.save.map((x) => [x.title, x]))
    const newEye = saved.get('The Saint’s Eye')!
    expect(newEye.points.map((p) => [p.text, p.state])).toEqual([
      ['It must be pawned off', 'fixed'],
      ['It glows at night', 'whim'],
    ])
    expect(newEye.links).toContain(heist.id)
    expect(saved.get('Josh')!.points.map((p) => p.text)).toEqual(['Josh drives the getaway car'])
    const odo = saved.get('Odo')!
    expect(odo.points).toHaveLength(2)
    expect(saved.get('Loose ends')!.points.map((p) => p.text)).toEqual(['A song plays'])
    const fence = saved.get('The fence')!
    expect(fence.parentId).toBe(eye.id)
    expect(fence.state).toBe('unfixed')
    expect(fence.points[0]!.state).toBe('unfixed')
    expect(newEye.history.at(-1)!.what).toContain('Tidy up')
    // The originals weren't touched.
    expect(eye.points).toHaveLength(2)
    expect(relic.points).toHaveLength(1)
  })

  it('reviews a big memory in batches', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      node(100 + i, `T${i}`, [pt('word '.repeat(50))]),
    )
    const batches = tidyBatches(many, 600)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.reduce((n, b) => n + b.size, 0)).toBe(30)
    const { text } = tidyText(many, batches[1])
    expect(text).toContain('T1 “T0”') // every topic is named…
    expect(text.split('- P').length - 1).toBe(batches[1]!.size) // …but only this batch's points are shown
  })
})
