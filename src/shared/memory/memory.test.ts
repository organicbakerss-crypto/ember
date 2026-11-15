import { describe, expect, it } from 'vitest'
import {
  cutParts,
  keepDraft,
  mergePart,
  parsePartReply,
  samePoint,
  type MemoryDraft,
  type SourceMessage,
} from './build'
import { memoryIndex, nodeForAI, parseRecall, pickByWords } from './recall'
import type { MemoryNodeFile } from '../schema'

const T = '2026-03-03T05:00:00.000Z'
const msg = (role: 'user' | 'assistant', content: string, at = T): SourceMessage => ({
  role,
  content,
  at,
  conversationId: 'cnv_aaaaaaaaaaaaaaaa',
  title: 'Casino Scene Feedback',
})
const draft = (): MemoryDraft => ({
  seriesId: 's',
  instruction: 'Only the casino story',
  conversationIds: [],
  from: null,
  to: null,
  forcedParts: [],
  parts: [],
  nodes: [],
  loose: [],
  state: 'running',
  error: null,
  createdAt: T,
  updatedAt: T,
})

describe('making nodes', () => {
  it('cuts conversations into parts by words', () => {
    const parts = cutParts(
      [msg('user', 'a b c'), msg('assistant', 'd e f g'), msg('user', 'h i')],
      6,
    )
    expect(parts.map((p) => p.length)).toEqual([1, 2])
  })

  it('reads the AI’s answer even with words around it, and drops bad bits alone', () => {
    const r = parsePartReply(
      'Sure! {"relevant":true,"nodes":[{"node":"","title":"The Saint’s Eye","state":"FIXED","summary":"A relic.","points":[{"text":"It must be pawned off","state":"fixed","quote":"pawn it off"},{"oops":1}]},{"bad":true}],"loose":[]} done',
    )
    expect(r!.nodes).toHaveLength(1)
    expect(r!.nodes[0]!.state).toBe('fixed')
    expect(r!.nodes[0]!.points).toHaveLength(1)
    expect(parsePartReply('no json here')).toBeNull()
  })

  it('merges parts: same topic, same point said again, later state wins, source found', () => {
    const d = draft()
    const p1 = [
      msg('user', 'What if the dealer is the fence?'),
      msg('assistant', 'Then the Eye goes to him.'),
    ]
    mergePart(
      d,
      parsePartReply(
        '{"relevant":true,"nodes":[{"node":"","title":"The Saint’s Eye","state":"fixed","summary":"A relic.","points":[{"text":"The dealer is the fence","state":"unfixed","quote":"dealer is the fence"}]}],"loose":[{"text":"Maybe a song","state":"whim","quote":""}]}',
      )!,
      p1,
      [],
    )
    const p2 = [msg('user', 'Yes, the dealer is the fence. Decided.', '2026-04-01T00:00:00.000Z')]
    mergePart(
      d,
      parsePartReply(
        '{"relevant":true,"nodes":[{"node":"new:the saints eye","title":"the saint’s eye","state":"fixed","summary":"A relic everyone hunts.","points":[{"text":"The dealer is the fence.","state":"fixed","quote":"the dealer is the fence"}]}],"loose":[]}',
      )!,
      p2,
      [],
    )
    expect(d.nodes).toHaveLength(1)
    const node = d.nodes[0]!
    expect(node.summary).toBe('A relic everyone hunts.')
    expect(node.points).toHaveLength(1)
    expect(node.points[0]).toMatchObject({ state: 'fixed', changed: 'unfixed → fixed' })
    expect(node.points[0]!.source.at).toBe('2026-04-01T00:00:00.000Z')
    expect(d.loose).toHaveLength(1)
  })

  it('keeps a draft: adds to existing nodes without removing anything, makes new ones and Loose ends', () => {
    const existing: MemoryNodeFile = {
      formatVersion: 1,
      id: 'nod_aaaaaaaaaaaaaaaa',
      title: 'The Saint’s Eye',
      state: 'fixed',
      summary: 'Old summary',
      volumeId: null,
      entryIds: [],
      links: [],
      parentId: null,
      loose: false,
      points: [
        {
          id: 'pnt_aaaaaaaaaaaaaaaa',
          text: 'It glows',
          state: 'fixed',
          sources: [],
          createdAt: T,
          updatedAt: T,
        },
      ],
      history: [],
      createdAt: T,
      updatedAt: T,
    }
    const d = draft()
    mergePart(
      d,
      parsePartReply(
        `{"relevant":true,"nodes":[{"node":"${existing.id}","title":"The Saint’s Eye","state":"fixed","summary":"New summary","points":[{"text":"It glows","state":"fixed"},{"text":"It must be pawned","state":"fixed"}]},{"node":"","title":"Pawn shop","state":"unfixed","summary":"","book":"Book Two","points":[{"text":"Owned by Odo","state":"whim"}]}],"loose":[{"text":"A song","state":"whim"}]}`,
      )!,
      [msg('user', 'x')],
      [existing],
    )
    const saved = keepDraft(d, [existing], [{ id: 'vol_bbbbbbbbbbbbbbbb', name: 'Book Two' }])
    const eye = saved.find((n) => n.id === existing.id)!
    expect(eye.points.map((p) => p.text)).toEqual(['It glows', 'It must be pawned'])
    expect(eye.summary).toBe('New summary')
    expect(eye.history.at(-1)!.what).toContain('1 new points')
    expect(existing.points).toHaveLength(1) // the original object is untouched
    const shop = saved.find((n) => n.title === 'Pawn shop')!
    expect(shop.volumeId).toBe('vol_bbbbbbbbbbbbbbbb')
    expect(saved.find((n) => n.loose)!.points[0]!.text).toBe('A song')
    // Only some kept.
    expect(keepDraft(d, [existing], [], new Set(['loose']))).toHaveLength(1)
  })

  it('knows a point said again in other words, but not a different one', () => {
    expect(samePoint('The dealer is the fence', 'the dealer is the fence.')).toBe(true)
    expect(samePoint('The dealer is the fence', 'The dealer is not the fence at all, ever')).toBe(
      false,
    )
  })
})

