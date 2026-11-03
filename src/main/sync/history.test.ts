import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryCloud } from './memoryCloud'
import { fetchHistory, HISTORY_PREFIX, uploadHistory } from './history'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'hist-'))
  dirs.push(d)
  return d
}
/** A snapshot id for a local time. */
const idAt = (d: Date, n: number) =>
  `${d.toISOString().replace(/[:.]/g, '-')}-${String(n).padStart(6, '0')}`

describe('history in the cloud', () => {
  it('uploads the last version of each finished day, once', async () => {
    const cloud = new MemoryCloud()
    const history = tmp()
    const state = tmp()
    const chapter = join(history, 'vol_1', 'chp_1')
    fs.mkdirSync(chapter, { recursive: true })
    const day = (offset: number, hour: number) => new Date(2026, 10, 1 + offset, hour, 0, 0)
    const ids = [idAt(day(0, 9), 1), idAt(day(0, 15), 2), idAt(day(1, 10), 3), idAt(day(2, 11), 4)]
    for (const id of ids) fs.writeFileSync(join(chapter, `${id}.json`), `{"id":"${id}"}`)
    const now = day(2, 18)
    expect(await uploadHistory(cloud, history, state, now)).toBe(2)
    expect([...cloud.objects.keys()].sort()).toEqual([
      `${HISTORY_PREFIX}vol_1/chp_1/${ids[1]}.json.gz`,
      `${HISTORY_PREFIX}vol_1/chp_1/${ids[2]}.json.gz`,
    ])
    expect(await uploadHistory(cloud, history, state, now)).toBe(0)

    // Another computer fetches them into its own history.
    const other = tmp()
    expect(await fetchHistory(cloud, other, 'vol_1', 'chp_1')).toBe(2)
    expect(fs.readdirSync(join(other, 'vol_1', 'chp_1')).sort()).toEqual([
      `${ids[1]}.json`,
      `${ids[2]}.json`,
    ])
    expect(await fetchHistory(cloud, other, 'vol_1', 'chp_1')).toBe(0)
  })
})
