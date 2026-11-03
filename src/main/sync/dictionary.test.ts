import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCloud } from './memoryCloud'
import { syncDictionary } from './dictionary'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const state = () => {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'dict-'))
  dirs.push(d)
  return d
}

describe('the personal dictionary across computers', () => {
  it('adds and removes words everywhere; the latest change wins', async () => {
    const cloud = new MemoryCloud()
    const a = { dir: state(), words: ['Mara', 'Ostrel'] }
    const b = { dir: state(), words: ['Kestrin'] }
    let t = Date.parse('2026-11-01T10:00:00Z')
    const run = async (d: typeof a) => {
      t += 1000
      const next = await syncDictionary(cloud, d.dir, d.words, new Date(t))
      if (next) d.words = next
    }
    await run(a)
    await run(b)
    await run(a)
    expect(a.words).toEqual(['Kestrin', 'Mara', 'Ostrel'])
    expect(b.words).toEqual(['Kestrin', 'Mara', 'Ostrel'])

    // Removed on A, added on B.
    a.words = a.words.filter((w) => w !== 'Ostrel')
    b.words = [...b.words, 'Varn']
    await run(a)
    await run(b)
    await run(a)
    expect(a.words).toEqual(['Kestrin', 'Mara', 'Varn'])
    expect(b.words).toEqual(['Kestrin', 'Mara', 'Varn'])

    // Nothing changed: nothing to apply.
    expect(await syncDictionary(cloud, a.dir, a.words, new Date(t + 5000))).toBeNull()
  })

  it('a computer that joins later keeps its own words and gets everyone else’s', async () => {
    const cloud = new MemoryCloud()
    const a = state()
    expect(await syncDictionary(cloud, a, ['Mara'])).toBeNull()
    const c = state()
    expect(await syncDictionary(cloud, c, ['Zed'])).toEqual(['Mara', 'Zed'])
  })
})
