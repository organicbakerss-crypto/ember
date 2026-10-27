import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Library } from './library'

let root: string
let lib: Library

beforeEach(async () => {
  root = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'trash-')), 'lib')
  lib = await Library.open(root, { create: true })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.promises.rm(join(root, '..'), { recursive: true, force: true })
})

async function setup() {
  const series = await lib.createSeries({ name: 'Saga', world: { mode: 'new', name: 'Isles' } })
  const volume = await lib.createVolume({ seriesId: series.id, name: 'Book One' })
  const ref = { seriesId: series.id, volumeId: volume.id }
  const prologue = await lib.createChapter({ ...ref, title: 'Prologue' })
  const view = await lib.createArc({ ...ref, name: 'Arrival' })
  const arcId = view.outline.items[1]!.id
  const a = await lib.createChapter({ ...ref, title: 'A', arcId })
  const b = await lib.createChapter({ ...ref, title: 'B', arcId })
  const para = { type: 'paragraph', content: [{ type: 'text', text: 'Precious words.' }] }
  await lib.saveChapter(series.id, volume.id, a.id, { content: { type: 'doc', content: [para] } })
  return { series, volume, ref, prologue, arcId, a, b }
}

const ids = async (seriesId: string, volumeId: string) =>
  (await lib.getOutline(seriesId, volumeId)).outline.items.map((i) =>
    i.type === 'arc' ? `${i.name}[${i.chapterIds.join(',')}]` : i.id,
  )

