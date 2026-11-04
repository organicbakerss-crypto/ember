/**
 * Runs sync for the open library: when to sync, the connection settings
 * (keys stored encrypted by the operating system), and the status shown in
 * the status bar. Sync runs in the background; writing never waits on it.
 *
 * When: shortly after the app opens, when a window comes back into focus,
 * 30 seconds after the writing pauses (at most 2 minutes while writing
 * nonstop), every 5 minutes, and once more when the app quits.
 */
import fs from 'node:fs'
import os from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { ConflictInfo, SyncStatus } from '@shared/ipc'
import { writeFileAtomic } from '../fs/atomicWrite'
import { serializeJson } from '../fs/jsonFile'
import { AppError } from '../errors'
import type { DocLeases } from '../docLeases'
import type { Library } from '../library/library'
import { CloudError, PreconditionFailed, type CloudStore } from './cloud'
import { SyncEngine, UNITS_PREFIX, type SyncHooks } from './engine'
import { fetchHistory, uploadHistory } from './history'
import { cleanUpCloud } from './cleanup'
import { syncDictionary } from './dictionary'
import { parseBucketUrl, S3Cloud } from './s3'
import { setupFromToken } from './cloudflare'
import { ConflictStore, type ConflictMeta } from './conflictStore'
import { isSyncablePath, isUnitKey, localUnits } from './units'

const START_DELAY_MS = 2_000
const PAUSE_MS = 30_000
const MAX_WAIT_MS = 120_000
const EVERY_MS = 5 * 60_000
const FOCUS_MIN_GAP_MS = 60_000
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]

const configSchema = z.looseObject({
  endpoint: z.string(),
  bucket: z.string(),
  accessKeyId: z.string(),
  /** The secret key, encrypted by the OS (base64), or plain when it can't encrypt. */
  secret: z.string(),
  encrypted: z.boolean(),
  device: z.string(),
  /** The library this is set up for (the id in its library.json). */
  libraryId: z.string(),
})
type SyncConfig = z.infer<typeof configSchema>

/** How secrets are kept on this computer (Electron's safeStorage in the app). */
export interface SecretBox {
  canEncrypt(): boolean
  encrypt(text: string): string
  decrypt(data: string): string
}

export interface SyncServiceOptions {
  userData: string
  leases: DocLeases
  secrets: SecretBox
  onStatus: (status: SyncStatus) => void
  onNotice: (message: string) => void
  /** Sync is replacing (true) or has replaced (false) a world's map, board or templates. */
  onHold?: (worldId: string, held: boolean) => void
  /** For tests: a cloud instead of R2. */
  makeCloud?: (config: SyncConfig, secret: string) => CloudStore
  /**
   * How to make web requests. The app uses Electron's (Chromium's network
   * stack, like a browser): Cloudflare's storage refuses some connections
   * from Node's built-in one.
   */
  fetchImpl?: typeof fetch
  /** The personal dictionary (the one setting that syncs). */
  dictionary?: { read(): Promise<string[]>; write(words: string[]): Promise<void> }
  /** For tests: where the Cloudflare API is. */
  tokenSetup?: Parameters<typeof setupFromToken>[1]
}

export const defaultDeviceName = () =>
  os
    .hostname()
    .replace(/\.(local|lan|home)$/i, '')
    .slice(0, 60) || 'This computer'

export class SyncService {
  private library: Library | null = null
  private config: SyncConfig | null = null
  private cloud: CloudStore | null = null
  private engine: SyncEngine | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private due = Infinity
  private running: Promise<void> | null = null
  private again = false
  private firstChangeAt: number | null = null
  private failures = 0
  private lastRunAt = 0
  private countTimer: ReturnType<typeof setTimeout> | undefined
  private current: SyncStatus = {
    connected: false,
    state: 'off',
    pending: 0,
    lastSyncedAt: null,
    message: null,
    device: defaultDeviceName(),
    bucket: null,
  }

  constructor(private readonly options: SyncServiceOptions) {}

  private get configFile() {
    return join(this.options.userData, 'sync.json')
  }

  status(): SyncStatus {
    return this.current
  }

  private setStatus(patch: Partial<SyncStatus>) {
    this.current = { ...this.current, ...patch }
    this.options.onStatus(this.current)
  }

