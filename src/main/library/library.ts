/**
 * The library service. Owns every read and write of library files.
 *
 * Rules it enforces:
 * - every write is atomic (temp file + rename);
 * - writes to one sync unit (a volume or a world) are serialised;
 * - a file that can't be read is reported, never overwritten or deleted;
 * - reordering touches only outline.json and can never drop a chapter.
 */
import fs from 'node:fs'
import type { z } from 'zod'
import { join, relative, sep } from 'node:path'
import {
  FORMAT_VERSION,
  chapterFileSchema,
  emptyDoc,
  libraryFileSchema,
  manifestFileSchema,
  outlineFileSchema,
  seriesFileSchema,
  timelineFileSchema,
  volumeFileSchema,
  worldFileSchema,
  type ChapterFile,
  type ChapterType,
  type LibraryFile,
  type ManifestFile,
  type OutlineFile,
  type SeriesFile,
  type VolumeFile,
  type WorldFile,
} from '@shared/schema'
import { newId } from '@shared/ids'
import type {
  LibraryChange,
  LibraryProblem,
  LibrarySnapshot,
  OutlineView,
  SeriesSummary,
} from '@shared/ipc'
import { AppError } from '../errors'
import { isTempFileName, removeStaleTempFiles } from '../fs/atomicWrite'
import { KeyedLock } from '../fs/keyedLock'
import { pathExists, readJsonFile, sha256, writeJsonFile } from '../fs/jsonFile'
import { LibraryPaths, unitPaths } from './paths'

type UnitType = ManifestFile['unitType']

export interface LibraryOptions {
  /** Create a new library if the folder is empty or missing. */
  create?: boolean
  onChange?: (change: LibraryChange) => void
  /** Injectable clock, for tests. */
  now?: () => Date
}

export class Library {
  readonly paths: LibraryPaths
  private readonly lock = new KeyedLock()
  private readonly onChange: (change: LibraryChange) => void
  private readonly now: () => Date

  private constructor(
    root: string,
    readonly info: LibraryFile,
    options: LibraryOptions,
  ) {
    this.paths = new LibraryPaths(root)
    this.onChange = options.onChange ?? (() => {})
    this.now = options.now ?? (() => new Date())
  }

  /** Opens an existing library, or creates one in an empty/missing folder when `create` is set. */
  static async open(root: string, options: LibraryOptions = {}): Promise<Library> {
    const paths = new LibraryPaths(root)
    let info: LibraryFile
    if (await pathExists(paths.libraryFile)) {
      info = await readJsonFile(paths.libraryFile, libraryFileSchema)
    } else {
      if (!(await isEmptyOrMissing(root))) {
        throw new AppError(
          'not-a-library',
          'This folder already has other files in it. Choose an empty folder or an existing library.',
        )
      }
      if (!options.create) throw new AppError('not-a-library', `No library found at ${root}`)
      await fs.promises.mkdir(root, { recursive: true })
      info = {
        formatVersion: FORMAT_VERSION,
        id: newId('library'),
        createdAt: (options.now?.() ?? new Date()).toISOString(),
      }
      await writeJsonFile(paths.libraryFile, info)
    }
    await Promise.all([
      fs.promises.mkdir(paths.seriesRoot, { recursive: true }),
      fs.promises.mkdir(paths.worldsRoot, { recursive: true }),
      fs.promises.mkdir(paths.localDir, { recursive: true }),
    ])
    await removeStaleTempFiles(root)
    return new Library(root, info, options)
  }

  get root(): string {
    return this.paths.root
  }

  /* ---------- reading ---------- */

  async snapshot(): Promise<LibrarySnapshot> {
    const problems: LibraryProblem[] = []
    const series: SeriesSummary[] = []
    for (const seriesId of await listDirs(this.paths.seriesRoot)) {
      const file = await this.tryRead(this.paths.seriesFile(seriesId), seriesFileSchema, problems)
      if (!file) continue
      series.push({ ...file, volumes: await this.readVolumes(file, problems) })
    }
    const worlds: WorldFile[] = []
    for (const worldId of await listDirs(this.paths.worldsRoot)) {
      const file = await this.tryRead(this.paths.worldFile(worldId), worldFileSchema, problems)
      if (file) worlds.push(file)
    }
    series.sort(byName)
    worlds.sort(byName)
    return { root: this.root, series, worlds, problems }
  }