describe('trash', () => {
  it('moves a chapter to the trash and restores it to the same place in its arc', async () => {
    const { series, volume, ref, prologue, a, b } = await setup()
    const entry = await lib.moveToTrash({ kind: 'chapter', ...ref, chapterId: a.id })
    expect(entry).toMatchObject({ kind: 'chapter', name: 'A', from: 'Saga › Book One' })
    expect(await ids(series.id, volume.id)).toEqual([prologue.id, `Arrival[${b.id}]`])
    expect(await lib.listTrash()).toEqual([entry])

    await lib.restoreFromTrash(entry.id)
    expect(await ids(series.id, volume.id)).toEqual([prologue.id, `Arrival[${a.id},${b.id}]`])
    expect((await lib.readChapter(series.id, volume.id, a.id)).content.content).toHaveLength(1)
    expect(await lib.listTrash()).toEqual([])
  })

  it('recreates a deleted arc when restoring one of its chapters', async () => {
    const { series, volume, ref, prologue, arcId, a, b } = await setup()
    await lib.deleteArc(series.id, volume.id, arcId, 'trash')
    expect(await ids(series.id, volume.id)).toEqual([prologue.id])
    const trashed = await lib.listTrash()
    expect(trashed.map((t) => t.name).sort()).toEqual(['A', 'B'])

    for (const t of trashed) await lib.restoreFromTrash(t.id)
    expect(await ids(series.id, volume.id)).toEqual([prologue.id, `Arrival[${a.id},${b.id}]`])
    expect(ref).toBeDefined()
  })

  it('deleting an arc can keep its chapters, moving them out where the arc was', async () => {
    const { series, volume, arcId, prologue, a, b } = await setup()
    await lib.createChapter({ seriesId: series.id, volumeId: volume.id, title: 'Epilogue' })
    const view = await lib.deleteArc(series.id, volume.id, arcId, 'keep')
    expect(view.outline.items.map((i) => i.id).slice(0, 3)).toEqual([prologue.id, a.id, b.id])
    expect(await lib.listTrash()).toEqual([])
  })

  it('trashes and restores a volume in its place in the series', async () => {
    const { series, volume } = await setup()
    const two = await lib.createVolume({ seriesId: series.id, name: 'Book Two' })
    const entry = await lib.moveToTrash({
      kind: 'volume',
      seriesId: series.id,
      volumeId: volume.id,
    })
    expect((await lib.getSeries(series.id)).volumeOrder).toEqual([two.id])
    expect(fs.existsSync(lib.paths.volumeDir(series.id, volume.id))).toBe(false)

    await lib.restoreFromTrash(entry.id)
    expect((await lib.getSeries(series.id)).volumeOrder).toEqual([volume.id, two.id])
    expect((await lib.volumeStats(series.id, volume.id)).sessionStartWords).toBe(2)
  })

  it('trashes a whole series and brings it back', async () => {
    const { series } = await setup()
    const entry = await lib.moveToTrash({ kind: 'series', seriesId: series.id })
    expect((await lib.snapshot()).series).toEqual([])
    await lib.restoreFromTrash(entry.id)
    const snap = await lib.snapshot()
    expect(snap.series.map((s) => s.name)).toEqual(['Saga'])
    expect(snap.series[0]!.volumes.map((v) => v.name)).toEqual(['Book One'])
  })

  it('unlinks a trashed world from its series, and relinks on restore', async () => {
    const { series } = await setup()
    const worldId = (await lib.getSeries(series.id)).worldId!
    const entry = await lib.moveToTrash({ kind: 'world', worldId })
    expect((await lib.getSeries(series.id)).worldId).toBeNull()
    await lib.restoreFromTrash(entry.id)
    expect((await lib.getSeries(series.id)).worldId).toBe(worldId)
  })

  it('refuses to restore a chapter whose volume is gone, and keeps it in the trash', async () => {
    const { series, volume, ref, a } = await setup()
    const chapter = await lib.moveToTrash({ kind: 'chapter', ...ref, chapterId: a.id })
    const vol = await lib.moveToTrash({ kind: 'volume', seriesId: series.id, volumeId: volume.id })
    await expect(lib.restoreFromTrash(chapter.id)).rejects.toMatchObject({ code: 'not-found' })
    expect((await lib.listTrash()).map((t) => t.id).sort()).toEqual([chapter.id, vol.id].sort())
    await lib.restoreFromTrash(vol.id)
    await lib.restoreFromTrash(chapter.id)
    expect((await lib.readChapter(series.id, volume.id, a.id)).title).toBe('A')
  })

  it('never overwrites something that now sits where the item was', async () => {
    const { series, ref, a } = await setup()
    const entry = await lib.moveToTrash({ kind: 'chapter', ...ref, chapterId: a.id })
    const path = join(lib.paths.chaptersDir(series.id, ref.volumeId), `${a.id}.json`)
    await fs.promises.writeFile(path, '{"someone": "else"}')
    await expect(lib.restoreFromTrash(entry.id)).rejects.toMatchObject({ code: 'conflict' })
    expect(await fs.promises.readFile(path, 'utf8')).toBe('{"someone": "else"}')
    expect(await lib.listTrash()).toHaveLength(1)
  })

  it('leaves the original in place if moving it to the trash fails', async () => {
    const { series, ref, a } = await setup()
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('disk on fire'))
    await expect(lib.moveToTrash({ kind: 'chapter', ...ref, chapterId: a.id })).rejects.toThrow(
      'disk on fire',
    )
    expect((await lib.readChapter(series.id, ref.volumeId, a.id)).title).toBe('A')
    expect(await lib.listTrash()).toEqual([])
    expect((await lib.getOutline(series.id, ref.volumeId)).outline.items).toHaveLength(2)
  })

  it('ignores a trash note whose content never arrived (crash mid-move)', async () => {
    await setup()
    const dir = join(lib.paths.localDir, 'trash', 'items', 'trs_0000000000000000')
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(join(dir, 'item.json'), '{}')
    expect(await lib.listTrash()).toEqual([])
  })

  it('erases one item or everything only when asked', async () => {
    const { ref, a, b } = await setup()
    const one = await lib.moveToTrash({ kind: 'chapter', ...ref, chapterId: a.id })
    await lib.moveToTrash({ kind: 'chapter', ...ref, chapterId: b.id })
    await lib.purgeTrash(one.id)
    expect((await lib.listTrash()).map((t) => t.name)).toEqual(['B'])
    await lib.emptyTrash()
    expect(await lib.listTrash()).toEqual([])
  })

  it('removes a trashed chapter from the volume manifest', async () => {
    const { series, ref, a } = await setup()
    await lib.moveToTrash({ kind: 'chapter', ...ref, chapterId: a.id })
    const manifest = JSON.parse(
      await fs.promises.readFile(
        join(lib.paths.volumeDir(series.id, ref.volumeId), 'manifest.json'),
        'utf8',
      ),
    )
    expect(manifest.files[`chapters/${a.id}.json`]).toBeUndefined()
  })
})

describe('renaming', () => {
  it('renames series and worlds without touching ids or folders', async () => {
    const { series } = await setup()
    const worldId = (await lib.getSeries(series.id)).worldId!
    const before = fs.readdirSync(join(root, 'series'))
    expect((await lib.renameSeries(series.id, '  New Saga ')).name).toBe('New Saga')
    expect((await lib.renameWorld(worldId, 'Archipelago')).name).toBe('Archipelago')
    expect(fs.readdirSync(join(root, 'series'))).toEqual(before)
    const snap = await lib.snapshot()
    expect(snap.series[0]!.name).toBe('New Saga')
    expect(snap.worlds[0]!.name).toBe('Archipelago')
  })
})
