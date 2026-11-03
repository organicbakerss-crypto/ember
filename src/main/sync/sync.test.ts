import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { newId } from '@shared/ids'
import { writeFileAtomic } from '../fs/atomicWrite'
import { MemoryCloud, type Fault } from './memoryCloud'
import { basicHooks, SyncEngine, UNITS_PREFIX, type SyncHooks } from './engine'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const SERIES = 'series/ser_aaaaaaaaaaaaaaaa'
const VOLUME = `${SERIES}/volumes/vol_aaaaaaaaaaaaaaaa`
const WORLD = 'worlds/wld_aaaaaaaaaaaaaaaa'

class Device {
  readonly root: string
  readonly stateDir: string
  engine!: SyncEngine
  notices: string[] = []
  /** Hook overrides for a test. */
  extra: Partial<SyncHooks> = {}

  constructor(
    readonly name: string,
    readonly cloud: MemoryCloud,
  ) {
    this.root = fs.mkdtempSync(join(os.tmpdir(), `sync-${name}-`))
    dirs.push(this.root)
    this.stateDir = join(this.root, '.local', 'sync')
    this.restart()
  }

  /** A fresh engine on the same folders (as after the app was killed). */
  restart() {
    const basic = basicHooks(this.root, this.stateDir)
    const hooks: SyncHooks = {
      ...basic,
      notice: (m) => this.notices.push(m),
      borrow: (unit, rels) => (this.extra.borrow ?? basic.borrow)(unit, rels),
      beforeReplace: (unit, rel) => (this.extra.beforeReplace ?? basic.beforeReplace)(unit, rel),
    }
    this.engine = new SyncEngine({
      root: this.root,
      stateDir: this.stateDir,
      cloud: this.cloud,
      device: this.name,
      hooks,
    })
  }

  path(unit: string, rel: string) {
    return join(this.root, unit, rel)
  }
  async write(unit: string, rel: string, text: string) {
    const path = this.path(unit, rel)
    await fs.promises.mkdir(join(path, '..'), { recursive: true })
    await writeFileAtomic(path, text)
  }
  read(unit: string, rel: string): string | null {
    try {
      return fs.readFileSync(this.path(unit, rel), 'utf8')
    } catch {
      return null
    }
  }
  remove(unit: string, rel: string) {
    fs.rmSync(this.path(unit, rel), { force: true })
  }
  sync() {
    return this.engine.cycle()
  }
  /** Every synced file (unit/rel → text), device folder left out. */
  files(): Record<string, string> {
    const out: Record<string, string> = {}
    const walk = (dir: string, prefix: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full, `${prefix}${e.name}/`)
        else out[`${prefix}${e.name}`] = fs.readFileSync(full, 'utf8')
      }
    }
    walk(this.root, '')
    return out
  }
  /** All text anywhere on this device, the trash and set-aside conflicts included. */
  everything(): string {
    const parts: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else parts.push(fs.readFileSync(full, 'utf8'))
      }
    }
    walk(this.root)
    return parts.join('\n')
  }
}

const chapter = (id: string, text: string) =>
  `${JSON.stringify({ formatVersion: 1, id, title: 'Ch', text }, null, 2)}\n`

