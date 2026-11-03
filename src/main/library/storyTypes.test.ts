import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library } from './library'
import { buildManuscript } from '../export/service'

let root: string
let lib: Library
beforeEach(async () => {
  root = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'kinds-')), 'lib')
  lib = await Library.open(root, { create: true })
})
afterEach(async () => {
  await fs.promises.rm(join(root, '..'), { recursive: true, force: true })
})

describe('story types', () => {
  it('a single book is made with its one volume, and keeps one name', async () => {
    const book = await lib.createSeries({
      name: 'Tidewater',
      world: { mode: 'none' },
      kind: 'book',
    })
    let snap = await lib.snapshot()
    const s = snap.series[0]!
    expect(s.kind).toBe('book')
    expect(s.worldId).toBeNull()
    expect(s.volumes.map((v) => v.name)).toEqual(['Tidewater'])

    await lib.renameSeries(book.id, 'Low Tide')
    snap = await lib.snapshot()
    expect(snap.series[0]!.volumes[0]!.name).toBe('Low Tide')
    await lib.updateVolume(book.id, s.volumes[0]!.id, { name: 'High Tide' })
    expect((await lib.getSeries(book.id)).name).toBe('High Tide')

    // A second volume makes it a series.
    await lib.createVolume({ seriesId: book.id, name: 'Book Two' })
    expect((await lib.getSeries(book.id)).kind).toBe('series')
  })

  it('old series files read as series; a book becomes a series and back', async () => {
    const series = await lib.createSeries({ name: 'Saga', world: { mode: 'none' } })
    const file = join(root, 'series', series.id, 'series.json')
    const raw = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>
    delete raw['kind']
    await fs.promises.writeFile(file, JSON.stringify(raw))
    expect((await lib.getSeries(series.id)).kind).toBe('series')

    // A series with no volume becomes a book with one.
    await lib.setSeriesKind(series.id, 'book')
    expect((await lib.snapshot()).series[0]!.volumes).toHaveLength(1)
    await lib.setSeriesKind(series.id, 'series')
    await lib.createVolume({ seriesId: series.id, name: 'Two' })
    await expect(lib.setSeriesKind(series.id, 'book')).rejects.toThrow(/one volume/)
  })

  it('worlds can be unlinked, and turn their map, board and timeline off', async () => {
    const series = await lib.createSeries({ name: 'Saga', world: { mode: 'new', name: 'Isles' } })
    const worldId = series.worldId!
    expect((await lib.getWorld(worldId)).features).toEqual({
      map: true,
      board: true,
      timeline: true,
    })
    await lib.setSeriesWorld(series.id, null)
    expect((await lib.getSeries(series.id)).worldId).toBeNull()
    expect((await lib.snapshot()).worlds.map((w) => w.name)).toEqual(['Isles'])

    await lib.setWorldFeatures(worldId, { map: false, timeline: false })
    expect((await lib.getWorld(worldId)).features).toEqual({
      map: false,
      board: true,
      timeline: false,
    })
  })

  it('a book can choose its own chapter headings for export', async () => {
    const book = await lib.createSeries({ name: 'Stories', world: { mode: 'none' }, kind: 'book' })
    const volumeId = (await lib.snapshot()).series[0]!.volumes[0]!.id
    await lib.createChapter({ seriesId: book.id, volumeId, title: 'The Fox' })
    expect((await buildManuscript(lib, book.id, volumeId, '')).headings).toBeNull()
    await lib.updateVolume(book.id, volumeId, { settings: { headings: 'title' } })
    expect((await buildManuscript(lib, book.id, volumeId, '')).headings).toBe('title')
    expect((await lib.getVolume(book.id, volumeId)).settings).toEqual({ headings: 'title' })
  })

  it('measures the library by kind, and marks a book finished', async () => {
    const book = await lib.createSeries({
      name: 'Done',
      world: { mode: 'new', name: 'W' },
      kind: 'book',
    })
    const volumeId = (await lib.snapshot()).series[0]!.volumes[0]!.id
    const ch = await lib.createChapter({ seriesId: book.id, volumeId, title: 'One' })
    await lib.keepSnapshot(book.id, volumeId, ch.id)
    await fs.promises.mkdir(join(root, 'worlds', book.worldId!, 'images'), { recursive: true })
    await fs.promises.writeFile(
      join(root, 'worlds', book.worldId!, 'images', 'a.png'),
      Buffer.alloc(5000),
    )
    const size = await lib.diskUsage()
    expect(size.images).toBe(5000)
    expect(size.writing).toBeGreaterThan(0)
    expect(size.history).toBeGreaterThan(0)
    expect(size.total).toBe(size.writing + size.images + size.history + size.trash + size.other)

    const done = await lib.setVolumeFinished(book.id, volumeId, true)
    expect(done.settings['finished']).toBe(true)
    expect((await lib.listSnapshots(book.id, volumeId, ch.id)).length).toBeGreaterThan(0)
  })

  it('reading never writes: looking at old volumes changes no file, so sync sends nothing', async () => {
    const series = await lib.createSeries({ name: 'Saga', world: { mode: 'new', name: 'Isles' } })
    const one = await lib.createVolume({ seriesId: series.id, name: 'One' })
    const ch = await lib.createChapter({ seriesId: series.id, volumeId: one.id, title: 'A' })
    await lib.saveChapter(series.id, one.id, ch.id, {
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old words.' }] }],
      },
    })
    await lib.world.createEntry(series.worldId!, { name: 'Mara', template: 'person' })
    const files = async () => {
      const out: Record<string, string> = {}
      for (const e of await fs.promises.readdir(root, { recursive: true, withFileTypes: true })) {
        if (!e.isFile()) continue
        const full = join(e.parentPath, e.name)
        if (full.startsWith(lib.paths.localDir)) continue
        out[full] = (await fs.promises.readFile(full)).toString('base64')
      }
      return out
    }
    const before = await files()
    expect(Object.keys(before).length).toBeGreaterThan(5)
    await lib.snapshot()
    await lib.getOutline(series.id, one.id)
    await lib.readChapter(series.id, one.id, ch.id)
    await lib.listSnapshots(series.id, one.id, ch.id)
    await lib.volumeStats(series.id, one.id)
    await lib.world.view(series.worldId!)
    await lib.world.index(series.worldId!)
    await lib.diskUsage()
    expect(await files()).toEqual(before)
  })
})
