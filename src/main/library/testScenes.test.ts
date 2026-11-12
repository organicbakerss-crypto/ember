import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library } from './library'
import { mergeFile } from '../sync/merge'

let root: string
let lib: Library

beforeEach(async () => {
  root = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'tests-')), 'lib')
  lib = await Library.open(root, { create: true })
})
afterEach(async () => {
  await fs.promises.rm(join(root, '..'), { recursive: true, force: true })
})

async function story() {
  const series = await lib.createSeries({ name: 'S', world: { mode: 'none' } })
  const vol = await lib.createVolume({ seriesId: series.id, name: 'V' })
  const ref = [series.id, vol.id] as const
  const a = await lib.createChapter({ seriesId: series.id, volumeId: vol.id, title: 'A' })
  const b = await lib.createChapter({ seriesId: series.id, volumeId: vol.id, title: 'B' })
  const order = async () => {
    const view = await lib.getOutline(...ref)
    return {
      order: view.outline.items.flatMap((i) => (i.type === 'arc' ? i.chapterIds : [i.id])),
      tests: view.outline.tests,
      problems: view.problems,
    }
  }
  return { series, vol, ref, a, b, order }
}

describe('test scenes', () => {
  it('can stand on their own, kept with no chapter', async () => {
    const { series, vol, a, b, order } = await story()
    const t = await lib.createChapter({
      seriesId: series.id,
      volumeId: vol.id,
      title: '',
      looseTest: true,
    })
    const o = await order()
    expect(o.order).toEqual([a.id, b.id])
    expect(o.tests).toEqual([{ id: t.id, chapterId: null }])
  })

  it('are kept with a chapter, outside the reading order and exports', async () => {
    const { series, vol, ref, a, b, order } = await story()
    const t = await lib.createChapter({
      seriesId: series.id,
      volumeId: vol.id,
      title: 'Take two',
      testOf: a.id,
    })
    const o = await order()
    expect(o.order).toEqual([a.id, b.id])
    expect(o.tests).toEqual([{ id: t.id, chapterId: a.id }])
    expect(o.problems).toEqual([])
    const exp = await lib.chaptersForExport(...ref)
    expect(exp.chapters.map((c) => c.id)).toEqual([a.id, b.id])
    // A reorder from the binder keeps them (the outline lists them).
    const view = await lib.getOutline(...ref)
    await lib.saveOutline(...ref, { ...view.outline, items: [...view.outline.items].reverse() })
    expect((await order()).tests).toEqual([{ id: t.id, chapterId: a.id }])
  })

  it('turn into chapters and back', async () => {
    const { series, vol, ref, a, b, order } = await story()
    const t = await lib.createChapter({
      seriesId: series.id,
      volumeId: vol.id,
      title: 'T',
      testOf: a.id,
    })
    await lib.setTest(...ref, t.id, null)
    expect((await order()).order).toEqual([a.id, t.id, b.id])
    expect((await order()).tests).toEqual([])
    await lib.setTest(...ref, b.id, a.id)
    expect((await order()).order).toEqual([a.id, t.id])
    expect((await order()).tests).toEqual([{ id: b.id, chapterId: a.id }])
  })

  it('come back as test scenes from the trash; a trashed chapter leaves its tests loose', async () => {
    const { series, vol, ref, a, order } = await story()
    const t = await lib.createChapter({
      seriesId: series.id,
      volumeId: vol.id,
      title: 'T',
      testOf: a.id,
    })
    const trashed = await lib.moveToTrash({
      kind: 'chapter',
      seriesId: ref[0],
      volumeId: ref[1],
      chapterId: t.id,
    })
    expect((await order()).tests).toEqual([])
    await lib.restoreFromTrash(trashed.id)
    expect((await order()).tests).toEqual([{ id: t.id, chapterId: a.id }])
    const gone = await lib.moveToTrash({
      kind: 'chapter',
      seriesId: ref[0],
      volumeId: ref[1],
      chapterId: a.id,
    })
    const o = await order()
    expect(o.tests).toEqual([{ id: t.id, chapterId: a.id }])
    expect(o.problems).toEqual([])
    await lib.restoreFromTrash(gone.id)
    expect((await order()).order[0]).toBe(a.id)
  })

  it('a sync merge keeps a test that became a chapter on one side as a chapter', () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))
    const base = {
      formatVersion: 1,
      volumeId: 'vol_x',
      items: [{ type: 'chapter', id: 'chp_a' }],
      tests: [{ id: 'chp_t', chapterId: 'chp_a' }],
    }
    const mine = { ...base, items: [...base.items, { type: 'chapter', id: 'chp_t' }], tests: [] }
    const theirs = {
      ...base,
      items: [...base.items, { type: 'chapter', id: 'chp_b' }],
      tests: [...base.tests, { id: 'chp_u', chapterId: 'chp_a' }],
    }
    const merged = mergeFile(
      'series/ser_x/volumes/vol_x',
      'outline.json',
      enc(base),
      enc(mine),
      enc(theirs),
      {
        device: 'x',
      },
    )
    const out = JSON.parse(new TextDecoder().decode(merged!.bytes))
    const ids = out.items.map((i: { id: string }) => i.id)
    expect(ids).toContain('chp_t')
    expect(out.tests.map((t: { id: string }) => t.id)).toEqual(['chp_u'])
  })
})
