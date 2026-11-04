import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConflictStore } from './conflictStore'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})
const tmp = () => {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'conflicts-'))
  dirs.push(d)
  return d
}

describe('set-aside versions', () => {
  it('saves, lists, reads and removes them', async () => {
    const store = new ConflictStore(join(tmp(), 'conflicts'))
    expect(await store.list()).toEqual([])
    const id = await store.save({
      unit: 'worlds/wld_a',
      rel: 'board.json',
      device: 'Mac',
      at: '2026-01-01T00:00:00.000Z',
      reason: 'both-changed',
      bytes: new TextEncoder().encode('theirs'),
    })
    const [meta] = await store.list()
    expect(meta).toMatchObject({ id, unit: 'worlds/wld_a', rel: 'board.json', device: 'Mac' })
    expect(new TextDecoder().decode((await store.read(id)).bytes)).toBe('theirs')
    await store.remove(id)
    expect(await store.list()).toEqual([])
    await expect(store.read(id)).rejects.toMatchObject({ code: 'not-found' })
    await expect(store.read('../x')).rejects.toMatchObject({ code: 'not-found' })
  })

  it('moves versions set aside by older versions of the app', async () => {
    const dir = join(tmp(), 'conflicts')
    const old = join(dir, '2026-01-01T00-00-00-000Z', 'series', 'ser_a', 'volumes', 'vol_b')
    fs.mkdirSync(old, { recursive: true })
    fs.writeFileSync(join(old, 'outline.json'), 'old outline')
    fs.mkdirSync(join(dir, '2026-01-02T00-00-00-000Z', 'nonsense'), { recursive: true })
    fs.writeFileSync(join(dir, '2026-01-02T00-00-00-000Z', 'nonsense', 'x'), 'left alone')
    const store = new ConflictStore(dir)
    const list = await store.list()
    expect(list.map((c) => [c.unit, c.rel])).toEqual([
      ['series/ser_a/volumes/vol_b', 'outline.json'],
    ])
    expect(new TextDecoder().decode((await store.read(list[0]!.id)).bytes)).toBe('old outline')
    expect(fs.existsSync(join(dir, '2026-01-01T00-00-00-000Z'))).toBe(false)
    expect(fs.readFileSync(join(dir, '2026-01-02T00-00-00-000Z', 'nonsense', 'x'), 'utf8')).toBe(
      'left alone',
    )
    expect(await store.list()).toHaveLength(1)
  })
})
