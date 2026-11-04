import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './library'

let root: string
let lib: Library

beforeEach(async () => {
  root = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'chops-')), 'lib')
  lib = await Library.open(root, { create: true })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.promises.rm(join(root, '..'), { recursive: true, force: true })
})

const para = (...texts: string[]) => ({
  type: 'doc' as const,
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})

async function story() {
  const series = await lib.createSeries({ name: 'S', world: { mode: 'none' } })
  const vol = await lib.createVolume({ seriesId: series.id, name: 'V' })
  const ref = [series.id, vol.id] as const
  const add = async (title: string, ...texts: string[]) => {
    const ch = await lib.createChapter({ seriesId: series.id, volumeId: vol.id, title })
    await lib.saveChapter(...ref, ch.id, { content: para(...texts) })
    return ch
  }
  const order = async () => {
    const view = await lib.getOutline(...ref)
    return view.outline.items.flatMap((i) => (i.type === 'arc' ? i.chapterIds : [i.id]))
  }
  return { ref, add, order }
}

describe('split, merge and duplicate chapters', () => {
  it('splits: the second part becomes the next chapter; the whole is kept in history', async () => {
    const { ref, add, order } = await story()
    const a = await add('Arrival', 'One.', 'Two.', 'Three.')
    const b = await add('Later', 'Four.')
    const second = await lib.splitChapter(...ref, a.id, para('One.'), para('Two.', 'Three.'))
    expect(await order()).toEqual([a.id, second.id, b.id])
    expect(second).toMatchObject({ title: 'Arrival (part 2)', content: para('Two.', 'Three.') })
    expect((await lib.readChapter(...ref, a.id)).content).toEqual(para('One.'))
    const history = await lib.listSnapshots(...ref, a.id)
    expect(history.some((s) => s.reason === 'before-split')).toBe(true)
  })

  it('splits inside an arc: the new chapter stays in the arc', async () => {
    const { ref, add } = await story()
    const arc = await lib.createArc({ seriesId: ref[0], volumeId: ref[1], name: 'Part One' })
    const arcId = arc.outline.items.find((i) => i.type === 'arc')!.id
    const a = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A', arcId })
    await lib.saveChapter(...ref, a.id, { content: para('x', 'y') })
    await add('Top level')
    const second = await lib.splitChapter(...ref, a.id, para('x'), para('y'))
    const view = await lib.getOutline(...ref)
    const inArc = view.outline.items.find((i) => i.type === 'arc')
    expect(inArc?.type === 'arc' && inArc.chapterIds).toEqual([a.id, second.id])
  })

  it('a failed split leaves the chapter whole', async () => {
    const { ref, add } = await story()
    const a = await add('A', 'One.', 'Two.')
    // The write of the new chapter fails: nothing has been taken from the old one.
    const spy = vi
      .spyOn(lib as unknown as { addChapterAfter: () => Promise<never> }, 'addChapterAfter')
      .mockRejectedValue(new Error('disk full'))
    await expect(lib.splitChapter(...ref, a.id, para('One.'), para('Two.'))).rejects.toThrow()
    spy.mockRestore()
    expect((await lib.readChapter(...ref, a.id)).content).toEqual(para('One.', 'Two.'))
  })

  it('merges the next chapter on (with a scene break); the joined one can be restored from the trash', async () => {
    const { ref, add, order } = await story()
    const a = await add('A', 'One.')
    const b = await add('B', 'Two.')
    await lib.saveChapter(...ref, b.id, { notes: 'B notes' })
    const c = await add('C', 'Three.')
    const merged = await lib.mergeNextChapter(...ref, a.id)
    expect(merged.content.content).toEqual([
      ...para('One.').content,
      { type: 'sceneBreak' },
      ...para('Two.').content,
    ])
    expect(merged.notes).toBe('B notes')
    expect(await order()).toEqual([a.id, c.id])
    const trash = await lib.listTrash()
    const entry = trash.find((t) => t.name === 'B')!
    expect(entry).toBeTruthy()
    await lib.restoreFromTrash(entry.id)
    expect((await lib.readChapter(...ref, b.id)).content).toEqual(para('Two.'))
    await expect(lib.mergeNextChapter(...ref, c.id)).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('duplicates a chapter right after it', async () => {
    const { ref, add, order } = await story()
    const a = await add('A', 'One.')
    const b = await add('B', 'Two.')
    const copy = await lib.duplicateChapter(...ref, a.id)
    expect(copy).toMatchObject({ title: 'A (copy)', content: para('One.') })
    expect(copy.id).not.toBe(a.id)
    expect(await order()).toEqual([a.id, copy.id, b.id])
  })
})
