import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '../fs/atomicWrite'
import { MemoryCloud } from './memoryCloud'
import { basicHooks, BLOBS_PREFIX, SyncEngine } from './engine'
import { cleanUpCloud } from './cleanup'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const VOLUME = 'series/ser_a/volumes/vol_a'
const DAY = 86_400_000

function device(cloud: MemoryCloud) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'cleanup-'))
  dirs.push(root)
  const stateDir = join(root, '.local', 'sync')
  const engine = new SyncEngine({
    root,
    stateDir,
    cloud,
    device: 'A',
    hooks: basicHooks(root, stateDir),
  })
  const write = async (rel: string, text: string) => {
    await fs.promises.mkdir(join(root, VOLUME, 'chapters'), { recursive: true })
    await writeFileAtomic(join(root, VOLUME, rel), text)
  }
  return { root, engine, write }
}

describe('cloud clean-up', () => {
  it('deletes old copies nothing uses, keeps current and recent ones', async () => {
    let now = new Date('2026-01-01T00:00:00Z').getTime()
    const cloud = new MemoryCloud(() => new Date(now))
    const a = device(cloud)
    await a.write('chapters/c1.json', 'v1')
    await a.engine.cycle()
    now += 10 * DAY
    await a.write('chapters/c1.json', 'v2')
    await a.engine.cycle()
    now += 25 * DAY
    await a.write('chapters/c1.json', 'v3')
    await a.engine.cycle()
    expect([...cloud.objects.keys()].filter((k) => k.startsWith(BLOBS_PREFIX))).toHaveLength(3)

    // v1 is 35 days old and unused: gone. v2 is unused but only 25 days old: kept. v3 is current.
    const r = await cleanUpCloud(cloud, a.root, new Date(now))
    expect(r.deleted).toBe(1)
    expect([...cloud.objects.keys()].filter((k) => k.startsWith(BLOBS_PREFIX))).toHaveLength(2)

    // Everything still downloads on a new computer.
    const b = device(cloud)
    await b.engine.cycle()
    expect(fs.readFileSync(join(b.root, VOLUME, 'chapters/c1.json'), 'utf8')).toBe('v3')
  })

  it('an old copy used again is refreshed, and a missing one is put back', async () => {
    let now = new Date('2026-01-01T00:00:00Z').getTime()
    const cloud = new MemoryCloud(() => new Date(now))
    const a = device(cloud)
    await a.write('chapters/c1.json', 'same words')
    await a.engine.cycle()
    await a.write('chapters/c1.json', 'other words')
    await a.engine.cycle()
    now += 60 * DAY
    // Back to the old text (an undo): its old copy is written again, so it counts as new.
    await a.write('chapters/c1.json', 'same words')
    await a.engine.cycle()
    expect((await cleanUpCloud(cloud, a.root, new Date(now))).deleted).toBe(1)

    // A copy lost in the cloud comes back from this computer.
    for (const k of [...cloud.objects.keys()])
      if (k.startsWith(BLOBS_PREFIX)) cloud.objects.delete(k)
    expect((await cleanUpCloud(cloud, a.root, new Date(now))).repaired).toBe(1)
    const b = device(cloud)
    await b.engine.cycle()
    expect(fs.readFileSync(join(b.root, VOLUME, 'chapters/c1.json'), 'utf8')).toBe('same words')
  })
})
