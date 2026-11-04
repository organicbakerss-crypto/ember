/**
 * The sync engine. Local files are the truth; the cloud is a mailbox.
 *
 * In the cloud (under `library/`):
 *   units/<unit>.json   one small manifest per sync unit: each file's hash
 *                       (null once deleted). Replaced only with a conditional
 *                       write against the version this device last saw.
 *   blobs/<sha256>      file contents, gzipped, named by the hash of the file
 *                       (so never changed, and stored once).
 *
 * On this device (`<local data folder>/sync/`), per unit: the manifest last
 * seen and each file's base, the hash both sides last agreed on. Comparing
 * base, local and cloud gives the pull rule:
 *
 *   only the cloud changed  → download        only here changed → upload
 *   both changed            → keep both (a conflict copy), never overwrite
 *
 * A deleted file becomes a marker; the other device moves its copy to its
 * own trash. Every step can fail or be cut off: a retry sees what's already
 * done, by hash, and carries on. Nothing here waits on the user's writing.
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { z } from 'zod'
import { writeFileAtomic } from '../fs/atomicWrite'
import { readJsonFile, serializeJson, sha256, writeJsonFile } from '../fs/jsonFile'
import { KeyedLock } from '../fs/keyedLock'
import { AppError } from '../errors'
import { CloudError, PreconditionFailed, type CloudStore } from './cloud'
import { conflictCopy } from './conflicts'
import { ConflictStore } from './conflictStore'
import { mergeFile } from './merge'
import {
  HashCache,
  isSyncablePath,
  isUnitKey,
  localUnits,
  unitKind,
  unitOrder,
  type FileHash,
} from './units'

export const CLOUD_PREFIX = 'library/'
export const UNITS_PREFIX = `${CLOUD_PREFIX}units/`
export const BLOBS_PREFIX = `${CLOUD_PREFIX}blobs/`

/** Deletion markers older than this are dropped from manifests. */
const TOMBSTONE_DAYS = 180
/** Tries per unit when the cloud keeps changing under it. */
const ATTEMPTS = 6

const cloudFileSchema = z.looseObject({
  hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  size: z.number().int().nonnegative().catch(0),
  at: z.string().catch(''),
  by: z.string().catch(''),
})
export type CloudFile = z.infer<typeof cloudFileSchema>

export const cloudManifestSchema = z.looseObject({
  formatVersion: z.number().int().positive(),
  unit: z.string(),
  deleted: z.boolean().catch(false),
  files: z.record(z.string(), cloudFileSchema),
  updatedAt: z.string().catch(''),
  by: z.string().catch(''),
})
export type CloudManifest = z.infer<typeof cloudManifestSchema>

const unitStateSchema = z.looseObject({
  etag: z.string().nullable(),
  manifest: cloudManifestSchema.nullable(),
  base: z.record(z.string(), z.string()),
})
type UnitState = z.infer<typeof unitStateSchema>

const EMPTY_STATE: UnitState = { etag: null, manifest: null, base: {} }

/** What the library does around sync's writes. */
export interface SyncHooks {
  /** Runs `task` holding the unit's write lock (the library's own). */
  lock<T>(unit: string, task: () => Promise<T>): Promise<T>
  /**
   * Asks whoever is editing these files to save and stop until the returned
   * function is called (then they reload and carry on). Called before `lock`.
   */
  borrow(unit: string, rels: string[]): Promise<() => void>
  /** A file is about to be replaced by the other computer's version (keep it in history). */
  beforeReplace(unit: string, rel: string): Promise<void>
  /** A file was deleted on the other computer: move this copy to the trash. */
  trashFile(unit: string, rel: string): Promise<void>
  /** A whole unit was deleted on the other computer: move it to the trash. */
  trashUnit(unit: string): Promise<void>
  /** Files changed here because of sync (`unit`: the unit itself appeared or went). */
  changed(unit: string, rels: string[], unitChanged: boolean): void
  /** A quiet message for the user. */
  notice(message: string): void
}