describe('reading the memory', () => {
  const node = (over: Partial<MemoryNodeFile>): MemoryNodeFile => ({
    formatVersion: 1,
    id: 'nod_aaaaaaaaaaaaaaaa',
    title: 'The Saint’s Eye',
    state: 'fixed',
    summary: 'A relic everyone hunts.',
    volumeId: null,
    entryIds: [],
    links: [],
    parentId: null,
    loose: false,
    points: [
      {
        id: 'pnt_1aaaaaaaaaaaaaaa',
        text: 'It must be pawned',
        state: 'fixed',
        sources: [{ conversationId: 'c', title: 'Casino', at: T, quote: 'pawn it off' }],
        createdAt: T,
        updatedAt: T,
      },
      {
        id: 'pnt_2aaaaaaaaaaaaaaa',
        text: 'Dealer is the fence',
        state: 'unfixed',
        sources: [],
        createdAt: T,
        updatedAt: T,
      },
      {
        id: 'pnt_3aaaaaaaaaaaaaaa',
        text: 'The Eye talks',
        state: 'whim',
        sources: [],
        createdAt: T,
        updatedAt: T,
      },
      {
        id: 'pnt_4aaaaaaaaaaaaaaa',
        text: 'The Eye is fake',
        state: 'rejected',
        sources: [],
        createdAt: T,
        updatedAt: T,
      },
    ],
    history: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  })

  it('never shows rejected nodes or points to the AI', () => {
    const rejected = node({ id: 'nod_bbbbbbbbbbbbbbbb', title: 'Second heist', state: 'rejected' })
    const index = memoryIndex([node({}), rejected])
    expect(index).toContain('The Saint’s Eye')
    expect(index).not.toContain('Second heist')
    for (const depth of [1, 2, 3, 4] as const)
      expect(nodeForAI(node({}), depth)).not.toContain('fake')
    expect(nodeForAI(rejected, 4)).toBe('')
    expect(
      parseRecall('{"open":[{"id":"nod_bbbbbbbbbbbbbbbb","depth":3}]}', [rejected], 5),
    ).toEqual([])
  })

  it('reads as deep as asked', () => {
    const n = node({})
    expect(nodeForAI(n, 1)).not.toContain('pawned')
    expect(nodeForAI(n, 2)).toContain('It must be pawned')
    expect(nodeForAI(n, 2)).not.toContain('fence')
    expect(nodeForAI(n, 3)).toContain('Dealer is the fence')
    expect(nodeForAI(n, 3)).toContain('The Eye talks')
    expect(nodeForAI(n, 4)).toContain('“pawn it off”')
    expect(nodeForAI(node({ state: 'whim' }), 2)).toContain('only a whim')
  })

  it('takes the AI’s picks (only real ones, at most the limit), or matches words without it', () => {
    const n = node({})
    expect(
      parseRecall(
        '{"open":[{"id":"nod_aaaaaaaaaaaaaaaa","depth":"4"},{"id":"nope","depth":2}]}',
        [n],
        5,
      ),
    ).toEqual([{ id: n.id, depth: 4 }])
    expect(parseRecall('nothing', [n], 5)).toEqual([])
    expect(pickByWords([n], ['eye'], 3)).toEqual([{ id: n.id, depth: 3 }])
    expect(pickByWords([n], ['fence'], 3)).toEqual([{ id: n.id, depth: 2 }])
    expect(pickByWords([n], ['fake'], 3)).toEqual([]) // only in a rejected point
  })
})
