/**
 * Versions set aside when a file changed on both computers and couldn't be
 * fully combined. They stay on this computer (never synced) until the writer
 * restores or deletes them from Settings → Sync.
 *
 *   <sync folder>/conflicts/<id>/meta.json   what it is and where it came from
 *   <sync folder>/conflicts/<id>/file        the set-aside version, byte for byte
 *
 * Older versions of the app saved them as conflicts/<time>/<unit>/<path>; those
 * are moved to this layout the first time the list is read.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { newId } from '@shared/ids'
import { writeFileAtomic } from '../fs/atomicWrite'
import { readJsonFile, writeJsonFile } from '../fs/jsonFile'
import { AppError } from '../errors'
import { isUnitKey } from './units'

const metaSchema = z.looseObject({
  formatVersion: z.number().int().positive(),
  id: z.string(),
  unit: z.string(),
  rel: z.string(),
  /** Which computer's version this is ('' for this computer's). */
  device: z.string().catch(''),
  /** When that version was saved there. */
  at: z.string().catch(''),
  /** When it was set aside here. */
  savedAt: z.string().catch(''),
  /** Why: changed on both computers, or replaced by a restore. */
  reason: z.enum(['both-changed', 'replaced']).catch('both-changed'),
})
export type ConflictMeta = z.infer<typeof metaSchema>

const ID = /^[A-Za-z0-9_-]{1,80}$/

export class ConflictStore {
  constructor(private readonly dir: string) {}

  /** Keeps a version aside; returns its id. */
  async save(
    input: Omit<ConflictMeta, 'formatVersion' | 'id' | 'savedAt'> & { bytes: Uint8Array },
  ) {
    const id = newId('conflict')
    const { bytes, ...meta } = input
    await fs.promises.mkdir(join(this.dir, id), { recursive: true })
    await writeFileAtomic(join(this.dir, id, 'file'), bytes)
    await writeJsonFile(join(this.dir, id, 'meta.json'), {
      formatVersion: 1,
      id,
      ...meta,
      savedAt: new Date().toISOString(),
    })
    return id
  }

  /** Everything set aside, newest first. */
  async list(): Promise<ConflictMeta[]> {
    await this.moveOld()
    const out: ConflictMeta[] = []
    for (const name of await this.names()) {
      try {
        out.push(await readJsonFile(join(this.dir, name, 'meta.json'), metaSchema))
      } catch (err) {
        if (!(err instanceof AppError)) throw err
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  }

  async read(id: string): Promise<{ meta: ConflictMeta; bytes: Uint8Array }> {
    if (!ID.test(id)) throw new AppError('not-found', 'That set-aside version is gone.')
    try {
      const meta = await readJsonFile(join(this.dir, id, 'meta.json'), metaSchema)
      const bytes = await fs.promises.readFile(join(this.dir, id, 'file'))
      return { meta, bytes }
    } catch (err) {
      if (err instanceof AppError || (err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('not-found', 'That set-aside version is gone.')
      }
      throw err
    }
  }

  async remove(id: string): Promise<void> {
    if (!ID.test(id)) return
    await fs.promises.rm(join(this.dir, id), { recursive: true, force: true })
  }

  private async names(): Promise<string[]> {
    try {
      return (await fs.promises.readdir(this.dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && ID.test(e.name))
        .map((e) => e.name)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  /** The old layout (conflicts/<time>/<unit>/<path>) into this one. */
  private async moveOld(): Promise<void> {
    for (const name of await this.names()) {
      const top = join(this.dir, name)
      if (fs.existsSync(join(top, 'meta.json'))) continue
      const files: string[] = []
      const walk = async (dir: string, prefix: string) => {
        for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name
          if (e.isDirectory()) await walk(join(dir, e.name), rel)
          else files.push(rel)
        }
      }
      await walk(top, '')
      for (const path of files) {
        const parts = path.split('/')
        const unitLen = [4, 2].find((n) => isUnitKey(parts.slice(0, n).join('/')))
        if (!unitLen || parts.length <= unitLen) continue
        const bytes = await fs.promises.readFile(join(top, path))
        const stat = await fs.promises.stat(join(top, path))
        const id = await this.save({
          unit: parts.slice(0, unitLen).join('/'),
          rel: parts.slice(unitLen).join('/'),
          device: '',
          at: '',
          reason: 'both-changed',
          bytes,
        })
        // Keep when it was set aside.
        const metaPath = join(this.dir, id, 'meta.json')
        const meta = await readJsonFile(metaPath, metaSchema)
        await writeJsonFile(metaPath, { ...meta, savedAt: stat.mtime.toISOString() })
        await fs.promises.rm(join(top, path), { force: true })
      }
      // Anything not recognised stays where it is.
      if (files.every((p) => !fs.existsSync(join(top, p)))) {
        await fs.promises.rm(top, { recursive: true, force: true })
      }
    }
  }
}