export interface SyncReport {
  uploaded: number
  downloaded: number
  removed: number
  conflicts: number
  /** Files that couldn't be synced this time (they'll be tried again). */
  problems: string[]
}

const emptyReport = (): SyncReport => ({
  uploaded: 0,
  downloaded: 0,
  removed: 0,
  conflicts: 0,
  problems: [],
})

/** Simple hooks for tests: a lock per unit, and a trash folder in the state folder. */
export function basicHooks(root: string, stateDir: string): SyncHooks {
  const lock = new KeyedLock()
  const toTrash = async (path: string, name: string) => {
    const dest = join(
      stateDir,
      'trash',
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
    )
    await fs.promises.mkdir(dirname(dest), { recursive: true })
    await fs.promises.rename(path, dest).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
  }
  return {
    lock: (unit, task) => lock.run(unit, task),
    borrow: async () => () => {},
    beforeReplace: async () => {},
    trashFile: (unit, rel) => toTrash(join(root, unit, rel), rel.replaceAll('/', '_')),
    trashUnit: (unit) => toTrash(join(root, unit), unit.replaceAll('/', '_')),
    changed: () => {},
    notice: () => {},
  }
}

export interface SyncEngineOptions {
  root: string
  /** Device-only folder for sync's own state. */
  stateDir: string
  cloud: CloudStore
  /** This computer's name, shown on the other one ("copy from Mac"). */
  device: string
  hooks: SyncHooks
  now?: () => Date
}

export class SyncEngine {
  private readonly root: string
  private readonly stateDir: string
  private readonly cloud: CloudStore
  private readonly hooks: SyncHooks
  private readonly now: () => Date
  readonly hashes: HashCache
  /** Versions set aside when both computers changed a file. */
  readonly conflicts: ConflictStore
  device: string
  private loaded = false

  constructor(options: SyncEngineOptions) {
    this.root = options.root
    this.stateDir = options.stateDir
    this.cloud = options.cloud
    this.hooks = options.hooks
    this.device = options.device
    this.now = options.now ?? (() => new Date())
    this.hashes = new HashCache(join(this.stateDir, 'hashes.json'))
    this.conflicts = new ConflictStore(join(this.stateDir, 'conflicts'))
  }

