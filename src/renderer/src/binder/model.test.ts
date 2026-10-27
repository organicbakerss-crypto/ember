import { describe, expect, it } from 'vitest'
import type { OutlineFile } from '@shared/schema'
import { chapterOrder, fromContainers, listId, moveItem, ROOT, toContainers } from './model'

const outline: OutlineFile = {
  formatVersion: 1,
  volumeId: 'vol_x',
  items: [
    { type: 'chapter', id: 'chp_prologue' },
    { type: 'arc', id: 'arc_one', name: 'One', finished: true, chapterIds: ['chp_a', 'chp_b'] },
    { type: 'arc', id: 'arc_two', name: 'Two', finished: false, chapterIds: [], extra: 1 },
    { type: 'chapter', id: 'chp_epilogue' },
  ],
}

describe('binder model', () => {
  it('round-trips an outline, keeping arc fields', () => {
    expect(fromContainers(outline, toContainers(outline))).toEqual(outline)
  })

  it('reorders chapters inside an arc', () => {
    const next = moveItem(toContainers(outline), 'chp_b', 'chp_a')
    expect(next['arc_one']).toEqual(['chp_b', 'chp_a'])
  })

  it('moves a chapter into another arc, including an empty one', () => {
    const next = moveItem(toContainers(outline), 'chp_a', listId('arc_two'))
    expect(next['arc_one']).toEqual(['chp_b'])
    expect(next['arc_two']).toEqual(['chp_a'])
  })

  it('moves a loose chapter into an arc before a given chapter', () => {
    const next = moveItem(toContainers(outline), 'chp_epilogue', 'chp_b')
    expect(next['arc_one']).toEqual(['chp_a', 'chp_epilogue', 'chp_b'])
    expect(next[ROOT]).toEqual(['chp_prologue', 'arc_one', 'arc_two'])
  })

  it('moves a chapter out of an arc when dropped on an arc header', () => {
    const next = moveItem(toContainers(outline), 'chp_a', 'arc_two')
    expect(next[ROOT]).toEqual(['chp_prologue', 'arc_one', 'chp_a', 'arc_two', 'chp_epilogue'])
    expect(next['arc_one']).toEqual(['chp_b'])
  })

  it('reorders arcs at the root, carrying their chapters', () => {
    const next = moveItem(toContainers(outline), 'arc_two', 'arc_one')
    const result = fromContainers(outline, next)
    expect(result.items.map((i) => i.id)).toEqual([
      'chp_prologue',
      'arc_two',
      'arc_one',
      'chp_epilogue',
    ])
    expect(chapterOrder(next)).toEqual(['chp_prologue', 'chp_a', 'chp_b', 'chp_epilogue'])
  })

  it('never nests an arc: hovering a chapter inside an arc targets that arc', () => {
    const next = moveItem(toContainers(outline), 'arc_two', 'chp_a')
    expect(next[ROOT]).toEqual(['chp_prologue', 'arc_two', 'arc_one', 'chp_epilogue'])
    expect(next['arc_one']).toEqual(['chp_a', 'chp_b'])
  })

  it('never loses or duplicates a chapter', () => {
    let containers = toContainers(outline)
    const ids = ['chp_prologue', 'chp_a', 'chp_b', 'chp_epilogue', 'arc_one', 'arc_two']
    const targets = [...ids, listId('arc_one'), listId('arc_two')]
    for (const a of ids) for (const b of targets) containers = moveItem(containers, a, b)
    expect(chapterOrder(containers).sort()).toEqual(
      ['chp_a', 'chp_b', 'chp_epilogue', 'chp_prologue'].sort(),
    )
    expect(containers[ROOT]!.filter((id) => id.startsWith('arc_')).sort()).toEqual([
      'arc_one',
      'arc_two',
    ])
  })

  it('returns the same object when nothing moves', () => {
    const containers = toContainers(outline)
    expect(moveItem(containers, 'chp_a', 'chp_a')).toBe(containers)
  })
})