  /** The library that's open now (or none). Sync starts if it's the one set up. */
  async attach(library: Library | null): Promise<void> {
    this.stop()
    this.library = library
    this.config = await this.readConfig()
    if (library && this.config && this.config.libraryId === library.info.id) {
      this.start(this.config)
    } else {
      this.setStatus({
        connected: false,
        state: 'off',
        pending: 0,
        message: null,
        bucket: null,
        device: this.config?.device ?? defaultDeviceName(),
      })
    }
  }

  private start(config: SyncConfig) {
    const library = this.library!
    let secret: string
    try {
      secret = config.encrypted ? this.options.secrets.decrypt(config.secret) : config.secret
    } catch {
      this.setStatus({
        connected: false,
        state: 'error',
        message: 'The saved keys can’t be read on this computer. Connect again in Settings → Sync.',
      })
      return
    }
    this.cloud =
      this.options.makeCloud?.(config, secret) ?? cloudFor(config, secret, this.options.fetchImpl)
    const hooks: SyncHooks = {
      lock: (unit, task) => library.lockUnit(unit, task),
      borrow: (unit, rels) => this.borrow(unit, rels),
      beforeReplace: (unit, rel) => library.keepBeforeSync(unit, rel),
      trashFile: (unit, rel) => library.trashSyncedFile(unit, rel),
      trashUnit: (unit) => library.trashSyncedUnit(unit),
      changed: (unit, rels, unitChanged) => void library.syncedChanges(unit, rels, unitChanged),
      notice: (message) => this.options.onNotice(message),
    }
    this.engine = new SyncEngine({
      root: library.root,
      stateDir: join(library.paths.localDir, 'sync'),
      cloud: this.cloud,
      device: config.device,
      hooks,
    })
    this.failures = 0
    this.setStatus({
      connected: true,
      state: 'idle',
      message: null,
      bucket: config.bucket,
      device: config.device,
    })
    this.schedule(START_DELAY_MS)
  }

  private stop() {
    clearTimeout(this.timer)
    clearTimeout(this.countTimer)
    this.timer = undefined
    this.due = Infinity
    this.engine = null
    this.cloud = null
  }

  /* ---------- when ---------- */

