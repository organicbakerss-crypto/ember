import { describe, expect, it } from 'vitest'
import { applyUpdate, describeChanges, handedMessages, parseUpdate } from './update'
import { tidyText } from './tidy'
import { keepDraft, mergePart, parsePartReply, type MemoryDraft } from './build'
import type { MemoryNodeFile } from '../schema'

const T = '2026-03-03T05:00:00.000Z'
const node = (i: number, title: string, over: Partial<MemoryNodeFile> = {}): MemoryNodeFile => ({
  formatVersion: 1,
  id: `nod_${String(i).padStart(16, '0')}`,
  title,
  state: 'fixed',
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
const src = {
  conversationId: 'cnv_x',
  title: 'Planning',
  at: '2026-11-15T10:00:00.000Z',
  quote: '',
}

describe('keeping the memory up to date', () => {
  const eye = node(1, 'The Saint’s Eye', {
    points: [
      {
        id: 'pnt_1',
        text: 'It must be pawned',
        state: 'fixed',
        sources: [],
        createdAt: T,
        updatedAt: T,
      },
    ],
  })
  const gone = node(2, 'Second heist', { state: 'rejected' })
  const all = [eye, gone]

  it('adds points, makes a new topic only when nothing fits, never touches rejected topics', () => {
    const { keys } = tidyText(all)
    const r = applyUpdate(
      all,
      parseUpdate(
        JSON.stringify({
          points: [
            { node: 'T1', text: 'It must be pawned.', state: 'fixed' }, // already there
            { node: 'T1', text: 'It glows', state: 'whim' },
            { node: '', title: 'Odo', text: 'Odo runs the pawn shop', state: 'unfixed' },
            { node: '', title: 'odo', text: 'Odo owes Josh money', state: 'unfixed' },
            { node: 'T2', text: 'Into the rejected topic', state: 'fixed' }, // T2 doesn't exist: rejected hidden
          ],
          summaries: [{ node: 'T1', summary: 'The relic everyone hunts.' }],
        }),
      )!,
      keys,
      src,
    )
    const saved = new Map(r.save.map((n) => [n.title, n]))
    expect(saved.get('The Saint’s Eye')!.points.map((p) => p.text)).toEqual([
      'It must be pawned',
      'It glows',
    ])
    expect(saved.get('The Saint’s Eye')!.summary).toBe('The relic everyone hunts.')
    expect(saved.get('Odo')!.points).toHaveLength(2)
    expect(r.created).toEqual([saved.get('Odo')!.id])
    expect(saved.has('Second heist')).toBe(false)
    expect(describeChanges(r.what)).toBe(
      'added a point to “The Saint’s Eye”; added 2 points to “Odo”',
    )
    expect(eye.points).toHaveLength(1) // the original is untouched
  })

  it('reads nothing from an answer that isn’t JSON', () => {
    expect(parseUpdate('nothing changed')).toBeNull()
    const { keys } = tidyText(all)
    expect(applyUpdate(all, parseUpdate('{}')!, keys, src).save).toEqual([])
  })
})

describe('Make nodes links what it finds', () => {
  it('turns "related" into links, to new topics and ones already in the memory', () => {
    const heist = node(5, 'Casino heist')
    const d: MemoryDraft = {
      seriesId: 's',
      instruction: '',
      conversationIds: [],
      from: null,
      to: null,
      forcedParts: [],
      parts: [],
      nodes: [],
      loose: [],
      state: 'done',
      error: null,
      createdAt: T,
      updatedAt: T,
    }
    const part = [
      { role: 'user' as const, content: 'x', at: T, conversationId: 'c', title: 'Chat' },
    ]
    mergePart(
      d,
      parsePartReply(
        JSON.stringify({
          relevant: true,
          nodes: [
            {
              title: 'The Saint’s Eye',
              state: 'fixed',
              related: ['Odo', heist.id],
              points: [{ text: 'Glows', state: 'fixed' }],
            },
            {
              title: 'Odo',
              state: 'unfixed',
              related: ['the saint’s eye'],
              points: [{ text: 'Runs the shop', state: 'fixed' }],
            },
          ],
        }),
      )!,
      part,
      [heist],
    )
    const kept = keepDraft(d, [heist], [])
    const eye = kept.find((n) => n.title === 'The Saint’s Eye')!
    const odo = kept.find((n) => n.title === 'Odo')!
    expect(eye.links.sort()).toEqual([heist.id, odo.id].sort())
    expect(odo.links).toEqual([]) // the same link isn't made twice
  })
})

describe('something the writer hands the ideas', () => {
  it('is read as a hand-over (not a chat exchange), with what to take', () => {
    const [system, user] = handedMessages({
      storyName: 'Casino',
      memory: '',
      name: 'plot.md',
      text: 'Josh hides the Eye.',
      instruction: 'Only the casino story',
      part: 2,
      parts: 3,
    })
    expect(system!.content).toContain('from things they hand you')
    expect(system!.content).toContain('“Only the casino story”')
    expect(system!.content).not.toContain('After the exchange that follows')
    expect(user!.content).toContain('Part 2 of 3 of “plot.md”')
  })
})
