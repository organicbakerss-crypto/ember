import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library } from './library'

let root: string
let lib: Library
let clock: Date

const para = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})
const minutes = (n: number) => {
  clock = new Date(clock.getTime() + n * 60_000)
}

beforeEach(async () => {
  root = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'history-')), 'lib')
  clock = new Date('2026-10-27T09:00:00.000Z')
  lib = await Library.open(root, { create: true, now: () => clock })
})
afterEach(async () => {
  await fs.promises.rm(join(root, '..'), { recursive: true, force: true })
})

async function chapter() {
  const series = await lib.createSeries({ name: 'S', world: { mode: 'none' } })
  const volume = await lib.createVolume({ seriesId: series.id, name: 'V' })
  const ch = await lib.createChapter({ seriesId: series.id, volumeId: volume.id, title: 'One' })
  const ref = [series.id, volume.id, ch.id] as const
  return { ref, save: (text: string) => lib.saveChapter(...ref, { content: para(text) }) }
}

describe('version history', () => {
  it('keeps the version being replaced, at most every ten minutes', async () => {
    const { ref, save } = await chapter()
    await save('draft one') // snapshots the empty starting version
    minutes(2)
    await save('draft two') // too soon: no snapshot
    minutes(11)
    await save('draft three') // snapshots "draft two"
    const list = await lib.listSnapshots(...ref)
    expect(list.map((s) => s.wordCount)).toEqual([2, 0])
    expect(list.every((s) => s.reason === 'auto')).toBe(true)
  })

  it('skips a snapshot when nothing changed since the last one', async () => {
    const { ref, save } = await chapter()
    await save('same')
    minutes(15)
    await save('same')
    minutes(15)
    await save('same')
    expect(await lib.listSnapshots(...ref)).toHaveLength(2)
  })

  it('does not snapshot saves that only change the title or POV', async () => {
    const { ref } = await chapter()
    await lib.saveChapter(...ref, { title: 'Renamed', pov: 'Mara' })
    expect(await lib.listSnapshots(...ref)).toEqual([])
  })

  it('restores an earlier version and keeps the current one in history', async () => {
    const { ref, save } = await chapter()
    await save('the original sentence')
    minutes(11)
    await save('a rewrite I regret')
    const [original] = await lib.listSnapshots(...ref)
    const { content } = await lib.readSnapshot(...ref, original!.id)
    expect(JSON.stringify(content)).toContain('the original sentence')

    minutes(1)
    const restored = await lib.restoreSnapshot(...ref, original!.id)
    expect(JSON.stringify(restored.content)).toContain('the original sentence')
    expect(JSON.stringify((await lib.readChapter(...ref)).content)).toContain(
      'the original sentence',
    )
    const list = await lib.listSnapshots(...ref)
    expect(list[0]).toMatchObject({ reason: 'before-restore', wordCount: 4 })
  })

  it('prunes old snapshots by the retention rules', async () => {
    const { ref, save } = await chapter()
    // One save every 6 hours for 30 days: snapshots older than 14 days thin out to one per day.
    for (let i = 0; i < 120; i++) {
      await save(`version ${i}`)
      minutes(6 * 60)
    }
    const list = await lib.listSnapshots(...ref)
    const recent = list.filter((s) => clock.getTime() - Date.parse(s.savedAt) <= 14 * 86400_000)
    const older = list.filter((s) => clock.getTime() - Date.parse(s.savedAt) > 14 * 86400_000)
    expect(recent.length).toBeGreaterThanOrEqual(55)
    const days = new Set(older.map((s) => s.savedAt.slice(0, 10)))
    expect(older.length).toBe(days.size)
  })

  it('skips an unreadable snapshot instead of failing', async () => {
    const { ref, save } = await chapter()
    await save('one')
    const dir = join(lib.paths.localDir, 'history', ref[1], ref[2])
    await fs.promises.writeFile(join(dir, '2026-10-27T08-00-00-000Z-abcdef.json'), 'garbage')
    expect(await lib.listSnapshots(...ref)).toHaveLength(1)
  })

  it('stores history in the device-only folder, outside the synced volume', async () => {
    const { ref, save } = await chapter()
    await save('one')
    expect(fs.existsSync(join(lib.paths.localDir, 'history', ref[1], ref[2]))).toBe(true)
    const volumeFiles = await fs.promises.readdir(lib.paths.volumeDir(ref[0], ref[1]), {
      recursive: true,
    })
    expect(volumeFiles.some((f) => String(f).includes('history'))).toBe(false)
  })

  it('keeps the version before a big deletion, even right after another snapshot', async () => {
    // The reported case: type a line, wait a couple of minutes, delete it.
    const { ref, save } = await chapter()
    await save('Opening line.')
    minutes(1)
    await save('Opening line. aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    minutes(2)
    await save('Opening line.')
    const [latest] = await lib.listSnapshots(...ref)
    expect(latest!.reason).toBe('before-deletion')
    const { content } = await lib.readSnapshot(...ref, latest!.id)
    expect(JSON.stringify(content)).toContain('aaaaaaaaaa')
  })

  it('does not treat small corrections as big deletions', async () => {
    const { ref, save } = await chapter()
    await save('The storm came in from the west.')
    minutes(1)
    await save('The storm came in from the east.')
    minutes(1)
    await save('The storm came from the east.')
    expect((await lib.listSnapshots(...ref)).map((s) => s.reason)).toEqual(['auto'])
  })

  it('keeps a version on request', async () => {
    const { ref, save } = await chapter()
    await save('Worth keeping.')
    minutes(1)
    await lib.keepSnapshot(...ref)
    const [latest] = await lib.listSnapshots(...ref)
    expect(latest).toMatchObject({ reason: 'manual', wordCount: 2 })
  })
})
