/**
 * Sync units on disk: each series folder (its own files, not its volumes),
 * each volume and each world. A unit's files are listed by path relative to
 * its folder, with forward slashes. Device-only files, temp files and the
 * local manifest never sync.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { isTempFileName } from '../fs/atomicWrite'
import { readJsonFile, sha256, writeJsonFile } from '../fs/jsonFile'
import { AppError } from '../errors'

const ID = '[A-Za-z0-9_-]{1,64}'
const UNIT_PATTERN = new RegExp(`^(?:series/${ID}(?:/volumes/${ID})?|worlds/${ID})$`)

/** A unit key is the unit's folder relative to the library: `worlds/<id>`. */
export function isUnitKey(value: string): boolean {
  return UNIT_PATTERN.test(value)
}

export type UnitKind = 'series' | 'volume' | 'world'

export function unitKind(unit: string): UnitKind {
  if (unit.startsWith('worlds/')) return 'world'
  return unit.includes('/volumes/') ? 'volume' : 'series'
}

/** The id at the end of a unit key. */
export const unitId = (unit: string) => unit.slice(unit.lastIndexOf('/') + 1)

/** Series before their volumes, so a volume's folder always has a series around it. */
export function unitOrder(a: string, b: string): number {
  return a.split('/').length - b.split('/').length || a.localeCompare(b)
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/

/** Whether a path from the cloud is one sync may write: plain names, no `..`, nothing hidden. */
export function isSyncablePath(unit: string, rel: string): boolean {
  const parts = rel.split('/')
  if (parts.length > 4 || !parts.every((p) => SEGMENT.test(p) && !p.includes('..'))) return false
  if (rel === 'manifest.json') return false
  if (unitKind(unit) === 'series' && parts[0] === 'volumes') return false
  return !isTempFileName(parts[parts.length - 1]!)
}

async function dirNames(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Every unit folder in the library. */
export async function localUnits(root: string): Promise<string[]> {
  const units: string[] = []
  for (const s of await dirNames(join(root, 'series'))) {
    units.push(`series/${s}`)
    for (const v of await dirNames(join(root, 'series', s, 'volumes'))) {
      units.push(`series/${s}/volumes/${v}`)
    }
  }
  for (const w of await dirNames(join(root, 'worlds'))) units.push(`worlds/${w}`)
  return units.filter(isUnitKey).sort(unitOrder)
}

/** Paths of a unit's files (relative), or null when the unit's folder doesn't exist. */
export async function unitFiles(root: string, unit: string): Promise<string[] | null> {
  const top = join(root, unit)
  const out: string[] = []
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
    for (const e of entries) {
      const rel = prefix + e.name
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) {
        if (!isSyncablePath(unit, `${rel}/x`)) continue
        await walk(join(dir, e.name), `${rel}/`)
      } else if (e.isFile() && isSyncablePath(unit, rel)) {
        out.push(rel)
      }
    }
    return true
  }
  if (!(await walk(top, ''))) return null
  return out.sort()
}

export interface FileHash {
  hash: string
  size: number
}

const cacheSchema = z.looseObject({
  files: z.record(z.string(), z.tuple([z.number(), z.number(), z.number(), z.string()])),
})

/**
 * File hashes, remembered by size, modified time and inode so unchanged files
 * aren't read again. Losing it costs one re-read of everything, nothing more.
 */
export class HashCache {
  private files = new Map<string, [number, number, number, string]>()
  private dirty = false

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const data = await readJsonFile(this.file, cacheSchema)
      this.files = new Map(Object.entries(data.files))
    } catch (err) {
      if (!(err instanceof AppError)) throw err
    }
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    await writeJsonFile(this.file, { formatVersion: 1, files: Object.fromEntries(this.files) })
  }

  /** The file's hash now, or null when it doesn't exist. */
  async hash(path: string): Promise<FileHash | null> {
    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const known = this.files.get(path)
    if (known && known[0] === stat.size && known[1] === stat.mtimeMs && known[2] === stat.ino) {
      return { hash: known[3], size: stat.size }
    }
    let bytes: Buffer
    try {
      bytes = await fs.promises.readFile(path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    const hash = sha256(bytes)
    // Only remember it if the file didn't change while it was read.
    const after = await fs.promises.stat(path).catch(() => null)
    if (after && after.mtimeMs === stat.mtimeMs && after.size === bytes.byteLength) {
      this.files.set(path, [after.size, after.mtimeMs, after.ino, hash])
      this.dirty = true
    }
    return { hash, size: bytes.byteLength }
  }

  /** Hashes of all a unit's files, or null when the unit's folder doesn't exist. */
  async scan(root: string, unit: string): Promise<Map<string, FileHash> | null> {
    const rels = await unitFiles(root, unit)
    if (!rels) return null
    const out = new Map<string, FileHash>()
    for (const rel of rels) {
      const h = await this.hash(join(root, unit, rel))
      if (h) out.set(rel, h)
    }
    return out
  }
}
