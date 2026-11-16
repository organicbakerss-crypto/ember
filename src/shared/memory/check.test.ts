import { describe, expect, it } from 'vitest'
import { applyChecks, parseCheck, sameCheck, type IdeaCheck } from './check'
import { tidyText } from './tidy'
import type { MemoryNodeFile, MemoryPoint } from '../schema'

const T = '2026-03-03T05:00:00.000Z'
const AT = '2026-11-16T10:00:00.000Z'
const point = (id: string, text: string, state: MemoryPoint['state']): MemoryPoint => ({
  id,
  text,
  state,
  sources: [],
  createdAt: T,
  updatedAt: T,
})
const node = (i: number, title: string, over: Partial<MemoryNodeFile> = {}): MemoryNodeFile => ({
  formatVersion: 1,
  id: `nod_${String(i).padStart(16, '0')}`,
  title,
  state: 'unfixed',
  summary: '',
  volumeId: null,
  entryIds: [],
  links: [],
  parentId: null,
  loose: false,
  pos: null,
  points: [],
  history: [],
  createdAt: T,
  updatedAt: T,
  ...over,
})
const chapter = [
  { id: 'chp_1', title: 'The Gathering' },
  { id: 'chp_2', title: 'After' },
]

describe('checking ideas against a chapter', () => {
  const evander = node(1, 'Evander', {
    points: [
      point('pnt_a', 'He meets Felix upside down', 'unfixed'),
      point('pnt_b', 'He has fifteen bodies', 'fixed'),
      point('pnt_c', 'He hates crowds', 'rejected'),
    ],
  })
  const old = node(2, 'Old plan', { state: 'rejected' })
  const all = [evander, old]

  it('turns the reply into suggestions, dropping keys that do not fit', () => {
    const { keys } = tidyText(all)
    const reply = JSON.stringify({
      onPage: [{ point: 'P1', quote: 'hung upside down' }, { point: 'P2' }, { point: 'P9' }],
      contradicted: [
        { point: 'P2', chapter: 'C2', why: 'there are twelve', quote: 'twelve of him' },
      ],
      new: [
        { node: 'T1', text: 'Felix owes Evander a favour', quote: 'owe me' },
        { node: 'T1', text: 'he meets felix upside down' },
        { node: '', title: 'The debt', text: 'The debt comes due in winter', quote: '' },
        { node: 'LOOSE', text: 'A bell rings at dusk', quote: '' },
        { node: '', title: '', text: 'No home for this' },
      ],
    })
    const found = parseCheck(`Sure! ${reply}`, keys, all, chapter, AT)
    expect(found.map((c) => c.kind)).toEqual(['onPage', 'contradicted', 'fresh', 'fresh', 'fresh'])
    // A fixed point isn't "now on the page"; a rejected one is never offered.
    const onPage = found[0] as Extract<IdeaCheck, { kind: 'onPage' }>
    expect(onPage.pointId).toBe('pnt_a')
    expect(onPage.chapterTitle).toBe('The Gathering')
    expect(found[1]!.chapterTitle).toBe('After')
    const fresh = found.filter((c) => c.kind === 'fresh')
    expect(fresh.map((c) => c.topic)).toEqual(['Evander', 'The debt', 'Loose ends'])
  })

  it('reads a broken reply as nothing', () => {
    const { keys } = tidyText(all)
    expect(parseCheck('no json here', keys, all, chapter, AT)).toEqual([])
    expect(parseCheck('{"onPage": [', keys, all, chapter, AT)).toEqual([])
  })

  it('makes only the ticked changes, listed on each topic with the chapter as the source', () => {
    const { keys } = tidyText(all)
    const found = parseCheck(
      JSON.stringify({
        onPage: [{ point: 'P1', quote: 'upside down' }],
        contradicted: [{ point: 'P2', why: 'twelve', quote: 'twelve' }],
        new: [{ node: '', title: 'The debt', text: 'The debt comes due', quote: 'due' }],
      }),
      keys,
      all,
      chapter,
      AT,
    )
    const { save, applied } = applyChecks(all, found, AT)
    expect(applied).toBe(3)
    const ev = save.find((n) => n.id === evander.id)!
    expect(ev.points.find((p) => p.id === 'pnt_a')!.state).toBe('fixed')
    expect(ev.points.find((p) => p.id === 'pnt_b')!.state).toBe('rejected')
    expect(ev.points.find((p) => p.id === 'pnt_a')!.sources.at(-1)!.title).toBe(
      'Chapter “The Gathering”',
    )
    expect(ev.history.map((h) => h.what).join(' ')).toContain('On the page in “The Gathering”')
    const debt = save.find((n) => n.title === 'The debt')!
    expect(debt.points[0]!.state).toBe('fixed')
    // The originals are untouched.
    expect(evander.points[0]!.state).toBe('unfixed')
  })

  it('skips a change that no longer fits (point gone or already changed)', () => {
    const c: IdeaCheck = {
      id: 'chk_1',
      chapterId: 'chp_1',
      chapterTitle: 'X',
      at: AT,
      quote: '',
      kind: 'onPage',
      nodeId: evander.id,
      pointId: 'pnt_gone',
      topic: 'Evander',
      text: 'gone',
    }
    expect(applyChecks(all, [c], AT)).toEqual({ save: [], applied: 0 })
    expect(applyChecks(all, [{ ...c, pointId: 'pnt_b' }], AT).applied).toBe(0)
  })

  it('counts the same suggestion from checking a chapter twice once', () => {
    const base = { id: 'a', chapterId: 'c', chapterTitle: 'C', at: AT, quote: '' }
    const f = (text: string): IdeaCheck => ({
      ...base,
      kind: 'fresh',
      nodeId: null,
      topic: 'T',
      loose: false,
      text,
    })
    expect(sameCheck(f('The debt comes due'), f('the debt comes due.'))).toBe(true)
    expect(sameCheck(f('The debt comes due'), f('Something else entirely'))).toBe(false)
  })
})