  private schedule(ms: number) {
    if (!this.engine) return
    const at = Date.now() + ms
    if (at >= this.due && this.timer) return
    clearTimeout(this.timer)
    this.due = at
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.due = Infinity
      void this.run()
    }, ms)
  }

  /** Something in the library was saved. */
  noteChange(): void {
    if (!this.engine) return
    const now = Date.now()
    this.firstChangeAt ??= now
    this.schedule(Math.max(0, Math.min(PAUSE_MS, this.firstChangeAt + MAX_WAIT_MS - now)))
    clearTimeout(this.countTimer)
    this.countTimer = setTimeout(() => void this.recount(), 3_000)
  }

  /** A window came back into focus: see what the other computer did. */
  focused(): void {
    if (this.engine && Date.now() - this.lastRunAt > FOCUS_MIN_GAP_MS) this.schedule(500)
  }

  private async recount() {
    if (!this.engine || this.running) return
    try {
      this.setStatus({ pending: await this.engine.pending() })
    } catch {
      // Only a count.
    }
  }

  /** One sync now (or right after the one running). */
  private run(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    const engine = this.engine
    if (!engine) return Promise.resolve()
    this.running = (async () => {
      this.firstChangeAt = null
      this.lastRunAt = Date.now()
      this.setStatus({ state: 'syncing' })
      try {
        const report = await engine.cycle()
        if (engine !== this.engine) return
        await uploadHistory(
          this.cloud!,
          join(this.library!.paths.localDir, 'history'),
          join(this.library!.paths.localDir, 'sync'),
        ).catch((err: unknown) => {
          if (err instanceof CloudError) throw err
        })
        if (this.options.dictionary) {
          const words = await syncDictionary(
            this.cloud!,
            join(this.library!.paths.localDir, 'sync'),
            await this.options.dictionary.read(),
          )
          if (words) await this.options.dictionary.write(words)
        }
        await this.weeklyCleanUp()
        this.failures = 0
        this.setStatus({
          state: report.problems.length ? 'error' : 'idle',
          message: report.problems.length ? report.problems.join('\n') : null,
          lastSyncedAt: new Date().toISOString(),
          pending: await engine.pending(),
        })
        this.schedule(EVERY_MS)
      } catch (err) {
        if (engine !== this.engine) return
        const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!
        this.failures++
        const offline = err instanceof CloudError && err.kind === 'offline'
        this.setStatus({
          state: offline ? 'offline' : 'error',
          message: err instanceof Error ? err.message : String(err),
          pending: await engine.pending().catch(() => this.current.pending),
        })
        this.schedule(wait)
      }
    })().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        this.schedule(1_000)
      }
    })
    return this.running
  }

  /** At most once a week, from each computer: clear unused copies out of the cloud. */
  private async weeklyCleanUp() {
    if (!this.cloud || !this.library) return
    const record = join(this.library.paths.localDir, 'sync', 'cleanup.json')
    const last = await fs.promises
      .readFile(record, 'utf8')
      .then((t) => Number((JSON.parse(t) as { at?: number }).at) || 0)
      .catch(() => 0)
    if (Date.now() - last < 7 * 86_400_000) return
    try {
      await cleanUpCloud(this.cloud, this.library.root)
      await writeFileAtomic(record, serializeJson({ formatVersion: 1, at: Date.now() }))
    } catch {
      // Only tidying: try again next time.
    }
  }

  /** How much the library takes in the cloud (one listing). */
  async usage(): Promise<{ bytes: number; files: number } | null> {
    if (!this.cloud) return null
    const objects = await this.cloud.list('library/')
    return { bytes: objects.reduce((n, o) => n + o.size, 0), files: objects.length }
  }

  /* ---------- versions set aside ---------- */

  private conflictStore(): { library: Library; store: ConflictStore } {
    const library = this.library
    if (!library) throw new AppError('invalid-input', 'No library is open.')
    return { library, store: new ConflictStore(join(library.paths.localDir, 'sync', 'conflicts')) }
  }

  /** Versions set aside when both computers changed something (newest first). */
  async conflicts(): Promise<ConflictInfo[]> {
    if (!this.library) return []
    const { library, store } = this.conflictStore()
    const out: ConflictInfo[] = []
    for (const meta of await store.list()) {
      const bytes = await store
        .read(meta.id)
        .then((r) => r.bytes)
        .catch(() => null)
      out.push({
        id: meta.id,
        what: describeFile(meta.rel, bytes),
        where: await describeUnit(library, meta.unit),
        device: meta.device,
        savedAt: meta.savedAt,
        reason: meta.reason,
      })
    }
    return out
  }

  /**
   * Puts a set-aside version back. The version it replaces is set aside in
   * its place (so restoring is undone by restoring that one), and kept in
   * history for a chapter.
   */
  async restoreConflict(id: string): Promise<void> {
    const { library, store } = this.conflictStore()
    const { meta, bytes } = await store.read(id)
    if (!isUnitKey(meta.unit) || !isSyncablePath(meta.unit, meta.rel)) {
      throw new AppError('invalid-input', 'That version can’t be put back.')
    }
    const dir = join(library.root, meta.unit)
    if (!fs.existsSync(dir)) {
      throw new AppError('not-found', 'What it belonged to has been deleted.')
    }
    const path = join(dir, meta.rel)
    const release = await this.borrow(meta.unit, [meta.rel])
    try {
      await library.lockUnit(meta.unit, async () => {
        const current = await fs.promises.readFile(path).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null
          throw err
        })
        if (current) {
          await store.save({
            unit: meta.unit,
            rel: meta.rel,
            device: '',
            at: new Date().toISOString(),
            reason: 'replaced',
            bytes: current,
          })
          await library.keepBeforeSync(meta.unit, meta.rel)
        }
        await fs.promises.mkdir(dirname(path), { recursive: true })
        await writeFileAtomic(path, bytes)
      })
    } finally {
      release()
    }
    await store.remove(id)
    await library.syncedChanges(meta.unit, [meta.rel], false)
    this.noteChange()
  }

  async deleteConflict(id: string): Promise<void> {
    await this.conflictStore().store.remove(id)
  }

  /**
   * Before sync replaces files: whoever edits a chapter or an entry page saves
   * and waits; a world's map, board and template screens pause, and saves
   * they make from the version being replaced are refused (they reload).
   */
  private async borrow(unit: string, rels: string[]): Promise<() => void> {
    const worldId = /^worlds\/([^/]+)$/.exec(unit)?.[1]
    const layout = worldId ? rels.some(isLayoutFile) : false
    if (worldId && layout) {
      this.library?.world.syncReplaced(worldId)
      this.options.onHold?.(worldId, true)
    }
    const release = await this.options.leases.borrow(rels.flatMap(docKey))
    return () => {
      release()
      if (worldId && layout) {
        // Again once written: a view read meanwhile showed the old version.
        this.library?.world.syncReplaced(worldId)
        this.options.onHold?.(worldId, false)
      }
    }
  }

  async syncNow(): Promise<SyncStatus> {
    if (!this.engine) throw new AppError('invalid-input', 'Sync isn’t set up for this library.')
    clearTimeout(this.timer)
    this.timer = undefined
    this.due = Infinity
    await this.run()
    return this.current
  }

  /** Before quitting: send what's left, if it can be done quickly. */
  async flush(timeoutMs: number): Promise<void> {
    if (!this.engine) return
    const pending = await this.engine.pending().catch(() => 0)
    if (!pending && !this.running) return
    await Promise.race([this.running ?? this.run(), new Promise((r) => setTimeout(r, timeoutMs))])
    if (this.running) return
    if ((await this.engine?.pending().catch(() => 0)) && this.engine) {
      await Promise.race([this.run(), new Promise((r) => setTimeout(r, timeoutMs))])
    }
  }

  /* ---------- setting up ---------- */

  async connect(
    input: { device: string; confirm?: boolean } & (
      { token: string } | { url: string; accessKeyId: string; secretAccessKey: string }
    ),
  ): Promise<{ status: SyncStatus } | { confirm: { series: number; worlds: number } }> {
    const library = this.library
    if (!library) throw new AppError('no-library', 'Open a library first.')
    let where: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string }
    if ('token' in input) {
      where = await setupFromToken(input.token, {
        ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
        ...this.options.tokenSetup,
      })
    } else {
      const parsed = parseBucketUrl(input.url)
      if (!parsed?.bucket) {
        throw new AppError(
          'invalid-input',
          'Paste the bucket’s S3 API address; it ends with the bucket’s name (…cloudflarestorage.com/your-bucket).',
        )
      }
      where = { ...parsed, accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }
    }
    const config: SyncConfig = {
      endpoint: where.endpoint,
      bucket: where.bucket,
      accessKeyId: where.accessKeyId,
      secret: where.secretAccessKey,
      encrypted: false,
      device: input.device,
      libraryId: library.info.id,
    }
    const cloud =
      this.options.makeCloud?.(config, where.secretAccessKey) ??
      cloudFor(config, where.secretAccessKey, this.options.fetchImpl)
    await checkCloud(cloud)

    // Both sides hold work: say what will happen before putting them together.
    const inCloud = await cloudContents(cloud)
    if (!input.confirm && inCloud.series + inCloud.worlds > 0) {
      const here = await localUnits(library.root)
      if (here.length > 0) return { confirm: inCloud }
    }

    if (this.options.secrets.canEncrypt()) {
      config.secret = this.options.secrets.encrypt(where.secretAccessKey)
      config.encrypted = true
    }
    await writeFileAtomic(this.configFile, serializeJson({ formatVersion: 1, ...config }))
    this.stop()
    this.config = config
    this.start(config)
    return { status: this.current }
  }

  async disconnect(): Promise<SyncStatus> {
    this.stop()
    await fs.promises.rm(this.configFile, { force: true })
    this.config = null
    this.setStatus({ connected: false, state: 'off', message: null, bucket: null, pending: 0 })
    return this.current
  }

  async fetchHistory(volumeId: string, chapterId: string): Promise<number> {
    if (!this.cloud || !this.library) return 0
    return fetchHistory(
      this.cloud,
      join(this.library.paths.localDir, 'history'),
      volumeId,
      chapterId,
    )
  }

  private async readConfig(): Promise<SyncConfig | null> {
    try {
      const raw: unknown = JSON.parse(await fs.promises.readFile(this.configFile, 'utf8'))
      const parsed = configSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
}

function cloudFor(config: SyncConfig, secret: string, fetchImpl?: typeof fetch): CloudStore {
  return new S3Cloud(
    {
      endpoint: config.endpoint,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: secret,
    },
    fetchImpl,
  )
}

/** The editing lease of a synced file, if it's a document someone could be typing in. */
/** What a set-aside file is, in words. */
function describeFile(rel: string, bytes: Uint8Array | null): string {
  let data: Record<string, unknown> = {}
  try {
    if (bytes) data = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } catch {
    // Not JSON (an image): described by its path.
  }
  const named = (key: string) =>
    typeof data[key] === 'string' && data[key] ? `“${String(data[key])}”` : ''
  if (rel === 'outline.json') return 'Chapter order'
  if (rel === 'board.json') return 'People board layout'
  if (rel === 'templates.json') return 'Templates'
  if (rel === 'relationship-types.json') return 'Relationship types'
  if (rel === 'rejected.json') return 'Turned-down name suggestions'
  if (rel === 'world.json') return 'World settings'
  if (rel === 'series.json') return 'Story settings'
  if (rel === 'volume.json') return 'Book settings'
  if (rel === 'inbox.json' || rel.startsWith('inbox/')) return 'Inbox'
  if (rel.startsWith('maps/')) return `Map ${named('name')}`.trim()
  if (rel.startsWith('ai/')) return `AI conversation ${named('title')}`.trim()
  if (rel.startsWith('relationships/')) return 'A relationship'
  if (rel.startsWith('chapters/')) return `Chapter ${named('title')}`.trim()
  if (rel.startsWith('entries/')) return `Entry ${named('name')}`.trim()
  if (rel.startsWith('images/')) return 'An image'
  return rel
}

/** Which story, book or world a unit is. */
async function describeUnit(library: Library, unit: ConflictMeta['unit']): Promise<string> {
  const parts = unit.split('/')
  try {
    if (parts[0] === 'worlds') return (await library.getWorld(parts[1]!)).name
    const series = await library.getSeries(parts[1]!)
    if (parts.length < 4) return series.name
    return `${series.name} › ${(await library.getVolume(parts[1]!, parts[3]!)).name}`
  } catch {
    return 'Something since deleted'
  }
}

/** A world file shown in the map, board or template screens. */
function isLayoutFile(rel: string): boolean {
  return (
    rel.startsWith('maps/') ||
    rel === 'board.json' ||
    rel === 'templates.json' ||
    rel === 'relationship-types.json'
  )
}

function docKey(rel: string): string[] {
  const chapter = /^chapters\/([^/]+)\.json$/.exec(rel)?.[1]
  if (chapter) return [`chapter:${chapter}`]
  const entry = /^entries\/([^/]+)\.json$/.exec(rel)?.[1]
  return entry ? [`entry:${entry}`] : []
}

/**
 * Checks the keys work and the store supports safe uploads (a write that's
 * refused when something is already there). Without that, sync can't
 * promise to never overwrite, so it won't start.
 */
async function checkCloud(cloud: CloudStore): Promise<void> {
  try {
    await cloud.list(UNITS_PREFIX)
    const key = `library/check-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const body = new TextEncoder().encode('ok')
    await cloud.put(key, body, { ifNoneMatch: '*' })
    let safe = false
    try {
      await cloud.put(key, body, { ifNoneMatch: '*' })
    } catch (err) {
      if (err instanceof PreconditionFailed) safe = true
      else throw err
    }
    await cloud.delete(key)
    if (!safe) {
      throw new AppError(
        'invalid-input',
        'This storage doesn’t support safe uploads (conditional writes), so sync can’t promise not to overwrite. Use Cloudflare R2.',
      )
    }
  } catch (err) {
    if (err instanceof CloudError) {
      throw new AppError(
        'invalid-input',
        err.kind === 'auth'
          ? `${err.message} Check the access key and secret, and that the token can edit this bucket.`
          : err.kind === 'offline'
            ? 'Couldn’t reach the bucket. Check the address and your connection.'
            : err.message,
      )
    }
    throw err
  }
}

/** How many series and worlds the cloud already holds (not counting deleted ones). */
async function cloudContents(cloud: CloudStore): Promise<{ series: number; worlds: number }> {
  let series = 0
  let worlds = 0
  for (const o of await cloud.list(UNITS_PREFIX)) {
    const unit = o.key.slice(UNITS_PREFIX.length).replace(/\.json$/, '')
    const kind = /^series\/[^/]+$/.test(unit)
      ? 'series'
      : /^worlds\/[^/]+$/.test(unit)
        ? 'world'
        : null
    if (!kind) continue
    const got = await cloud.get(o.key)
    try {
      const m = JSON.parse(new TextDecoder().decode(got?.body)) as { deleted?: boolean }
      if (m.deleted) continue
    } catch {
      // Count it anyway.
    }
    if (kind === 'series') series++
    else worlds++
  }
  return { series, worlds }
}