describe('sync between two computers', () => {
  it('sends a new volume to the other computer, then edits both ways', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    const b = new Device('B', cloud)
    await a.write(SERIES, 'series.json', '{"name":"Saga"}')
    await a.write(VOLUME, 'volume.json', '{"name":"One"}')
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'first draft'))
    await a.write(VOLUME, 'manifest.json', 'local only')
    await a.write(WORLD, 'images/abc.png', 'png bytes')
    const up = await a.sync()
    expect(up.uploaded).toBe(4)
    expect([...cloud.objects.keys()].filter((k) => k.startsWith(UNITS_PREFIX)).length).toBe(3)

    const down = await b.sync()
    expect(down.downloaded).toBe(4)
    expect(b.read(VOLUME, 'chapters/chp_1.json')).toContain('first draft')
    expect(b.read(VOLUME, 'manifest.json')).toBeNull()

    // Nothing changed: one listing, nothing else.
    const before = cloud.requests
    await a.sync()
    expect(cloud.requests - before).toBe(1)

    await b.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'edited on B'))
    await b.sync()
    await a.sync()
    expect(a.read(VOLUME, 'chapters/chp_1.json')).toContain('edited on B')
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'edited on A'))
    await a.sync()
    await b.sync()
    expect(b.read(VOLUME, 'chapters/chp_1.json')).toContain('edited on A')
    expect(a.notices).toEqual([])
  })

  it('keeps both versions when a chapter changed on both computers', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('Mac', cloud)
    const b = new Device('Linux', cloud)
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'start'))
    await a.sync()
    await b.sync()
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'Mac words'))
    await b.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'Linux words'))
    await a.sync()
    const report = await b.sync()
    expect(report.conflicts).toBe(1)
    // B keeps its own text where it was, and the other one beside it.
    expect(b.read(VOLUME, 'chapters/chp_1.json')).toContain('Linux words')
    const copies = Object.entries(b.files()).filter(([p]) => p.startsWith(`${VOLUME}/chapters/`))
    expect(copies).toHaveLength(2)
    const copy = copies.find(([p]) => !p.endsWith('chp_1.json'))!
    const parsed = JSON.parse(copy[1]) as { id: string; title: string; text: string }
    expect(parsed.text).toBe('Mac words')
    expect(parsed.title).toMatch(/^Ch \(copy from Mac, \d{4}-\d\d-\d\d \d\d:\d\d\)$/)
    expect(copy[0]).toBe(`${VOLUME}/chapters/${parsed.id}.json`)
    expect(b.notices[0]).toContain('changed on both computers')

    await a.sync()
    expect(a.files()).toEqual(b.files())
  })

  it('keeps this computer’s version of other files and sets the other aside', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    const b = new Device('B', cloud)
    await a.write(VOLUME, 'outline.json', '{"items":[]}')
    await a.sync()
    await b.sync()
    await a.write(VOLUME, 'outline.json', '{"items":["from A"]}')
    await b.write(VOLUME, 'outline.json', '{"items":["from B"]}')
    await a.sync()
    await b.sync()
    expect(b.read(VOLUME, 'outline.json')).toContain('from B')
    expect(b.everything()).toContain('from A')
    await a.sync()
    expect(a.read(VOLUME, 'outline.json')).toContain('from B')
  })

  it('moves a file deleted on one computer to the other’s trash', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    const b = new Device('B', cloud)
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'doomed'))
    await a.write(VOLUME, 'chapters/chp_2.json', chapter('chp_2', 'kept'))
    await a.sync()
    await b.sync()
    a.remove(VOLUME, 'chapters/chp_1.json')
    await a.sync()
    const r = await b.sync()
    expect(r.removed).toBe(1)
    expect(b.read(VOLUME, 'chapters/chp_1.json')).toBeNull()
    expect(b.everything()).toContain('doomed')
    expect(b.read(VOLUME, 'chapters/chp_2.json')).toContain('kept')
  })

  it('brings back a file deleted on one computer but edited on the other', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    const b = new Device('B', cloud)
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'v1'))
    await a.sync()
    await b.sync()
    a.remove(VOLUME, 'chapters/chp_1.json')
    await b.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'edited after the delete'))
    await a.sync()
    await b.sync()
    await a.sync()
    expect(a.read(VOLUME, 'chapters/chp_1.json')).toContain('edited after the delete')
    expect(b.read(VOLUME, 'chapters/chp_1.json')).toContain('edited after the delete')

    // The other way round: deleted here after an edit there.
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'A edits'))
    b.remove(VOLUME, 'chapters/chp_1.json')
    await a.sync()
    await b.sync()
    expect(b.read(VOLUME, 'chapters/chp_1.json')).toContain('A edits')
  })

  it('deletes a whole volume on the other computer, unless it changed there', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    const b = new Device('B', cloud)
    await a.write(VOLUME, 'volume.json', '{}')
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'gone soon'))
    await a.sync()
    await b.sync()
    fs.rmSync(join(a.root, VOLUME), { recursive: true })
    await a.sync()
    await b.sync()
    expect(fs.existsSync(join(b.root, VOLUME))).toBe(false)
    expect(b.everything()).toContain('gone soon')

    // Restored from the trash on B: it comes back on A.
    await b.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'restored'))
    await b.sync()
    await a.sync()
    expect(a.read(VOLUME, 'chapters/chp_1.json')).toContain('restored')

    // Deleted on A while B was editing it: B keeps it and A gets it back.
    fs.rmSync(join(a.root, VOLUME), { recursive: true })
    await b.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'still writing'))
    await a.sync()
    await b.sync()
    await a.sync()
    expect(a.read(VOLUME, 'chapters/chp_1.json')).toContain('still writing')
  })

  it('a deleted series takes its volumes with it, unless one changed', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    const b = new Device('B', cloud)
    await a.write(SERIES, 'series.json', '{}')
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'x'))
    await a.sync()
    await b.sync()
    fs.rmSync(join(a.root, SERIES), { recursive: true })
    await a.sync()
    await b.sync()
    expect(fs.existsSync(join(b.root, SERIES))).toBe(false)
    expect(b.everything()).toContain('"text": "x"')
  })

  it('a reply lost after the cloud saved is no conflict', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    const b = new Device('B', cloud)
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'one'))
    await a.sync()
    await b.sync()
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'two'))
    cloud.fault = (op, key) => (op === 'put' && key.startsWith(UNITS_PREFIX) ? 'lose-reply' : null)
    await expect(a.sync()).rejects.toThrow(/connection lost/)
    cloud.fault = () => null
    a.restart()
    const r = await a.sync()
    expect(r.conflicts).toBe(0)
    await b.sync()
    expect(b.read(VOLUME, 'chapters/chp_1.json')).toContain('two')
    expect(Object.keys(b.files())).toHaveLength(1)
  })

  it('a damaged state file costs nothing but a careful re-check', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    await a.write(VOLUME, 'chapters/chp_1.json', chapter('chp_1', 'same'))
    await a.write(VOLUME, 'chapters/chp_2.json', chapter('chp_2', 'old'))
    await a.sync()
    for (const f of fs.readdirSync(join(a.stateDir, 'units'))) {
      fs.writeFileSync(join(a.stateDir, 'units', f), '{ broken')
    }
    await a.write(VOLUME, 'chapters/chp_2.json', chapter('chp_2', 'new'))
    a.restart()
    await a.sync()
    expect(a.everything()).toContain('"old"')
    expect(a.read(VOLUME, 'chapters/chp_2.json')).toContain('new')
  })

  it('never writes outside the library, whatever the cloud says', async () => {
    const cloud = new MemoryCloud()
    const a = new Device('A', cloud)
    const manifest = {
      formatVersion: 1,
      unit: VOLUME,
      deleted: false,
      files: {
        '../../../escape.json': { hash: 'a'.repeat(64), size: 1, at: '', by: 'x' },
        '.hidden': { hash: 'a'.repeat(64), size: 1, at: '', by: 'x' },
      },
      updatedAt: '',
      by: 'x',
    }
    await cloud.put(
      `${UNITS_PREFIX}${VOLUME}.json`,
      new TextEncoder().encode(JSON.stringify(manifest)),
    )
    await cloud.put(`${UNITS_PREFIX}../evil.json`, new TextEncoder().encode('{}'))
    await a.sync()
    expect(Object.keys(a.files())).toEqual([])
  })
})

