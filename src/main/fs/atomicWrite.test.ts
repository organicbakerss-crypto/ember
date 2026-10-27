import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isTempFileName, removeStaleTempFiles, writeFileAtomic } from './atomicWrite'
import { KeyedLock } from './keyedLock'

let dir: string

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'atomic-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('creates and replaces files', async () => {
    const target = join(dir, 'a.json')
    await writeFileAtomic(target, 'one')
    await writeFileAtomic(target, 'two')
    expect(await fs.promises.readFile(target, 'utf8')).toBe('two')
    expect(await fs.promises.readdir(dir)).toEqual(['a.json'])
  })

  it('keeps the original intact when the write fails before the rename', async () => {
    const target = join(dir, 'chapter.json')
    await writeFileAtomic(target, 'original words')
    vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(new Error('simulated crash'))

    await expect(writeFileAtomic(target, 'new words')).rejects.toThrow('simulated crash')
    expect(await fs.promises.readFile(target, 'utf8')).toBe('original words')
    expect(await fs.promises.readdir(dir)).toEqual(['chapter.json'])
  })

  it('keeps the original intact when the disk write itself fails', async () => {
    const target = join(dir, 'chapter.json')
    await writeFileAtomic(target, 'original words')
    const realOpen = fs.promises.open
    vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof realOpen>))
      handle.writeFile = () => Promise.reject(new Error('disk full'))
      return handle
    })

    await expect(writeFileAtomic(target, 'new words')).rejects.toThrow('disk full')
    expect(await fs.promises.readFile(target, 'utf8')).toBe('original words')
    expect(await fs.promises.readdir(dir)).toEqual(['chapter.json'])
  })

  it('never leaves a half-written file under concurrent writes', async () => {
    const target = join(dir, 'race.json')
    const values = Array.from({ length: 25 }, (_, i) =>
      JSON.stringify({ i, pad: 'x'.repeat(5000) }),
    )
    await Promise.all(values.map((v) => writeFileAtomic(target, v)))
    expect(values).toContain(await fs.promises.readFile(target, 'utf8'))
    expect(await fs.promises.readdir(dir)).toEqual(['race.json'])
  })
})

describe('removeStaleTempFiles', () => {
  it('removes only temp files left by a crash', async () => {
    await fs.promises.mkdir(join(dir, 'nested'))
    const stale = join(dir, 'nested', '.chapter.json.0123456789ab.tmp')
    await fs.promises.writeFile(stale, 'partial')
    await fs.promises.writeFile(join(dir, 'nested', 'chapter.json'), 'kept')
    await fs.promises.writeFile(join(dir, 'notes.tmp'), 'user file, kept')

    expect(await removeStaleTempFiles(dir)).toEqual([stale])
    expect((await fs.promises.readdir(join(dir, 'nested'))).sort()).toEqual(['chapter.json'])
    expect(await fs.promises.readFile(join(dir, 'notes.tmp'), 'utf8')).toBe('user file, kept')
  })

  it('recognises temp file names', () => {
    expect(isTempFileName('.a.json.0123456789ab.tmp')).toBe(true)
    expect(isTempFileName('a.json')).toBe(false)
    expect(isTempFileName('draft.tmp')).toBe(false)
  })
})

describe('KeyedLock', () => {
  it('runs tasks for one key in order and keeps going after a failure', async () => {
    const lock = new KeyedLock()
    const order: string[] = []
    const slow = lock.run('k', async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push('first')
    })
    const failing = lock.run('k', async () => {
      order.push('second')
      throw new Error('boom')
    })
    const third = lock.run('k', async () => order.push('third'))
    await slow
    await expect(failing).rejects.toThrow('boom')
    await third
    expect(order).toEqual(['first', 'second', 'third'])
  })
})
