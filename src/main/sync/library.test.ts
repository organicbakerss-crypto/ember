import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LibraryChange } from '@shared/ipc'
import { Library } from '../library/library'
import { MemoryCloud } from './memoryCloud'
import { SyncEngine, type SyncHooks } from './engine'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.promises.rm(d, { recursive: true, force: true })
})

/** A computer: a real library, and sync wired to it as the app does. */
async function computer(name: string, cloud: MemoryCloud) {
  const dir = await fs.promises.mkdtemp(join(os.tmpdir(), `synclib-${name}-`))
  dirs.push(dir)
  const changes: LibraryChange[] = []
  const notices: string[] = []
  const lib = await Library.open(join(dir, 'lib'), {
    create: true,
    onChange: (c) => changes.push(c),
  })
  const hooks: SyncHooks = {
    lock: (unit, task) => lib.lockUnit(unit, task),
    borrow: async () => () => {},
    beforeReplace: (unit, rel) => lib.keepBeforeSync(unit, rel),
    trashFile: (unit, rel) => lib.trashSyncedFile(unit, rel),
    trashUnit: (unit) => lib.trashSyncedUnit(unit),
    changed: (unit, rels, unitChanged) => void lib.syncedChanges(unit, rels, unitChanged),
    notice: (m) => notices.push(m),
  }
  const engine = new SyncEngine({
    root: lib.root,
    stateDir: join(lib.paths.localDir, 'sync'),
    cloud,
    device: name,
    hooks,
  })
  return { lib, engine, changes, notices, sync: () => engine.cycle() }
}

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const textOf = (content: unknown) => JSON.stringify(content).match(/"text":"([^"]*)"/)?.[1]

describe('sync with real libraries', () => {
  it('carries a series, its world and chapters to a new computer', async () => {
    const cloud = new MemoryCloud()
    const mac = await computer('Mac', cloud)
    const series = await mac.lib.createSeries({
      name: 'Saga',
      world: { mode: 'new', name: 'Isles' },
    })
    const volume = await mac.lib.createVolume({ seriesId: series.id, name: 'Book One' })
    const ch = await mac.lib.createChapter({
      seriesId: series.id,
      volumeId: volume.id,
      title: 'Arrival',
    })
    await mac.lib.saveChapter(series.id, volume.id, ch.id, { content: doc('Mara ran.') })
    await mac.lib.world.createEntry(series.worldId!, { name: 'Mara', template: 'person' })
    await mac.sync()

    const linux = await computer('Linux', cloud)
    await linux.sync()
    const snap = await linux.lib.snapshot()
    expect(snap.series.map((s) => s.name)).toEqual(['Saga'])
    expect(snap.series[0]!.volumes.map((v) => v.name)).toEqual(['Book One'])
    expect(snap.worlds.map((w) => w.name)).toEqual(['Isles'])
    const read = await linux.lib.readChapter(series.id, volume.id, ch.id)
    expect(textOf(read.content)).toBe('Mara ran.')
    expect((await linux.lib.world.view(series.worldId!)).entries.map((e) => e.name)).toContain(
      'Mara',
    )
    expect(linux.changes).toContainEqual({ kind: 'library' })
    expect(linux.changes).toContainEqual({
      kind: 'chapter',
      seriesId: series.id,
      volumeId: volume.id,
      chapterId: ch.id,
    })
  })

  it('keeps the replaced version in history, and a conflict copy in the binder', async () => {
    const cloud = new MemoryCloud()
    const mac = await computer('Mac', cloud)
    const series = await mac.lib.createSeries({ name: 'Saga', world: { mode: 'none' } })
    const volume = await mac.lib.createVolume({ seriesId: series.id, name: 'One' })
    const ref = { seriesId: series.id, volumeId: volume.id }
    const ch = await mac.lib.createChapter({ ...ref, title: 'Arrival' })
    await mac.lib.saveChapter(series.id, volume.id, ch.id, { content: doc('first') })
    await mac.sync()
    const linux = await computer('Linux', cloud)
    await linux.sync()

    await mac.lib.saveChapter(series.id, volume.id, ch.id, { content: doc('second, from Mac') })
    await mac.sync()
    await linux.sync()
    const history = await linux.lib.listSnapshots(series.id, volume.id, ch.id)
    expect(history.some((s) => s.reason === 'before-sync')).toBe(true)

    await mac.lib.saveChapter(series.id, volume.id, ch.id, { content: doc('Mac version') })
    await linux.lib.saveChapter(series.id, volume.id, ch.id, { content: doc('Linux version') })
    await mac.sync()
    await linux.sync()
    await mac.sync()
    for (const c of [mac, linux]) {
      const view = await c.lib.getOutline(series.id, volume.id)
      const titles = Object.values(view.chapters).map((x) => x.title)
      expect(titles).toHaveLength(2)
      expect(titles.find((t) => t.startsWith('Arrival (copy from Mac'))).toBeTruthy()
      expect(textOf((await c.lib.readChapter(series.id, volume.id, ch.id)).content)).toBe(
        'Linux version',
      )
    }
    expect(linux.notices[0]).toMatch(/changed on both computers/)
  })

  it('puts chapters and volumes deleted elsewhere in the trash, ready to restore', async () => {
    const cloud = new MemoryCloud()
    const mac = await computer('Mac', cloud)
    const series = await mac.lib.createSeries({ name: 'Saga', world: { mode: 'none' } })
    const one = await mac.lib.createVolume({ seriesId: series.id, name: 'One' })
    const two = await mac.lib.createVolume({ seriesId: series.id, name: 'Two' })
    const ch = await mac.lib.createChapter({
      seriesId: series.id,
      volumeId: one.id,
      title: 'Doomed',
    })
    await mac.sync()
    const linux = await computer('Linux', cloud)
    await linux.sync()

    await mac.lib.moveToTrash({
      kind: 'chapter',
      seriesId: series.id,
      volumeId: one.id,
      chapterId: ch.id,
    })
    await mac.lib.moveToTrash({ kind: 'volume', seriesId: series.id, volumeId: two.id })
    await mac.sync()
    await linux.sync()
    const trash = await linux.lib.listTrash()
    expect(trash.map((t) => `${t.kind}:${t.name}`).sort()).toEqual(['chapter:Doomed', 'volume:Two'])
    const snap = await linux.lib.snapshot()
    expect(snap.series[0]!.volumes.map((v) => v.name)).toEqual(['One'])
    expect(Object.keys((await linux.lib.getOutline(series.id, one.id)).chapters)).toEqual([])

    // Restored on Linux: back on the Mac too.
    await linux.lib.restoreFromTrash(trash.find((t) => t.kind === 'chapter')!.id)
    await linux.lib.restoreFromTrash(trash.find((t) => t.kind === 'volume')!.id)
    await linux.sync()
    await mac.sync()
    const back = await mac.lib.snapshot()
    expect(back.series[0]!.volumes.map((v) => v.name).sort()).toEqual(['One', 'Two'])
    expect(
      Object.values((await mac.lib.getOutline(series.id, one.id)).chapters).map((c) => c.title),
    ).toEqual(['Doomed'])
  })
})