  /** Volumes in the series' order, followed by any found on disk but missing from it. */
  private async readVolumes(series: SeriesFile, problems: LibraryProblem[]): Promise<VolumeFile[]> {
    const onDisk = await listDirs(this.paths.volumesDir(series.id))
    const ordered = [
      ...series.volumeOrder.filter((id) => onDisk.includes(id)),
      ...onDisk.filter((id) => !series.volumeOrder.includes(id)),
    ]
    const volumes: VolumeFile[] = []
    for (const volumeId of ordered) {
      const path = join(this.paths.volumeDir(series.id, volumeId), unitPaths.volume)
      const file = await this.tryRead(path, volumeFileSchema, problems)
      if (file) volumes.push(file)
    }
    return volumes
  }

  async getSeries(seriesId: string): Promise<SeriesFile> {
    return readJsonFile(this.paths.seriesFile(seriesId), seriesFileSchema)
  }

  async getVolume(seriesId: string, volumeId: string): Promise<VolumeFile> {
    const dir = this.paths.volumeDir(seriesId, volumeId)
    return readJsonFile(join(dir, unitPaths.volume), volumeFileSchema)
  }

  async getWorld(worldId: string): Promise<WorldFile> {
    return readJsonFile(this.paths.worldFile(worldId), worldFileSchema)
  }

  async readChapter(seriesId: string, volumeId: string, chapterId: string): Promise<ChapterFile> {
    const dir = this.paths.volumeDir(seriesId, volumeId)
    return readJsonFile(join(dir, unitPaths.chapter(chapterId)), chapterFileSchema)
  }

  /**
   * The outline as drawn in the binder. Chapters on disk but missing from the
   * outline (for example after a crash between two writes) are shown at the
   * end rather than hidden. References to missing chapters are left out.
   */
  async getOutline(seriesId: string, volumeId: string): Promise<OutlineView> {
    await this.getVolume(seriesId, volumeId)
    const dir = this.paths.volumeDir(seriesId, volumeId)
    const problems: LibraryProblem[] = []
    const stored = await readJsonFile(join(dir, unitPaths.outline), outlineFileSchema)
    const chapters: OutlineView['chapters'] = {}
    const chapterDir = this.paths.chaptersDir(seriesId, volumeId)
    for (const chapterId of await this.chapterIdsOnDisk(seriesId, volumeId)) {
      const file = await this.tryRead(
        join(chapterDir, `${chapterId}.json`),
        chapterFileSchema,
        problems,
      )
      // Unreadable chapters still appear (by id) so they are never silently lost.
      chapters[chapterId] = file
        ? { id: file.id, title: file.title, type: file.type, pov: file.pov }
        : { id: chapterId, title: '(unreadable chapter)', type: 'chapter', pov: null }
    }

    const seen = new Set<string>()
    const keep = (chapterId: string): boolean => {
      if (seen.has(chapterId) || !(chapterId in chapters)) return false
      seen.add(chapterId)
      return true
    }
    const items: OutlineFile['items'] = []
    for (const item of stored.items) {
      if (item.type === 'arc') items.push({ ...item, chapterIds: item.chapterIds.filter(keep) })
      else if (keep(item.id)) items.push(item)
    }
    for (const chapterId of Object.keys(chapters)) {
      if (!seen.has(chapterId)) {
        items.push({ type: 'chapter', id: chapterId })
        problems.push({
          path: this.rel(join(chapterDir, `${chapterId}.json`)),
          message: 'Chapter was missing from the outline and has been placed at the end.',
        })
      }
    }
    return { outline: { ...stored, items }, chapters, problems }
  }

  /* ---------- series ---------- */