  /**
   * One pass over the whole library: what changed in the cloud (one listing)
   * and what changed here. Throws CloudError when the cloud can't be reached;
   * everything done before that is kept.
   */
  async cycle(): Promise<SyncReport> {
    if (!this.loaded) {
      await this.hashes.load()
      this.loaded = true
    }
    const report = emptyReport()
    const listed = new Map<string, string>()
    for (const o of await this.cloud.list(UNITS_PREFIX)) {
      const unit = o.key.slice(UNITS_PREFIX.length).replace(/\.json$/, '')
      if (isUnitKey(unit)) listed.set(unit, o.etag)
    }
    const units = new Set([
      ...listed.keys(),
      ...(await localUnits(this.root)),
      ...(await this.knownUnits()),
    ])
    try {
      for (const unit of [...units].sort(unitOrder)) {
        try {
          await this.syncUnit(unit, listed.has(unit) ? listed.get(unit)! : null, report)
        } catch (err) {
          if (err instanceof CloudError) throw err
          // A damaged file or a full disk: report it, carry on with the rest.
          report.problems.push(`${unit}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      await this.hashes.save().catch(() => {})
    }
    return report
  }

  /** Files changed here that the cloud doesn't have yet. */
  async pending(): Promise<number> {
    if (!this.loaded) {
      await this.hashes.load()
      this.loaded = true
    }
    let count = 0
    const units = new Set([...(await localUnits(this.root)), ...(await this.knownUnits())])
    for (const unit of units) {
      const state = await this.readState(unit)
      const local = await this.hashes.scan(this.root, unit)
      if (!local) {
        if (state.etag && !state.manifest?.deleted) count++
        continue
      }
      for (const [rel, h] of local) if (state.base[rel] !== h.hash) count++
      for (const rel of Object.keys(state.base)) if (!local.has(rel)) count++
    }
    return count
  }

  /* ---------- one unit ---------- */

  private async syncUnit(unit: string, listedEtag: string | null, report: SyncReport) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const state = await this.readState(unit)
      let cloud: CloudManifest | null
      let etag: string | null
      if (attempt === 0 && listedEtag === null && !state.etag) {
        cloud = null
        etag = null
      } else if (
        attempt === 0 &&
        listedEtag !== null &&
        listedEtag === state.etag &&
        state.manifest
      ) {
        // Unchanged since we last saw it: no need to download it.
        cloud = state.manifest
        etag = state.etag
      } else {
        const got = await this.fetchManifest(unit)
        cloud = got?.manifest ?? null
        etag = got?.etag ?? null
      }
      const local = await this.hashes.scan(this.root, unit)
      if ((await this.reconcile(unit, state, cloud, etag, local, report)) === 'done') return
    }
    report.problems.push(`${unit}: kept changing in the cloud; will try again`)
  }

  private async fetchManifest(
    unit: string,
  ): Promise<{ manifest: CloudManifest; etag: string } | null> {
    const got = await this.cloud.get(`${UNITS_PREFIX}${unit}.json`)
    if (!got) return null
    let manifest: CloudManifest
    try {
      manifest = cloudManifestSchema.parse(JSON.parse(new TextDecoder().decode(got.body)))
    } catch {
      throw new Error('its list of files in the cloud is damaged; it was left alone')
    }
    // Drop anything a manifest shouldn't name.
    manifest.files = Object.fromEntries(
      Object.entries(manifest.files).filter(([rel]) => isSyncablePath(unit, rel)),
    )
    return { manifest, etag: got.etag }
  }

  /** Compares base, local and cloud for one unit and acts. 'retry' when the cloud moved on. */
  private async reconcile(
    unit: string,
    state: UnitState,
    cloud: CloudManifest | null,
    etag: string | null,
    local: Map<string, FileHash> | null,
    report: SyncReport,
  ): Promise<'done' | 'retry'> {
    let base = { ...state.base }
    let cloudFiles = cloud?.files ?? {}
    const live = (files: Record<string, CloudFile>) =>
      Object.entries(files).filter(([, f]) => f.hash !== null) as [
        string,
        CloudFile & { hash: string },
      ][]

    if (!local && !cloud) {
      await this.dropState(unit)
      return 'done'
    }

    if (!local) {
      if (cloud?.deleted) {
        await this.writeState(unit, { etag, manifest: cloud, base: {} })
        return 'done'
      }
      const hadIt = Object.keys(base).length > 0
      const cloudChanged = live(cloudFiles).some(([rel, f]) => base[rel] !== f.hash)
      if (hadIt && cloud && !cloudChanged) {
        // Deleted here, unchanged there: delete it there too (as markers).
        const files = Object.fromEntries(
          Object.entries(cloudFiles).map(([rel, f]) => [rel, f.hash ? this.marker() : f]),
        )
        const manifest = this.manifest(unit, files, true)
        const committed = await this.commit(unit, manifest, etag)
        if (!committed) return 'retry'
        await this.writeState(unit, { etag: committed, manifest, base: {} })
        report.removed++
        return 'done'
      }
      // New from the other computer, or changed there after it was deleted here: bring it (back).
      base = {}
    }

    let resurrect = false
    if (local && cloud?.deleted) {
      const changedHere =
        Object.keys(base).length === 0 ||
        [...local].some(([rel, h]) => base[rel] !== h.hash) ||
        (await this.subunitsChanged(unit))
      if (!changedHere) {
        const release = await this.hooks.borrow(unit, [...local.keys()])
        try {
          await this.hooks.lock(unit, () => this.hooks.trashUnit(unit))
        } finally {
          release()
        }
        await this.writeState(unit, { etag, manifest: cloud, base: {} })
        this.hooks.changed(unit, [...local.keys()], true)
        report.removed++
        return 'done'
      }
      // Deleted there, but changed here since: keep it, and put it back in the cloud.
      resurrect = true
      cloudFiles = Object.fromEntries(
        Object.entries(cloudFiles).map(([rel, f]) => [rel, f.hash ? this.marker() : f]),
      )
      base = {}
    }

    const localFiles = local ?? new Map<string, FileHash>()
    const uploads: string[] = []
    const downloads: { rel: string; hash: string; expect: string | null }[] = []
    const removals: { rel: string; expect: string }[] = []
    const markers: string[] = []
    const conflicts: { rel: string; hash: string; expect: string; base: string | null }[] = []
    const rels = new Set([...localFiles.keys(), ...Object.keys(cloudFiles), ...Object.keys(base)])
    for (const rel of [...rels].sort()) {
      const b = base[rel] ?? null
      const l = localFiles.get(rel)?.hash ?? null
      const c = cloudFiles[rel]?.hash ?? null
      if (l === c) {
        if (l === null) delete base[rel]
        else base[rel] = l
      } else if (l === b) {
        if (c === null) removals.push({ rel, expect: l! })
        else downloads.push({ rel, hash: c, expect: l })
      } else if (c === b) {
        if (l === null) markers.push(rel)
        else uploads.push(rel)
      } else if (l === null) {
        // Deleted here, changed there: the words come back.
        downloads.push({ rel, hash: c!, expect: null })
      } else if (c === null) {
        // Changed here, deleted there: keep it.
        uploads.push(rel)
      } else {
        conflicts.push({ rel, hash: c, expect: l, base: b })
      }
    }

    // Bring the other computer's changes here.
    if (downloads.length || removals.length || conflicts.length) {
      const blobs = new Map<string, Uint8Array>()
      const wanted = [
        ...[...downloads, ...conflicts].map((x) => x.hash),
        // The version both last agreed on, to combine the two (may be gone: then without it).
        ...conflicts.flatMap((k) => (k.base ? [k.base] : [])),
      ]
      for (const hash of wanted) {
        if (blobs.has(hash)) continue
        const bytes = await this.fetchBlob(hash)
        if (bytes) blobs.set(hash, bytes)
      }
      const touched = [...downloads, ...removals, ...conflicts].map((x) => x.rel)
      const applied: string[] = []
      const release = await this.hooks.borrow(unit, touched)
      try {
        await this.hooks.lock(unit, async () => {
          for (const d of downloads) {
            const bytes = blobs.get(d.hash)
            if (!bytes) {
              report.problems.push(`${unit}/${d.rel}: its contents are missing in the cloud`)
              continue
            }
            const path = join(this.root, unit, d.rel)
            const now = (await this.hashes.hash(path))?.hash ?? null
            if (now !== d.expect) continue // Changed here meanwhile: next round sorts it out.
            if (now !== null) await this.hooks.beforeReplace(unit, d.rel)
            await fs.promises.mkdir(dirname(path), { recursive: true })
            await writeFileAtomic(path, bytes)
            base[d.rel] = d.hash
            applied.push(d.rel)
            report.downloaded++
          }
          for (const r of removals) {
            const path = join(this.root, unit, r.rel)
            const now = (await this.hashes.hash(path))?.hash ?? null
            if (now !== r.expect) continue
            await this.hooks.trashFile(unit, r.rel)
            delete base[r.rel]
            applied.push(r.rel)
            report.removed++
          }
          for (const k of conflicts) {
            const bytes = blobs.get(k.hash)
            if (!bytes) {
              report.problems.push(`${unit}/${k.rel}: its contents are missing in the cloud`)
              continue
            }
            const path = join(this.root, unit, k.rel)
            let mine: Uint8Array
            try {
              mine = await fs.promises.readFile(path)
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
              throw err
            }
            if (sha256(mine) !== k.expect) continue // Changed here meanwhile: next round.
            const from = cloudFiles[k.rel]!
            const agreed = k.base ? (blobs.get(k.base) ?? null) : null
            const written = await this.keepBoth(unit, k.rel, agreed, mine, bytes, from)
            applied.push(...written.filter((rel) => rel !== k.rel))
            // This computer's version now counts as the newer one: it goes up next.
            base[k.rel] = k.hash
            applied.push(k.rel)
            report.conflicts++
          }
        })
      } finally {
        release()
      }
      if (applied.length || !local) this.hooks.changed(unit, applied, !local)
      if (conflicts.length) {
        // Upload the copies and this computer's versions on the next round.
        await this.writeState(unit, { etag, manifest: cloud, base })
        return 'retry'
      }
    }

    // Send this computer's changes.
    const files = { ...cloudFiles }
    const sent: Record<string, string> = {}
    for (const rel of uploads) {
      const path = join(this.root, unit, rel)
      let bytes: Buffer
      try {
        bytes = await fs.promises.readFile(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue // Gone meanwhile.
        throw err
      }
      const hash = sha256(bytes)
      await this.putBlob(hash, bytes)
      files[rel] = { hash, size: bytes.byteLength, at: this.timestamp(), by: this.device }
      sent[rel] = hash
    }
    for (const rel of markers) files[rel] = this.marker()

    const isNew = !cloud && localFiles.size > 0
    if (Object.keys(sent).length || markers.length || resurrect || isNew) {
      const manifest = this.manifest(unit, files, false)
      const committed = await this.commit(unit, manifest, cloud ? etag : null)
      if (!committed) {
        await this.writeState(unit, { etag, manifest: cloud, base })
        return 'retry'
      }
      Object.assign(base, sent)
      for (const rel of markers) delete base[rel]
      report.uploaded += Object.keys(sent).length + markers.length
      await this.writeState(unit, { etag: committed, manifest, base })
      return 'done'
    }
    await this.writeState(unit, { etag, manifest: cloud, base })
    return 'done'
  }

  /** For a series: whether any of its volumes has changes here the cloud doesn't. */
  private async subunitsChanged(unit: string): Promise<boolean> {
    if (unitKind(unit) !== 'series') return false
    for (const sub of await localUnits(this.root)) {
      if (!sub.startsWith(`${unit}/`)) continue
      const state = await this.readState(sub)
      const files = await this.hashes.scan(this.root, sub)
      if (!files) continue
      if (!state.etag) return true
      if ([...files].some(([rel, h]) => state.base[rel] !== h.hash)) return true
    }
    return false
  }

  /**
   * Both computers changed a file. Chapters and entries: the other version
   * becomes a copy beside this one. Other files: the two are combined where
   * possible; whatever can't be is set aside (Settings → Sync → Conflicts).
   * Returns the files written here.
   */
  private async keepBoth(
    unit: string,
    rel: string,
    base: Uint8Array | null,
    mine: Uint8Array,
    theirs: Uint8Array,
    from: CloudFile,
  ): Promise<string[]> {
    const parsed = new Date(from.at || this.timestamp())
    const at = Number.isNaN(parsed.getTime()) ? this.now() : parsed
    const copy = conflictCopy(rel, theirs, { device: from.by, at })
    if (copy) {
      await this.writeHere(unit, copy.rel, copy.bytes)
      this.hooks.notice(
        `“${copy.original}” changed on both computers. Both versions are kept; the other one is “${copy.name}”.`,
      )
      return [copy.rel]
    }
    const merged = mergeFile(unit, rel, base, mine, theirs, { device: from.by })
    const written: string[] = []
    if (merged) {
      await this.hooks.beforeReplace(unit, rel)
      await this.writeHere(unit, rel, merged.bytes)
      written.push(rel)
      if (merged.copy) {
        await this.writeHere(unit, merged.copy.rel, merged.copy.bytes)
        written.push(merged.copy.rel)
        this.hooks.notice(
          `A conversation went on differently on each computer. Both are kept; the other one is “${merged.copy.name}”.`,
        )
      }
      if (merged.clean) return written
    }
    await this.conflicts.save({
      unit,
      rel,
      device: from.by,
      at: at.toISOString(),
      reason: 'both-changed',
      bytes: theirs,
    })
    this.hooks.notice(
      merged
        ? 'Something changed in the same place on both computers. The changes were combined, keeping this computer’s where they clashed; the other version is in Settings → Sync → Conflicts.'
        : 'A file changed on both computers. This computer’s version is kept; the other is in Settings → Sync → Conflicts.',
    )
    return written
  }

  private async writeHere(unit: string, rel: string, bytes: Uint8Array) {
    const path = join(this.root, unit, rel)
    await fs.promises.mkdir(dirname(path), { recursive: true })
    await writeFileAtomic(path, bytes)
  }

  /* ---------- cloud pieces ---------- */

  private marker(): CloudFile {
    return { hash: null, size: 0, at: this.timestamp(), by: this.device }
  }

  private manifest(
    unit: string,
    files: Record<string, CloudFile>,
    deleted: boolean,
  ): CloudManifest {
    const cutoff = this.now().getTime() - TOMBSTONE_DAYS * 86_400_000
    const kept = Object.fromEntries(
      Object.entries(files)
        .filter(([, f]) => f.hash !== null || !f.at || new Date(f.at).getTime() > cutoff)
        .sort(([a], [b]) => a.localeCompare(b)),
    )
    return {
      formatVersion: 1,
      unit,
      deleted,
      files: kept,
      updatedAt: this.timestamp(),
      by: this.device,
    }
  }

  /** Replaces the unit's manifest if nobody else did first. The new ETag, or null if they did. */
  private async commit(unit: string, manifest: CloudManifest, etag: string | null) {
    try {
      const body = new TextEncoder().encode(serializeJson(manifest))
      const put = await this.cloud.put(
        `${UNITS_PREFIX}${unit}.json`,
        body,
        etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      )
      return put.etag
    } catch (err) {
      if (err instanceof PreconditionFailed) return null
      throw err
    }
  }

  private async putBlob(hash: string, bytes: Uint8Array) {
    const body = gzipSync(bytes)
    try {
      await this.cloud.put(`${BLOBS_PREFIX}${hash}`, body, { ifNoneMatch: '*' })
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err
      // Already there (the same contents, from either computer). Write it again so it
      // counts as recent: the clean-up only removes copies nothing has used for a month.
      await this.cloud.put(`${BLOBS_PREFIX}${hash}`, body)
    }
  }

  /** A file's contents from the cloud, checked against its hash (null if missing or damaged). */
  private async fetchBlob(hash: string): Promise<Uint8Array | null> {
    const got = await this.cloud.get(`${BLOBS_PREFIX}${hash}`)
    if (!got) return null
    try {
      const bytes = gunzipSync(got.body)
      return sha256(bytes) === hash ? bytes : null
    } catch {
      return null
    }
  }

  /* ---------- device state ---------- */

  private stateFile(unit: string) {
    return join(this.stateDir, 'units', `${unit.replaceAll('/', '~')}.json`)
  }

  private async knownUnits(): Promise<string[]> {
    try {
      return (await fs.promises.readdir(join(this.stateDir, 'units')))
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -5).replaceAll('~', '/'))
        .filter(isUnitKey)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  private async readState(unit: string): Promise<UnitState> {
    try {
      return await readJsonFile(this.stateFile(unit), unitStateSchema)
    } catch (err) {
      // Missing or damaged: start over. Files that differ then count as changed
      // on both sides, so both versions are kept; nothing is overwritten.
      if (err instanceof AppError) return { ...EMPTY_STATE, base: {} }
      throw err
    }
  }

  private async writeState(unit: string, state: UnitState) {
    await fs.promises.mkdir(join(this.stateDir, 'units'), { recursive: true })
    await writeJsonFile(this.stateFile(unit), { formatVersion: 1, ...state })
  }

  private async dropState(unit: string) {
    await fs.promises.rm(this.stateFile(unit), { force: true })
  }

  private timestamp() {
    return this.now().toISOString()
  }
}
