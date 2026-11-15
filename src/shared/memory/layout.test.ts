import { describe, expect, it } from 'vitest'
import { layout, mapLinks, radiusOf } from './layout'
import type { MemoryNodeFile } from '../schema'

const T = '2026-03-03T05:00:00.000Z'
const node = (i: number, over: Partial<MemoryNodeFile> = {}): MemoryNodeFile => ({
  formatVersion: 1,
  id: `nod_${String(i).padStart(16, '0')}`,
  title: `Topic ${i}`,
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

describe('the memory map layout', () => {
  const nodes = Array.from({ length: 40 }, (_, i) =>
    node(i, { links: i ? [`nod_${String(Math.floor(i / 4)).padStart(16, '0')}`] : [] }),
  )

  it('lands the same way every time, with no circles overlapping', () => {
    const a = layout(nodes)
    expect(layout(nodes)).toEqual(a)
    for (const x of nodes)
      for (const y of nodes) {
        if (x.id >= y.id) continue
        const p = a.get(x.id)!
        const q = a.get(y.id)!
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(radiusOf(x) + radiusOf(y) - 1)
      }
  })

  it('never moves a circle the writer placed; arranges new ones around them', () => {
    const placed = nodes.map((n, i) => (i < 10 ? { ...n, pos: { x: 100 + i * 60, y: 200 } } : n))
    const a = layout(placed)
    for (let i = 0; i < 10; i++) expect(a.get(placed[i]!.id)).toEqual({ x: 100 + i * 60, y: 200 })
  })

  it('draws related lines once each, and "grew out of" lines', () => {
    const a = node(1, { links: [node(2).id] })
    const b = node(2, { links: [node(1).id, 'nod_gone'] })
    const c = node(3, { parentId: node(1).id })
    expect(mapLinks([a, b, c])).toEqual([
      { a: a.id, b: b.id, kind: 'related' },
      { a: a.id, b: c.id, kind: 'grew' },
    ])
  })

  it('bigger topics are bigger circles, within limits', () => {
    const pts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        text: 'x',
        state: 'fixed' as const,
        sources: [],
        createdAt: T,
        updatedAt: T,
      }))
    expect(radiusOf(node(1))).toBe(20)
    expect(radiusOf(node(1, { points: pts(9) }))).toBeGreaterThan(
      radiusOf(node(1, { points: pts(2) })),
    )
    expect(radiusOf(node(1, { points: pts(500) }))).toBe(64)
  })
})