  async createSeries(input: {
    name: string
    world: { mode: 'none' } | { mode: 'existing'; worldId: string } | { mode: 'new'; name: string }
  }): Promise<SeriesFile> {
    let worldId: string | null = null
    if (input.world.mode === 'existing') worldId = (await this.getWorld(input.world.worldId)).id
    if (input.world.mode === 'new')
      worldId = (await this.createWorld({ name: input.world.name })).id

    const time = this.timestamp()
    const series: SeriesFile = {
      formatVersion: FORMAT_VERSION,
      id: newId('series'),
      name: input.name.trim(),
      worldId,
      volumeOrder: [],
      createdAt: time,
      updatedAt: time,
    }
    await this.lock.run(`series:${series.id}`, async () => {
      await fs.promises.mkdir(this.paths.volumesDir(series.id), { recursive: true })
      await writeJsonFile(this.paths.seriesFile(series.id), series)
    })
    this.onChange({ kind: 'series', seriesId: series.id })
    return series
  }

  async setSeriesWorld(seriesId: string, worldId: string | null): Promise<SeriesFile> {
    if (worldId) await this.getWorld(worldId)
    const updated = await this.lock.run(`series:${seriesId}`, async () => {
      const series = await this.getSeries(seriesId)
      const next = { ...series, worldId, updatedAt: this.timestamp() }
      await writeJsonFile(this.paths.seriesFile(seriesId), next)
      return next
    })
    this.onChange({ kind: 'series', seriesId })
    return updated
  }

  /* ---------- volumes ---------- */

  async createVolume(input: { seriesId: string; name: string }): Promise<VolumeFile> {
    const { seriesId } = input
    await this.getSeries(seriesId)
    const time = this.timestamp()
    const volume: VolumeFile = {
      formatVersion: FORMAT_VERSION,
      id: newId('volume'),
      seriesId,
      name: input.name.trim(),
      settings: {},
      goals: { projectWords: null, sessionWords: null },
      createdAt: time,
      updatedAt: time,
    }
    const outline: OutlineFile = { formatVersion: FORMAT_VERSION, volumeId: volume.id, items: [] }

    // Volume files first, then the series' order: a crash in between leaves a
    // volume that snapshot() still lists, never an order entry with no files.
    await this.lock.run(`volume:${volume.id}`, async () => {
      await fs.promises.mkdir(this.paths.chaptersDir(seriesId, volume.id), { recursive: true })
      await this.writeVolumeFile(seriesId, volume.id, unitPaths.volume, volume)
      await this.writeVolumeFile(seriesId, volume.id, unitPaths.outline, outline)
    })
    await this.lock.run(`series:${seriesId}`, async () => {
      const series = await this.getSeries(seriesId)
      const next = { ...series, volumeOrder: [...series.volumeOrder, volume.id], updatedAt: time }
      await writeJsonFile(this.paths.seriesFile(seriesId), next)
    })
    this.onChange({ kind: 'volume', seriesId, volumeId: volume.id })
    return volume
  }

  /* ---------- outline ---------- */

