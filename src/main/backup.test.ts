import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { BackupService, backupName, listBackups, makeBackup, pruneBackups } from './backup'

let tmp: string
let lib: string
let out: string

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(join(os.tmpdir(), 'backup-'))
  lib = join(tmp, 'lib')
  out = join(tmp, 'backups')
  await fs.promises.mkdir(join(lib, 'series', 's1'), { recursive: true })
  await fs.promises.mkdir(join(lib, '.local', 'cache'), { recursive: true })
  await fs.promises.writeFile(join(lib, 'library.json'), '{"formatVersion":1}')
  await fs.promises.writeFile(join(lib, 'series', 's1', 'chapter.json'), '{"text":"Mara ran."}')
  await fs.promises.writeFile(join(lib, 'series', 's1', 'cover.png'), Buffer.from([1, 2, 3]))
  await fs.promises.writeFile(join(lib, '.local', 'cache', 'big.bin'), 'cache')
})
afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true })
})

const at = (h: number) => new Date(2026, 10, 4, h, 0, 0)

describe('backups', () => {
  it('zips the whole library except this computer’s own folder', async () => {
    const info = await makeBackup({
      libraryRoot: lib,
      skip: [join(lib, '.local')],
      folder: out,
      now: at(9),
    })
    expect(info.file).toBe(backupName(at(9)))
    const files = unzipSync(new Uint8Array(await fs.promises.readFile(join(out, info.file))))
    expect(Object.keys(files).sort()).toEqual([
      'library.json',
      'series/s1/chapter.json',
      'series/s1/cover.png',
    ])
    expect(strFromU8(files['series/s1/chapter.json']!)).toBe('{"text":"Mara ran."}')
    expect(await fs.promises.readdir(out)).toEqual([info.file]) // no leftovers
  })

  it('refuses a folder inside the library', async () => {
    await expect(
      makeBackup({ libraryRoot: lib, skip: [], folder: join(lib, 'backups') }),
    ).rejects.toThrow(/inside the library/)
  })

  it('a failure leaves no half-written backup', async () => {
    const real = fs.promises.readFile
    const spy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(((path: string, ...rest: never[]) =>
        String(path).endsWith('cover.png')
          ? Promise.reject(new Error('read error'))
          : real(path, ...rest)) as typeof fs.promises.readFile)
    await expect(makeBackup({ libraryRoot: lib, skip: [], folder: out })).rejects.toThrow(
      'read error',
    )
    spy.mockRestore()
    expect(await fs.promises.readdir(out)).toEqual([])
  })

  it('lists newest first and keeps only the newest few (others to the trash)', async () => {
    for (const h of [8, 9, 10, 11]) {
      await makeBackup({ libraryRoot: lib, skip: [], folder: out, now: at(h) })
    }
    await fs.promises.writeFile(join(out, 'my-notes.zip'), 'not ours')
    expect((await listBackups(out)).map((b) => b.file)).toEqual(
      [11, 10, 9, 8].map((h) => backupName(at(h))),
    )
    const trashed: string[] = []
    await pruneBackups(out, 2, async (p) => {
      trashed.push(p)
      await fs.promises.rm(p)
    })
    expect(trashed.map((p) => p.split(/[\\/]/).pop())).toEqual([
      backupName(at(9)),
      backupName(at(8)),
    ])
    expect((await fs.promises.readdir(out)).sort()).toEqual(
      [backupName(at(10)), backupName(at(11)), 'my-notes.zip'].sort(),
    )
  })

  it('runs only when one is due', async () => {
    const settings = { enabled: true, folder: out, everyHours: 24, keep: 5 }
    const service = new BackupService({
      settings: async () => settings,
      library: () => ({ root: lib, localDir: join(lib, '.local') }),
      trash: async (p) => fs.promises.rm(p),
    })
    expect(await service.runIfDue(at(9))).not.toBeNull()
    expect(await service.runIfDue(at(20))).toBeNull() // 11 hours later: not yet
    expect(await service.runIfDue(new Date(2026, 10, 5, 10))).not.toBeNull() // next day
    settings.enabled = false
    expect(await service.runIfDue(new Date(2026, 10, 9))).toBeNull()
    expect((await listBackups(out)).length).toBe(2)
  })
})