/**
 * The harness: two computers editing the same and different chapters while
 * the network fails, replies get lost, the app is killed mid-sync and the
 * user types while a download is being applied. At the end, after a few
 * calm syncs, both computers must hold the same files, and every version the
 * user didn't replace or delete themselves must still exist somewhere.
 */
describe('sync harness', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8]
  for (const seed of seeds) {
    it(`loses no words (seed ${seed})`, async () => {
      let state = seed * 7919
      const random = () => {
        state = (state * 1103515245 + 12345) % 2147483648
        return state / 2147483648
      }
      const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!

      const cloud = new MemoryCloud()
      const devices = [new Device('A', cloud), new Device('B', cloud)]
      const ids = Array.from({ length: 4 }, () => newId('chapter'))
      const units = [VOLUME, `${SERIES}/volumes/vol_bbbbbbbbbbbbbbbb`]
      let counter = 0
      /** Every text written, and those the user replaced or deleted on purpose. */
      const written = new Set<string>()
      const dropped = new Set<string>()
      const textOf = (raw: string | null) =>
        raw ? (JSON.parse(raw) as { text: string }).text : null

      const edit = async (d: Device, unit: string, id: string) => {
        const rel = `chapters/${id}.json`
        const before = textOf(d.read(unit, rel))
        if (before) dropped.add(before)
        const text = `w${++counter}`
        written.add(text)
        await d.write(unit, rel, chapter(id, text))
      }

      for (let step = 0; step < 120; step++) {
        const d = pick(devices)
        const roll = random()
        if (roll < 0.45) {
          await edit(d, pick(units), pick(ids))
        } else if (roll < 0.52) {
          const unit = pick(units)
          const rel = `chapters/${pick(ids)}.json`
          const before = textOf(d.read(unit, rel))
          if (before) {
            dropped.add(before)
            d.remove(unit, rel)
          }
        } else {
          // Sync, with trouble.
          const failRate = random() < 0.5 ? 0 : 0.15
          cloud.fault = (): Fault | null => {
            const r = random()
            if (r < failRate / 2) return 'drop'
            if (r < failRate) return 'lose-reply'
            return null
          }
          // Sometimes the user types just as a download is applied.
          d.extra.borrow = async (unit, rels) => {
            const rel = rels.find((r) => r.startsWith('chapters/'))
            if (rel && random() < 0.3) await edit(d, unit, rel.slice(9, -5))
            return () => {}
          }
          // Sometimes the app dies in the middle of applying.
          d.extra.beforeReplace = async () => {
            if (random() < 0.1) throw new Error('killed')
          }
          await d.sync().catch(() => {})
          cloud.fault = () => null
          d.extra = {}
          if (random() < 0.2) d.restart()
        }
      }

      // Calm syncs until both computers agree.
      for (let i = 0; i < 4; i++) for (const d of devices) await d.sync()
      const [a, b] = devices as [Device, Device]
      expect(a.files()).toEqual(b.files())

      const everywhere = devices.map((d) => d.everything()).join('\n')
      const lost = [...written].filter(
        (t) => !dropped.has(t) && !everywhere.includes(`"text": "${t}"`),
      )
      expect(lost).toEqual([])
      // And every chapter still in the library holds a version someone wrote.
      for (const [path, text] of Object.entries(a.files())) {
        if (path.includes('/chapters/')) expect(written.has(textOf(text)!)).toBe(true)
      }
    })
  }
})