  async createArc(input: {
    seriesId: string
    volumeId: string
    name: string
  }): Promise<OutlineView> {
    const { seriesId, volumeId } = input
    await this.lock.run(`volume:${volumeId}`, async () => {
      const outline = await this.readStoredOutline(seriesId, volumeId)
      outline.items.push({
        type: 'arc',
        id: newId('arc'),
        name: input.name.trim(),
        finished: false,
        chapterIds: [],
      })
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.outline, outline)
    })
    this.onChange({ kind: 'outline', seriesId, volumeId })
    return this.getOutline(seriesId, volumeId)
  }

  /**
   * Replaces the outline (reorder, move between arcs, rename arcs). Refused
   * unless it lists every chapter on disk exactly once, so a reorder can
   * never lose a chapter.
   */
  async saveOutline(
    seriesId: string,
    volumeId: string,
    outline: OutlineFile,
  ): Promise<OutlineView> {
    if (outline.volumeId !== volumeId) {
      throw new AppError('invalid-input', 'Outline belongs to a different volume.')
    }
    await this.lock.run(`volume:${volumeId}`, async () => {
      await this.getVolume(seriesId, volumeId)
      const onDisk = new Set(await this.chapterIdsOnDisk(seriesId, volumeId))
      const listed: string[] = []
      const arcIds = new Set<string>()
      for (const item of outline.items) {
        if (item.type === 'arc') {
          if (arcIds.has(item.id))
            throw new AppError('invalid-input', `Arc ${item.id} is listed twice.`)
          arcIds.add(item.id)
          listed.push(...item.chapterIds)
        } else listed.push(item.id)
      }
      const listedSet = new Set(listed)
      if (listedSet.size !== listed.length) {
        throw new AppError('invalid-input', 'A chapter is listed more than once in the outline.')
      }
      const missing = [...onDisk].filter((id) => !listedSet.has(id))
      const unknown = listed.filter((id) => !onDisk.has(id))
      if (missing.length || unknown.length) {
        throw new AppError(
          'conflict',
          'The outline is out of date with the chapters on disk. Reload and try again.',
        )
      }
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.outline, {
        ...outline,
        formatVersion: FORMAT_VERSION,
      })
    })
    this.onChange({ kind: 'outline', seriesId, volumeId })
    return this.getOutline(seriesId, volumeId)
  }

  /* ---------- chapters ---------- */

  async createChapter(input: {
    seriesId: string
    volumeId: string
    title: string
    type?: ChapterType
    arcId?: string
  }): Promise<ChapterFile> {
    const { seriesId, volumeId } = input
    const time = this.timestamp()
    const chapter: ChapterFile = {
      formatVersion: FORMAT_VERSION,
      id: newId('chapter'),
      volumeId,
      title: input.title.trim(),
      type: input.type ?? 'chapter',
      pov: null,
      notes: '',
      content: emptyDoc(),
      createdAt: time,
      updatedAt: time,
    }
    await this.lock.run(`volume:${volumeId}`, async () => {
      await this.getVolume(seriesId, volumeId)
      const outline = await this.readStoredOutline(seriesId, volumeId)
      const arc = input.arcId
        ? outline.items.find((item) => item.type === 'arc' && item.id === input.arcId)
        : undefined
      if (input.arcId && !arc) throw new AppError('not-found', 'That arc no longer exists.')

      // Chapter file first: if the outline write fails, getOutline() still shows it.
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.chapter(chapter.id), chapter)
      if (arc?.type === 'arc') arc.chapterIds.push(chapter.id)
      else outline.items.push({ type: 'chapter', id: chapter.id })
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.outline, outline)
    })
    this.onChange({ kind: 'outline', seriesId, volumeId })
    return chapter
  }

  /** Saves a chapter the user edited. The chapter must already exist; createdAt is kept. */
  async saveChapter(
    seriesId: string,
    volumeId: string,
    chapter: ChapterFile,
  ): Promise<ChapterFile> {
    if (chapter.volumeId !== volumeId) {
      throw new AppError('invalid-input', 'Chapter belongs to a different volume.')
    }
    const saved = await this.lock.run(`volume:${volumeId}`, async () => {
      const existing = await this.readChapter(seriesId, volumeId, chapter.id)
      const next: ChapterFile = {
        ...chapter,
        formatVersion: FORMAT_VERSION,
        createdAt: existing.createdAt,
        updatedAt: this.timestamp(),
      }
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.chapter(chapter.id), next)
      return next
    })
    this.onChange({ kind: 'chapter', seriesId, volumeId, chapterId: chapter.id })
    return saved
  }

  /* ---------- worlds ---------- */

  async createWorld(input: { name: string }): Promise<WorldFile> {
    const time = this.timestamp()
    const world: WorldFile = {
      formatVersion: FORMAT_VERSION,
      id: newId('world'),
      name: input.name.trim(),
      categories: [],
      createdAt: time,
      updatedAt: time,
    }
    await this.lock.run(`world:${world.id}`, async () => {
      await fs.promises.mkdir(join(this.paths.worldDir(world.id), 'entries'), { recursive: true })
      await this.writeWorldFile(
        world.id,
        unitPaths.timeline,
        timelineFileSchema.parse({
          formatVersion: FORMAT_VERSION,
          worldId: world.id,
          events: [],
        }),
      )
      // world.json last: a world only shows up once it is complete.
      await this.writeWorldFile(world.id, unitPaths.world, world)
    })
    this.onChange({ kind: 'world', worldId: world.id })
    return world
  }

  /* ---------- manifests ---------- */

  /** Rebuilds a unit's manifest from the files on disk. */
  async rebuildManifest(
    unitType: UnitType,
    unitDir: string,
    unitId: string,
  ): Promise<ManifestFile> {
    const manifest: ManifestFile = { formatVersion: FORMAT_VERSION, unitType, unitId, files: {} }
    for (const file of await listFilesRecursive(unitDir)) {
      const rel = relative(unitDir, file).split(sep).join('/')
      if (rel === unitPaths.manifest) continue
      const [bytes, stat] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)])
      manifest.files[rel] = {
        hash: sha256(bytes),
        size: bytes.byteLength,
        modifiedAt: stat.mtime.toISOString(),
      }
    }
    await writeJsonFile(join(unitDir, unitPaths.manifest), manifest)
    return manifest
  }

  /* ---------- internals ---------- */

  private async readStoredOutline(seriesId: string, volumeId: string): Promise<OutlineFile> {
    const dir = this.paths.volumeDir(seriesId, volumeId)
    return readJsonFile(join(dir, unitPaths.outline), outlineFileSchema)
  }

  private async chapterIdsOnDisk(seriesId: string, volumeId: string): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.promises.readdir(this.paths.chaptersDir(seriesId, volumeId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return names
      .filter((name) => name.endsWith('.json') && !isTempFileName(name))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  }

  /** Call only while holding the volume's lock. */
  private writeVolumeFile(seriesId: string, volumeId: string, rel: string, value: unknown) {
    return this.writeUnitFile(
      'volume',
      this.paths.volumeDir(seriesId, volumeId),
      volumeId,
      rel,
      value,
    )
  }

  /** Call only while holding the world's lock. */
  private writeWorldFile(worldId: string, rel: string, value: unknown) {
    return this.writeUnitFile('world', this.paths.worldDir(worldId), worldId, rel, value)
  }

  /** Writes a file inside a sync unit and records its hash in the unit's manifest. */
  private async writeUnitFile(
    unitType: UnitType,
    unitDir: string,
    unitId: string,
    rel: string,
    value: unknown,
  ): Promise<void> {
    const { hash, size } = await writeJsonFile(join(unitDir, rel), value)
    const manifestPath = join(unitDir, unitPaths.manifest)
    let manifest: ManifestFile
    try {
      manifest = await readJsonFile(manifestPath, manifestFileSchema)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      // Missing or damaged manifest: it is derived data, so rebuild it from the files.
      await this.rebuildManifest(unitType, unitDir, unitId)
      return
    }
    manifest.files[rel] = { hash, size, modifiedAt: this.timestamp() }
    await writeJsonFile(manifestPath, manifest)
  }

  private async tryRead<S extends z.ZodType>(
    path: string,
    schema: S,
    problems: LibraryProblem[],
  ): Promise<z.output<S> | null> {
    try {
      return await readJsonFile(path, schema)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      problems.push({ path: this.rel(path), message: err.message.replace(path, this.rel(path)) })
      return null
    }
  }

  private rel(path: string): string {
    return relative(this.root, path).split(sep).join('/')
  }

  private timestamp(): string {
    return this.now().toISOString()
  }
}

/* ---------- helpers ---------- */

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)))
    else if (entry.isFile() && !isTempFileName(entry.name)) out.push(full)
  }
  return out.sort()
}

/** True if the folder doesn't exist or holds only hidden files (like .DS_Store). */
async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    const names = await fs.promises.readdir(dir)
    return names.every((name) => name.startsWith('.'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw err
  }
}
