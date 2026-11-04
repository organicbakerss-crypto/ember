import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LibraryChange } from '@shared/ipc'
import { Library } from '../library/library'
import { MemoryCloud } from './memoryCloud'
import { SyncEngine, type SyncHooks } from './engine'
import { SyncService } from './service'
import { DocLeases } from '../docLeases'

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

  it('AI conversations are kept with the story and come along to the other computer', async () => {
    const cloud = new MemoryCloud()
    const mac = await computer('Mac', cloud)
    const series = await mac.lib.createSeries({
      name: 'Saga',
      world: { mode: 'none' },
      kind: 'book',
    })
    const at = new Date().toISOString()
    await mac.lib.saveConversation(series.id, {
      formatVersion: 1,
      id: 'cnv_aaaaaaaaaaaaaaaa',
      mode: 'brainstorm',
      title: 'What could happen next?',
      createdAt: at,
      updatedAt: at,
      messages: [
        { role: 'user', content: 'What could happen next?', at, read: 'your selection, ~5 words' },
        { role: 'assistant', content: '1. A storm.', at, read: null },
      ],
    })
    await mac.sync()
    const linux = await computer('Linux', cloud)
    await linux.sync()
    const list = await linux.lib.listConversations(series.id)
    expect(list).toMatchObject([{ id: 'cnv_aaaaaaaaaaaaaaaa', mode: 'brainstorm', count: 2 }])
    const c = await linux.lib.readConversation(series.id, 'cnv_aaaaaaaaaaaaaaaa')
    expect(c.messages[1]!.content).toBe('1. A storm.')

    await linux.lib.deleteConversation(series.id, 'cnv_aaaaaaaaaaaaaaaa')
    expect(await linux.lib.listConversations(series.id)).toEqual([])
  })

  it('lists what was set aside, and puts it back on request', async () => {
    const cloud = new MemoryCloud()
    const mac = await computer('Mac', cloud)
    const series = await mac.lib.createSeries({
      name: 'Saga',
      world: { mode: 'new', name: 'Isles' },
    })
    const worldId = series.worldId!
    await mac.sync()
    const linux = await computer('Linux', cloud)
    await linux.sync()
    await mac.lib.renameWorld(worldId, 'Isles of Mac')
    await linux.lib.renameWorld(worldId, 'Isles of Linux')
    await mac.sync()
    await linux.sync()
    expect((await linux.lib.getWorld(worldId)).name).toBe('Isles of Linux')

    const service = new SyncService({
      userData: linux.lib.paths.localDir,
      leases: new DocLeases('yield'),
      secrets: { canEncrypt: () => false, encrypt: (t) => t, decrypt: (t) => t },
      onStatus: () => {},
      onNotice: () => {},
    })
    await service.attach(linux.lib)
    const [aside] = await service.conflicts()
    expect(aside).toMatchObject({ what: 'World settings', where: 'Isles of Linux', device: 'Mac' })
    await service.restoreConflict(aside!.id)
    expect((await linux.lib.getWorld(worldId)).name).toBe('Isles of Mac')
    // The version it replaced is set aside in turn.
    const now = await service.conflicts()
    expect(now).toHaveLength(1)
    expect(now[0]).toMatchObject({ reason: 'replaced', device: '' })
    await service.deleteConflict(now[0]!.id)
    expect(await service.conflicts()).toEqual([])
  })
})
