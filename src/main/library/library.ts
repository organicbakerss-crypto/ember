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
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { dirname, join, relative, sep } from 'node:path'
import {
  FORMAT_VERSION,
  chapterSummaryFileSchema,
  chapterSpeakersFileSchema,
  type ChapterSpeakersFile,
  type Speaker,
  type ChapterSummaryFile,
  chapterFileSchema,
  emptyDoc,
  libraryFileSchema,
  manifestFileSchema,
  outlineFileSchema,
  richTextDocSchema,
  seriesFileSchema,
  volumeFileSchema,
  worldEntryFileSchema,
  worldFileSchema,
  conversationFileSchema,
  type ConversationFile,
  type ChapterFile,
  type ChapterType,
  type LibraryFile,
  type ManifestFile,
  type OutlineFile,
  type SeriesFile,
  type VolumeFile,
  type WorldFile,
} from '@shared/schema'
import { idPattern, newId } from '@shared/ids'
import type {
  ConversationSummary,
  LibraryChange,
  LibraryProblem,
  LibrarySnapshot,
  OutlineView,
  SearchResult,
  SeriesSummary,
  SnapshotInfo,
  TrashEntry,
  TrashTarget,
  VolumeStats,
  VolumeSummary,
  WorldSummary,
} from '@shared/ipc'
import { SNAPSHOT_ID } from '@shared/ipc'
import { COVER_EXTENSIONS, detectImageType, type CoverInfo, type CoverTarget } from '@shared/media'
import { docToText, docWordCount } from '@shared/text'
import { docParagraphs } from '@shared/analysis/doc'
import { chapterLabels, type StoryChapter } from '@shared/world/story'
import {
  findInText,
  replaceInDoc,
  searchPattern,
  textNodes,
  type SearchOptions,
} from '@shared/search'
import { AppError } from '../errors'
import { isTempFileName, removeStaleTempFiles, writeFileAtomic } from '../fs/atomicWrite'
import { KeyedLock } from '../fs/keyedLock'
import { pathExists, readJsonFile, sha256, writeJsonFile } from '../fs/jsonFile'
import { snapshotsToKeep } from './retention'
import { LibraryPaths, unitPaths } from './paths'
import { WorldStore, type StoryText } from './world'

type UnitType = ManifestFile['unitType']

export type ChapterPatch = Partial<
  Pick<ChapterFile, 'title' | 'type' | 'pov' | 'povEntryId' | 'notes' | 'content'>
>

const MAX_SEARCH_HITS = 500
const SNIPPET = 40

/** A save that removes at least this many characters keeps the version before it. */
export const BIG_DELETION_CHARS = 20

/** At most one automatic snapshot per chapter in this span. */
export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000

const snapshotFileSchema = z.looseObject({
  formatVersion: z.number().int().positive(),
  id: z.string().regex(SNAPSHOT_ID),
  chapterId: z.string(),
  volumeId: z.string(),
  savedAt: z.iso.datetime(),
  reason: z
    .enum([
      'auto',
      'manual',
      'before-deletion',
      'before-restore',
      'before-replace',
      'before-sync',
      'before-ai',
      'after-ai',
    ])
    .catch('auto'),
  title: z.string(),
  wordCount: z.number().int().nonnegative(),
  contentHash: z.string(),
  content: richTextDocSchema,
})
type SnapshotFile = z.infer<typeof snapshotFileSchema>

const toSnapshotInfo = (file: SnapshotFile): SnapshotInfo => ({
  id: file.id,
  savedAt: file.savedAt,
  title: file.title,
  wordCount: file.wordCount,
  reason: file.reason,
})

/** Snapshot ids start with their time, with `:` and `.` written as `-`. */
function snapshotTime(snapshotId: string): Date {
  const [, date, h, m, sec, ms] =
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(snapshotId) ?? []
  return new Date(`${date}T${h}:${m}:${sec}.${ms}Z`)
}

const TRASH_NOTE = 'item.json'
const TRASH_CONTENT = 'content'

const trashItemSchema = z.looseObject({
  formatVersion: z.number().int().positive(),
  id: z.string().regex(idPattern('trash')),
  kind: z.enum(['series', 'volume', 'world', 'chapter', 'entry', 'map']),
  name: z.string(),
  from: z.string().nullable(),
  deletedAt: z.string(),
  origin: z.looseObject({
    seriesId: z.string().regex(idPattern('series')).optional(),
    volumeId: z.string().regex(idPattern('volume')).optional(),
    worldId: z.string().regex(idPattern('world')).optional(),
    chapterId: z.string().regex(idPattern('chapter')).optional(),
    entryId: z.string().regex(idPattern('entry')).optional(),
    mapId: z.string().regex(idPattern('map')).optional(),
    arc: z
      .object({ id: z.string().regex(idPattern('arc')), name: z.string(), index: z.number() })
      .nullable()
      .optional(),
    index: z.number().int().nonnegative().optional(),
    linkedSeries: z.array(z.string().regex(idPattern('series'))).optional(),
  }),
})
type TrashItem = z.infer<typeof trashItemSchema>

const toTrashEntry = (item: TrashItem): TrashEntry => ({
  id: item.id,
  kind: item.kind,
  name: item.name,
  deletedAt: item.deletedAt,
  from: item.from,
})

interface SyncUnit {
  type: UnitType
  dir: string
  id: string
}

interface ResolvedCoverTarget {
  dir: string
  lockKey: string
  /** Used to name the file when a cover is moved to the trash. */
  label: string
  /** The sync unit the cover belongs to, if any (series folders have no manifest yet). */
  unit: SyncUnit | null
  change: LibraryChange
}

export interface LibraryOptions {
  /** Create a new library if the folder is empty or missing. */
  create?: boolean
  onChange?: (change: LibraryChange) => void
  /** Injectable clock, for tests. */
  now?: () => Date
}

/** A chapter in reading order with its AI summary. */
export interface StorySummary {
  chapter: StoryChapter
  paragraphs: string[]
  textHash: string
  summary: string | null
  /** False when the chapter changed after the summary was made. */
  current: boolean
}

/** What a summary is checked against: the chapter's plain text. */
export const chapterTextHash = (paragraphs: string[]) => sha256(paragraphs.join('\n\n'))

export class Library {
  readonly paths: LibraryPaths
  private readonly lock = new KeyedLock()
  private readonly onChange: (change: LibraryChange) => void
  /** Entries, templates, the inbox and derived world data. */
  readonly world: WorldStore
  private readonly now: () => Date
  /** Newest snapshot per chapter (time and content hash), to decide when to take the next. */
  private readonly lastSnapshot = new Map<string, { time: number; hash: string }>()
  /** Volume word totals when first opened in this run, for session word counts. */
  private readonly sessionStart = new Map<string, number>()

  private constructor(
    root: string,
    readonly info: LibraryFile,
    options: LibraryOptions,
  ) {
    this.paths = new LibraryPaths(root)
    const notify = options.onChange ?? (() => {})
    this.onChange = (change) => {
      this.world.invalidate(change)
      notify(change)
    }
    this.now = options.now ?? (() => new Date())
    this.world = new WorldStore({
      paths: this.paths,
      lock: this.lock,
      timestamp: () => this.timestamp(),
      changed: (change) => this.onChange(change),
      getWorld: (worldId) => this.getWorld(worldId),
      writeFile: (worldId, rel, value) => this.writeWorldFile(worldId, rel, value),
      writeBytes: async (worldId, rel, bytes) => {
        const dir = this.paths.worldDir(worldId)
        await writeFileAtomic(join(dir, rel), bytes)
        await this.recordInManifest(this.worldUnit(worldId), rel, {
          hash: sha256(bytes),
          size: bytes.byteLength,
        })
      },
      removeFile: async (worldId, rel) => {
        await fs.promises.rm(join(this.paths.worldDir(worldId), rel), { force: true })
        await this.recordInManifest(this.worldUnit(worldId), rel, null)
      },
      story: (worldId) => this.worldStory(worldId),
      moveToTrash: (target) => this.moveToTrash(target),
    })
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
      series.push({
        ...file,
        cover: await coverInfo(this.paths.seriesDir(seriesId)),
        volumes: await this.readVolumes(file, problems),
      })
    }
    const worlds: WorldSummary[] = []
    for (const worldId of await listDirs(this.paths.worldsRoot)) {
      const file = await this.tryRead(this.paths.worldFile(worldId), worldFileSchema, problems)
      if (file) worlds.push({ ...file, cover: await coverInfo(this.paths.worldDir(worldId)) })
    }
    series.sort(byName)
    worlds.sort(byName)
    const trashCount = (await this.listTrash()).length
    return { root: this.root, series, worlds, problems, trashCount }
  }

  /** Volumes in the series' order, followed by any found on disk but missing from it. */
  private async readVolumes(
    series: SeriesFile,
    problems: LibraryProblem[],
  ): Promise<VolumeSummary[]> {
    const onDisk = await listDirs(this.paths.volumesDir(series.id))
    const ordered = [
      ...series.volumeOrder.filter((id) => onDisk.includes(id)),
      ...onDisk.filter((id) => !series.volumeOrder.includes(id)),
    ]
    const volumes: VolumeSummary[] = []
    for (const volumeId of ordered) {
      const dir = this.paths.volumeDir(series.id, volumeId)
      const file = await this.tryRead(join(dir, unitPaths.volume), volumeFileSchema, problems)
      if (!file) continue
      volumes.push({
        ...file,
        cover: await coverInfo(dir),
        wordCount: await this.volumeWordCount(series.id, volumeId),
      })
    }
    return volumes
  }

  /** Total words across a volume's chapters. Unreadable chapters count as zero. */
  private async volumeWordCount(seriesId: string, volumeId: string): Promise<number> {
    let total = 0
    const dir = this.paths.chaptersDir(seriesId, volumeId)
    for (const chapterId of await this.chapterIdsOnDisk(seriesId, volumeId)) {
      try {
        const chapter = await readJsonFile(join(dir, `${chapterId}.json`), chapterFileSchema)
        total += docWordCount(chapter.content)
      } catch (err) {
        if (!(err instanceof AppError)) throw err
      }
    }
    return total
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
        ? {
            id: file.id,
            title: file.title,
            type: file.type,
            pov: file.pov,
            povEntryId: file.povEntryId ?? null,
          }
        : {
            id: chapterId,
            title: '(unreadable chapter)',
            type: 'chapter',
            pov: null,
            povEntryId: null,
          }
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
    /** A single book: made with its one volume, named the same. */
    kind?: SeriesFile['kind']
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
      kind: input.kind ?? 'series',
      volumeOrder: [],
      createdAt: time,
      updatedAt: time,
    }
    await this.lock.run(`series:${series.id}`, async () => {
      await fs.promises.mkdir(this.paths.volumesDir(series.id), { recursive: true })
      await writeJsonFile(this.paths.seriesFile(series.id), series)
    })
    if (series.kind === 'book') {
      const volume = await this.createVolume({ seriesId: series.id, name: series.name })
      series.volumeOrder = [volume.id]
    }
    this.onChange({ kind: 'series', seriesId: series.id })
    return series
  }

  /**
   * Shows a story as a single book or as a series. A book has one volume, so
   * only a series with at most one volume can become one.
   */
  async setSeriesKind(seriesId: string, kind: SeriesFile['kind']): Promise<SeriesFile> {
    const volumes = await listDirs(this.paths.volumesDir(seriesId))
    if (kind === 'book' && volumes.length > 1) {
      throw new AppError('invalid-input', 'Only a series with one volume can be a single book.')
    }
    const updated = await this.lock.run(`series:${seriesId}`, async () => {
      const series = await this.getSeries(seriesId)
      const next = { ...series, kind, updatedAt: this.timestamp() }
      await writeJsonFile(this.paths.seriesFile(seriesId), next)
      return next
    })
    // A book with no volume yet gets one, so it can be opened.
    if (kind === 'book' && volumes.length === 0) {
      await this.createVolume({ seriesId, name: updated.name })
    }
    this.onChange({ kind: 'series', seriesId })
    return updated
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
      const volumeOrder = [...series.volumeOrder, volume.id]
      // A book given a second volume becomes a series.
      const kind = series.kind === 'book' && volumeOrder.length > 1 ? 'series' : series.kind
      const next = { ...series, kind, volumeOrder, updatedAt: time }
      await writeJsonFile(this.paths.seriesFile(seriesId), next)
    })
    this.onChange({ kind: 'volume', seriesId, volumeId: volume.id })
    return volume
  }

  async updateVolume(
    seriesId: string,
    volumeId: string,
    patch: {
      name?: string
      goals?: VolumeFile['goals']
      /** Merged into the volume's settings (other keys are kept). */
      settings?: Record<string, unknown>
    },
  ): Promise<VolumeFile> {
    const updated = await this.lock.run(`volume:${volumeId}`, async () => {
      const volume = await this.getVolume(seriesId, volumeId)
      const next: VolumeFile = {
        ...volume,
        ...definedOnly({ name: patch.name?.trim(), goals: patch.goals }),
        ...(patch.settings ? { settings: { ...volume.settings, ...patch.settings } } : {}),
        updatedAt: this.timestamp(),
      }
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.volume, next)
      return next
    })
    // A single book's name is its volume's name.
    if (patch.name !== undefined) {
      const series = await this.getSeries(seriesId).catch(() => null)
      if (series?.kind === 'book' && series.name !== updated.name) {
        await this.renameSeries(seriesId, updated.name)
      }
    }
    this.onChange({ kind: 'volume', seriesId, volumeId })
    return updated
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

  /**
   * Saves changes to a chapter. Only the fields in `patch` change; everything
   * else (including fields this version doesn't know) is kept from disk.
   */
  async saveChapter(
    seriesId: string,
    volumeId: string,
    chapterId: string,
    patch: ChapterPatch,
  ): Promise<ChapterFile> {
    const saved = await this.lock.run(`volume:${volumeId}`, async () => {
      const existing = await this.readChapter(seriesId, volumeId, chapterId)
      // History: keep the version being replaced, at most every few minutes.
      if (patch.content) {
        // A big deletion always keeps the version from just before it, whatever the timing.
        const removed = docToText(existing.content).length - docToText(patch.content).length
        const bigDeletion = removed >= BIG_DELETION_CHARS
        await this.snapshotChapter(
          volumeId,
          existing,
          bigDeletion ? 'before-deletion' : 'auto',
          bigDeletion,
        )
      }
      const next: ChapterFile = {
        ...existing,
        ...definedOnly(patch),
        formatVersion: FORMAT_VERSION,
        updatedAt: this.timestamp(),
      }
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.chapter(chapterId), next)
      return next
    })
    this.onChange({ kind: 'chapter', seriesId, volumeId, chapterId })
    return saved
  }

  /** Word counts for a volume. The first call per volume in this run sets the session start. */
  async volumeStats(seriesId: string, volumeId: string): Promise<VolumeStats> {
    await this.getVolume(seriesId, volumeId)
    const chapterWords: Record<string, number> = {}
    const dir = this.paths.chaptersDir(seriesId, volumeId)
    for (const chapterId of await this.chapterIdsOnDisk(seriesId, volumeId)) {
      try {
        const chapter = await readJsonFile(join(dir, `${chapterId}.json`), chapterFileSchema)
        chapterWords[chapterId] = docWordCount(chapter.content)
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        chapterWords[chapterId] = 0
      }
    }
    const total = Object.values(chapterWords).reduce((a, b) => a + b, 0)
    if (!this.sessionStart.has(volumeId)) this.sessionStart.set(volumeId, total)
    return { chapterWords, sessionStartWords: this.sessionStart.get(volumeId)! }
  }

  /* ---------- worlds ---------- */

  async createWorld(input: { name: string }): Promise<WorldFile> {
    const time = this.timestamp()
    const world: WorldFile = {
      formatVersion: FORMAT_VERSION,
      id: newId('world'),
      name: input.name.trim(),
      pinned: [],
      features: { map: true, board: true, timeline: true },
      createdAt: time,
      updatedAt: time,
    }
    await this.lock.run(`world:${world.id}`, async () => {
      await fs.promises.mkdir(join(this.paths.worldDir(world.id), 'entries'), { recursive: true })
      await this.writeWorldFile(world.id, unitPaths.world, world)
    })
    this.onChange({ kind: 'world', worldId: world.id })
    return world
  }

  /* ---------- world: the story it is used by ---------- */

  /**
   * Chapters of every series using this world, in reading order (series by
   * name, then volume and chapter order). Unreadable chapters are skipped.
   */
  async worldStory(worldId: string): Promise<StoryText[]> {
    const out: StoryText[] = []
    const series = (await this.snapshot()).series.filter((s) => s.worldId === worldId)
    for (const s of series) {
      for (const volume of s.volumes) {
        const chapters: ChapterFile[] = []
        for (const chapterId of await this.chaptersInOrder(s.id, volume.id)) {
          try {
            chapters.push(await this.readChapter(s.id, volume.id, chapterId))
          } catch (err) {
            if (!(err instanceof AppError)) throw err
          }
        }
        const labels = chapterLabels(chapters.map((c) => c.type))
        chapters.forEach((chapter, i) =>
          out.push({
            chapter: {
              id: chapter.id,
              seriesId: s.id,
              volumeId: volume.id,
              label: labels[i]!,
              title: chapter.title,
              volumeName: volume.name,
            },
            paragraphs: docParagraphs(chapter.content),
            povEntryId: chapter.povEntryId ?? null,
          }),
        )
      }
    }
    return out
  }

  /* ---------- chapter summaries (made by the AI) ---------- */

  /**
   * A story's chapters in reading order, each with its AI summary (null when
   * it has none, `current` false when the chapter changed since).
   */
  async storySummaries(seriesId: string): Promise<StorySummary[]> {
    const series = (await this.snapshot()).series.find((s) => s.id === seriesId)
    if (!series) throw new AppError('not-found', 'That story is gone.')
    const out: StorySummary[] = []
    for (const volume of series.volumes) {
      const chapters: ChapterFile[] = []
      for (const chapterId of await this.chaptersInOrder(series.id, volume.id)) {
        try {
          chapters.push(await this.readChapter(series.id, volume.id, chapterId))
        } catch (err) {
          if (!(err instanceof AppError)) throw err
        }
      }
      const labels = chapterLabels(chapters.map((c) => c.type))
      for (const [i, chapter] of chapters.entries()) {
        const paragraphs = docParagraphs(chapter.content)
        const textHash = chapterTextHash(paragraphs)
        let summary: ChapterSummaryFile | null = null
        try {
          summary = await readJsonFile(
            join(this.paths.volumeDir(series.id, volume.id), unitPaths.summary(chapter.id)),
            chapterSummaryFileSchema,
          )
        } catch (err) {
          if (!(err instanceof AppError)) throw err
        }
        out.push({
          chapter: {
            id: chapter.id,
            seriesId: series.id,
            volumeId: volume.id,
            label: labels[i]!,
            title: chapter.title,
            volumeName: volume.name,
          },
          paragraphs,
          textHash,
          summary: summary?.text ?? null,
          current: !!summary && summary.textHash === textHash,
        })
      }
    }
    return out
  }

  /** Who says what in a chapter (the AI's marking), or null when there's none yet. */
  async readSpeakers(
    seriesId: string,
    volumeId: string,
    chapterId: string,
  ): Promise<ChapterSpeakersFile | null> {
    try {
      return await readJsonFile(
        join(this.paths.volumeDir(seriesId, volumeId), unitPaths.speakers(chapterId)),
        chapterSpeakersFileSchema,
      )
    } catch (err) {
      if (err instanceof AppError) return null
      throw err
    }
  }

  async saveSpeakers(
    seriesId: string,
    volumeId: string,
    file: Pick<ChapterSpeakersFile, 'chapterId' | 'textHash' | 'narrator' | 'lines'> & {
      fixed?: ChapterSpeakersFile['fixed']
    },
  ): Promise<void> {
    await this.lock.run(`volume:${volumeId}`, async () => {
      await fs.promises.mkdir(join(this.paths.volumeDir(seriesId, volumeId), 'speakers'), {
        recursive: true,
      })
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.speakers(file.chapterId), {
        formatVersion: FORMAT_VERSION,
        ...file,
        createdAt: this.timestamp(),
      })
    })
  }

  /** The writer fixes who says a line (null: nobody known, "anyone else"). */
  async fixSpeaker(
    seriesId: string,
    volumeId: string,
    chapterId: string,
    key: string,
    speaker: Speaker,
  ): Promise<void> {
    const file = await this.readSpeakers(seriesId, volumeId, chapterId)
    if (!file)
      throw new AppError('not-found', 'Who says what hasn’t been marked for this chapter yet.')
    await this.saveSpeakers(seriesId, volumeId, {
      chapterId,
      textHash: file.textHash,
      narrator: file.narrator,
      lines: { ...file.lines, [key]: speaker },
      fixed: { ...file.fixed, [key]: speaker },
    })
  }

  /** Keeps the AI's summary of a chapter (with the text it was made from). */
  async saveSummary(
    seriesId: string,
    volumeId: string,
    chapterId: string,
    text: string,
    textHash: string,
  ): Promise<void> {
    await this.lock.run(`volume:${volumeId}`, async () => {
      await fs.promises.mkdir(join(this.paths.volumeDir(seriesId, volumeId), 'summaries'), {
        recursive: true,
      })
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.summary(chapterId), {
        formatVersion: FORMAT_VERSION,
        chapterId,
        text: text.trim().slice(0, 5000),
        textHash,
        createdAt: this.timestamp(),
      })
    })
  }

  /* ---------- renaming (display names only; ids and folders never change) ---------- */

  /** The story's description (the series page). */
  async describeSeries(seriesId: string, description: string): Promise<SeriesFile> {
    const updated = await this.lock.run(`series:${seriesId}`, async () => {
      const series = await this.getSeries(seriesId)
      const next = { ...series, description: description.trim(), updatedAt: this.timestamp() }
      await writeJsonFile(this.paths.seriesFile(seriesId), next)
      return next
    })
    this.onChange({ kind: 'series', seriesId })
    return updated
  }

  /** The voices a story is read with (VoiceStudio voice names), kept with the story. */
  async setSeriesVoices(
    seriesId: string,
    voices: NonNullable<SeriesFile['voices']>,
  ): Promise<SeriesFile> {
    const updated = await this.lock.run(`series:${seriesId}`, async () => {
      const series = await this.getSeries(seriesId)
      const next = { ...series, voices, updatedAt: this.timestamp() }
      await writeJsonFile(this.paths.seriesFile(seriesId), next)
      return next
    })
    this.onChange({ kind: 'series', seriesId })
    return updated
  }

  async renameSeries(seriesId: string, name: string): Promise<SeriesFile> {
    const updated = await this.lock.run(`series:${seriesId}`, async () => {
      const series = await this.getSeries(seriesId)
      const next = { ...series, name: name.trim(), updatedAt: this.timestamp() }
      await writeJsonFile(this.paths.seriesFile(seriesId), next)
      return next
    })
    // A single book's name is its volume's name too.
    if (updated.kind === 'book') {
      for (const volumeId of await listDirs(this.paths.volumesDir(seriesId))) {
        const volume = await this.getVolume(seriesId, volumeId).catch(() => null)
        if (volume && volume.name !== updated.name) {
          await this.updateVolume(seriesId, volumeId, { name: updated.name })
        }
      }
    }
    this.onChange({ kind: 'series', seriesId })
    return updated
  }

  /** Turns parts of World mode on or off for one world (nothing in it is deleted). */
  async setWorldFeatures(
    worldId: string,
    features: Partial<WorldFile['features']>,
  ): Promise<WorldFile> {
    const updated = await this.lock.run(`world:${worldId}`, async () => {
      const world = await this.getWorld(worldId)
      const next = {
        ...world,
        features: { ...world.features, ...features },
        updatedAt: this.timestamp(),
      }
      await this.writeWorldFile(worldId, unitPaths.world, next)
      return next
    })
    this.onChange({ kind: 'world', worldId })
    return updated
  }

  async renameWorld(worldId: string, name: string): Promise<WorldFile> {
    const updated = await this.lock.run(`world:${worldId}`, async () => {
      const world = await this.getWorld(worldId)
      const next = { ...world, name: name.trim(), updatedAt: this.timestamp() }
      await this.writeWorldFile(worldId, unitPaths.world, next)
      return next
    })
    this.onChange({ kind: 'world', worldId })
    return updated
  }

  /* ---------- trash ---------- */

  /**
   * Moves an item to this device's trash: its file or folder is moved (not
   * copied) under the local data folder, with a note of where it came from
   * so it can be put back exactly. Nothing is erased until the trash is emptied.
   */
  async moveToTrash(target: TrashTarget): Promise<TrashEntry> {
    let item: TrashItem
    switch (target.kind) {
      case 'chapter':
        item = await this.trashChapter(target.seriesId, target.volumeId, target.chapterId)
        break
      case 'volume': {
        const { seriesId, volumeId } = target
        item = await this.lock.run(`series:${seriesId}`, async () => {
          const [series, volume] = await Promise.all([
            this.getSeries(seriesId),
            this.getVolume(seriesId, volumeId),
          ])
          const entry = this.newTrashItem('volume', volume.name, series.name, {
            seriesId,
            volumeId,
            index: Math.max(0, series.volumeOrder.indexOf(volumeId)),
          })
          await this.lock.run(`volume:${volumeId}`, () =>
            this.putInTrash(entry, this.paths.volumeDir(seriesId, volumeId)),
          )
          const next = {
            ...series,
            volumeOrder: series.volumeOrder.filter((id) => id !== volumeId),
            updatedAt: this.timestamp(),
          }
          await writeJsonFile(this.paths.seriesFile(seriesId), next)
          return entry
        })
        this.onChange({ kind: 'series', seriesId })
        break
      }
      case 'series': {
        const { seriesId } = target
        item = await this.lock.run(`series:${seriesId}`, async () => {
          const series = await this.getSeries(seriesId)
          const entry = this.newTrashItem('series', series.name, null, { seriesId })
          await this.putInTrash(entry, this.paths.seriesDir(seriesId))
          return entry
        })
        this.onChange({ kind: 'library' })
        break
      }
      case 'world': {
        const { worldId } = target
        const world = await this.getWorld(worldId)
        // Unlink series that use this world; restoring the world links them again.
        const linked: string[] = []
        for (const series of (await this.snapshot()).series) {
          if (series.worldId === worldId) {
            await this.setSeriesWorld(series.id, null)
            linked.push(series.id)
          }
        }
        item = this.newTrashItem('world', world.name, null, { worldId, linkedSeries: linked })
        await this.lock.run(`world:${worldId}`, () =>
          this.putInTrash(item, this.paths.worldDir(worldId)),
        )
        this.onChange({ kind: 'world', worldId })
        break
      }
      case 'entry': {
        const { worldId, entryId } = target
        const world = await this.getWorld(worldId)
        item = await this.lock.run(`world:${worldId}`, async () => {
          const rel = unitPaths.entry(entryId)
          const path = join(this.paths.worldDir(worldId), rel)
          if (!(await pathExists(path)))
            throw new AppError('not-found', 'That entry no longer exists.')
          let name = '(unreadable entry)'
          try {
            name = (await this.world.readEntry(worldId, entryId)).name
          } catch (err) {
            if (!(err instanceof AppError)) throw err
          }
          const trashed = this.newTrashItem('entry', name, world.name, { worldId, entryId })
          await this.putInTrash(trashed, path)
          await this.recordInManifest(this.worldUnit(worldId), rel, null)
          return trashed
        })
        this.onChange({ kind: 'entry', worldId, entryId })
        break
      }
      case 'map': {
        const { worldId, mapId } = target
        const world = await this.getWorld(worldId)
        item = await this.lock.run(`world:${worldId}`, async () => {
          const rel = unitPaths.map(mapId)
          const path = join(this.paths.worldDir(worldId), rel)
          if (!(await pathExists(path)))
            throw new AppError('not-found', 'That map no longer exists.')
          let name = '(unreadable map)'
          try {
            name = (await this.world.readMap(worldId, mapId)).name
          } catch (err) {
            if (!(err instanceof AppError)) throw err
          }
          // The map's image stays in the world's images (others may use it).
          const trashed = this.newTrashItem('map', name, world.name, { worldId, mapId })
          await this.putInTrash(trashed, path)
          await this.recordInManifest(this.worldUnit(worldId), rel, null)
          return trashed
        })
        this.onChange({ kind: 'world', worldId })
        break
      }
    }
    this.onChange({ kind: 'trash' })
    return toTrashEntry(item)
  }

  private async trashChapter(
    seriesId: string,
    volumeId: string,
    chapterId: string,
  ): Promise<TrashItem> {
    const [series, volume] = await Promise.all([
      this.getSeries(seriesId),
      this.getVolume(seriesId, volumeId),
    ])
    const item = await this.lock.run(`volume:${volumeId}`, async () => {
      const rel = unitPaths.chapter(chapterId)
      const path = join(this.paths.volumeDir(seriesId, volumeId), rel)
      if (!(await pathExists(path)))
        throw new AppError('not-found', 'That chapter no longer exists.')
      let title = '(unreadable chapter)'
      try {
        title = (await this.readChapter(seriesId, volumeId, chapterId)).title || 'Untitled chapter'
      } catch (err) {
        // A damaged chapter can still be trashed; it is moved, not read.
        if (!(err instanceof AppError)) throw err
      }

      const outline = await this.readStoredOutline(seriesId, volumeId)
      let arc: TrashItem['origin']['arc'] = null
      let index = outline.items.findIndex((i) => i.type === 'chapter' && i.id === chapterId)
      outline.items.forEach((i, rootIndex) => {
        if (i.type === 'arc' && i.chapterIds.includes(chapterId)) {
          arc = { id: i.id, name: i.name, index: rootIndex }
          index = i.chapterIds.indexOf(chapterId)
        }
      })
      const entry = this.newTrashItem('chapter', title, `${series.name} › ${volume.name}`, {
        seriesId,
        volumeId,
        chapterId,
        arc,
        index: Math.max(0, index),
      })
      await this.putInTrash(entry, path)

      outline.items = outline.items
        .filter((i) => !(i.type === 'chapter' && i.id === chapterId))
        .map((i) =>
          i.type === 'arc' ? { ...i, chapterIds: i.chapterIds.filter((c) => c !== chapterId) } : i,
        )
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.outline, outline)
      await this.recordInManifest(this.volumeUnit(seriesId, volumeId), rel, null)
      return entry
    })
    this.onChange({ kind: 'outline', seriesId, volumeId })
    return item
  }

  /**
   * Deletes an arc. Its chapters either move out to the top level (where the
   * arc was) or go to the trash, remembering the arc so a restore can bring
   * it back.
   */
  async deleteArc(
    seriesId: string,
    volumeId: string,
    arcId: string,
    chapters: 'keep' | 'trash',
  ): Promise<OutlineView> {
    const stored = await this.readStoredOutline(seriesId, volumeId)
    const arc = stored.items.find((i) => i.type === 'arc' && i.id === arcId)
    if (arc?.type !== 'arc') throw new AppError('not-found', 'That arc no longer exists.')
    if (chapters === 'trash') {
      for (const chapterId of arc.chapterIds) {
        await this.trashChapter(seriesId, volumeId, chapterId)
      }
      this.onChange({ kind: 'trash' })
    }
    await this.lock.run(`volume:${volumeId}`, async () => {
      const outline = await this.readStoredOutline(seriesId, volumeId)
      outline.items = outline.items.flatMap((i) =>
        i.type === 'arc' && i.id === arcId
          ? i.chapterIds.map((id) => ({ type: 'chapter' as const, id }))
          : [i],
      )
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.outline, outline)
    })
    this.onChange({ kind: 'outline', seriesId, volumeId })
    return this.getOutline(seriesId, volumeId)
  }

  async listTrash(): Promise<TrashEntry[]> {
    const entries: TrashEntry[] = []
    for (const trashId of await listDirs(this.trashItemsDir)) {
      const item = await this.readTrashItem(trashId).catch(() => null)
      if (item && (await pathExists(join(this.trashItemsDir, trashId, TRASH_CONTENT)))) {
        entries.push(toTrashEntry(item))
      }
    }
    return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
  }

  /** Puts an item back where it was. Its parent (series or volume) must still exist. */
  async restoreFromTrash(trashId: string): Promise<TrashEntry> {
    const item = await this.readTrashItem(trashId)
    const content = join(this.trashItemsDir, trashId, TRASH_CONTENT)
    const { origin } = item
    const putBack = async (dest: string) => {
      if (await pathExists(dest)) {
        throw new AppError('conflict', `Something already exists where “${item.name}” was.`)
      }
      await fs.promises.rename(content, dest)
    }
    const needParent = async (check: () => Promise<unknown>, what: string) => {
      try {
        await check()
      } catch (err) {
        if (err instanceof AppError && err.code === 'not-found') {
          throw new AppError('not-found', `Restore the ${what} “${item.name}” was in first.`)
        }
        throw err
      }
    }

    switch (item.kind) {
      case 'chapter': {
        const { seriesId, volumeId, chapterId } = origin as Required<TrashItem['origin']>
        await needParent(() => this.getVolume(seriesId, volumeId), 'volume')
        await this.lock.run(`volume:${volumeId}`, async () => {
          const rel = unitPaths.chapter(chapterId)
          const dest = join(this.paths.volumeDir(seriesId, volumeId), rel)
          await putBack(dest)
          const outline = await this.readStoredOutline(seriesId, volumeId)
          const index = origin.index ?? Number.MAX_SAFE_INTEGER
          if (origin.arc) {
            const { id: arcId, name, index: arcIndex } = origin.arc
            let arc = outline.items.find((i) => i.type === 'arc' && i.id === arcId)
            if (arc?.type !== 'arc') {
              arc = { type: 'arc', id: arcId, name, finished: false, chapterIds: [] }
              outline.items.splice(Math.min(arcIndex, outline.items.length), 0, arc)
            }
            arc.chapterIds.splice(Math.min(index, arc.chapterIds.length), 0, chapterId)
          } else {
            outline.items.splice(Math.min(index, outline.items.length), 0, {
              type: 'chapter',
              id: chapterId,
            })
          }
          await this.writeVolumeFile(seriesId, volumeId, unitPaths.outline, outline)
          const bytes = await fs.promises.readFile(dest)
          await this.recordInManifest(this.volumeUnit(seriesId, volumeId), rel, {
            hash: sha256(bytes),
            size: bytes.byteLength,
          })
        })
        this.onChange({ kind: 'outline', seriesId, volumeId })
        break
      }
      case 'volume': {
        const { seriesId, volumeId } = origin as Required<TrashItem['origin']>
        await needParent(() => this.getSeries(seriesId), 'series')
        await this.lock.run(`series:${seriesId}`, async () => {
          await putBack(this.paths.volumeDir(seriesId, volumeId))
          const series = await this.getSeries(seriesId)
          const order = series.volumeOrder.filter((id) => id !== volumeId)
          order.splice(Math.min(origin.index ?? order.length, order.length), 0, volumeId)
          await writeJsonFile(this.paths.seriesFile(seriesId), { ...series, volumeOrder: order })
        })
        this.onChange({ kind: 'volume', seriesId, volumeId })
        break
      }
      case 'series': {
        const seriesId = origin.seriesId!
        await this.lock.run(`series:${seriesId}`, () => putBack(this.paths.seriesDir(seriesId)))
        this.onChange({ kind: 'series', seriesId })
        break
      }
      case 'world': {
        const worldId = origin.worldId!
        await this.lock.run(`world:${worldId}`, () => putBack(this.paths.worldDir(worldId)))
        for (const seriesId of origin.linkedSeries ?? []) {
          const series = await this.getSeries(seriesId).catch(() => null)
          if (series && series.worldId === null) await this.setSeriesWorld(seriesId, worldId)
        }
        this.onChange({ kind: 'world', worldId })
        break
      }
      case 'entry': {
        const worldId = origin.worldId!
        const entryId = origin.entryId!
        await needParent(() => this.getWorld(worldId), 'world')
        await this.lock.run(`world:${worldId}`, async () => {
          const rel = unitPaths.entry(entryId)
          const dest = join(this.paths.worldDir(worldId), rel)
          await fs.promises.mkdir(join(this.paths.worldDir(worldId), 'entries'), {
            recursive: true,
          })
          await putBack(dest)
          const bytes = await fs.promises.readFile(dest)
          await this.recordInManifest(this.worldUnit(worldId), rel, {
            hash: sha256(bytes),
            size: bytes.byteLength,
          })
        })
        this.onChange({ kind: 'entry', worldId, entryId })
        break
      }
      case 'map': {
        const worldId = origin.worldId!
        const mapId = origin.mapId!
        await needParent(() => this.getWorld(worldId), 'world')
        await this.lock.run(`world:${worldId}`, async () => {
          const rel = unitPaths.map(mapId)
          const dest = join(this.paths.worldDir(worldId), rel)
          await fs.promises.mkdir(join(this.paths.worldDir(worldId), 'maps'), { recursive: true })
          await putBack(dest)
          const bytes = await fs.promises.readFile(dest)
          await this.recordInManifest(this.worldUnit(worldId), rel, {
            hash: sha256(bytes),
            size: bytes.byteLength,
          })
        })
        this.onChange({ kind: 'world', worldId })
        break
      }
    }
    await fs.promises.rm(join(this.trashItemsDir, trashId), { recursive: true, force: true })
    this.onChange({ kind: 'trash' })
    return toTrashEntry(item)
  }

  /** Permanently erases one trashed item. */
  async purgeTrash(trashId: string): Promise<void> {
    await this.readTrashItem(trashId)
    await fs.promises.rm(join(this.trashItemsDir, trashId), { recursive: true, force: true })
    this.onChange({ kind: 'trash' })
  }

  /** Permanently erases everything in the trash, including replaced covers. */
  async emptyTrash(): Promise<void> {
    await fs.promises.rm(join(this.paths.localDir, 'trash'), { recursive: true, force: true })
    this.onChange({ kind: 'trash' })
  }

  private get trashItemsDir(): string {
    return join(this.paths.localDir, 'trash', 'items')
  }

  private newTrashItem(
    kind: TrashItem['kind'],
    name: string,
    from: string | null,
    origin: TrashItem['origin'],
  ): TrashItem {
    return {
      formatVersion: FORMAT_VERSION,
      id: newId('trash'),
      kind,
      name,
      from,
      deletedAt: this.timestamp(),
      origin,
    }
  }

  /** Writes the note first, then moves the content: a crash leaves an empty note, never a lost item. */
  private async putInTrash(item: TrashItem, source: string): Promise<void> {
    const dir = join(this.trashItemsDir, item.id)
    await fs.promises.mkdir(dir, { recursive: true })
    await writeJsonFile(join(dir, TRASH_NOTE), item)
    try {
      await fs.promises.rename(source, join(dir, TRASH_CONTENT))
    } catch (err) {
      await fs.promises.rm(dir, { recursive: true, force: true })
      throw err
    }
  }

  private async readTrashItem(trashId: string): Promise<TrashItem> {
    return readJsonFile(join(this.trashItemsDir, trashId, TRASH_NOTE), trashItemSchema)
  }

  private worldUnit(worldId: string): SyncUnit {
    return { type: 'world', dir: this.paths.worldDir(worldId), id: worldId }
  }

  private volumeUnit(seriesId: string, volumeId: string): SyncUnit {
    return { type: 'volume', dir: this.paths.volumeDir(seriesId, volumeId), id: volumeId }
  }

  /* ---------- version history ---------- */

  /**
   * Snapshots a chapter's current version (call while holding the volume
   * lock, before overwriting it). Skipped if nothing changed since the last
   * snapshot, or if the last one is recent, unless `force` is set.
   */
  private async snapshotChapter(
    volumeId: string,
    chapter: ChapterFile,
    reason: SnapshotInfo['reason'],
    force = false,
  ): Promise<void> {
    const hash = sha256(JSON.stringify(chapter.content))
    const last = await this.latestSnapshot(volumeId, chapter.id)
    const now = this.now()
    if (last && last.hash === hash) return
    if (!force && last && now.getTime() - last.time < SNAPSHOT_INTERVAL_MS) return

    const dir = this.historyDir(volumeId, chapter.id)
    const id = `${now.toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`
    const snapshot: SnapshotFile = {
      formatVersion: FORMAT_VERSION,
      id,
      chapterId: chapter.id,
      volumeId,
      savedAt: now.toISOString(),
      reason,
      title: chapter.title,
      wordCount: docWordCount(chapter.content),
      contentHash: hash,
      content: chapter.content,
    }
    await fs.promises.mkdir(dir, { recursive: true })
    await writeJsonFile(join(dir, `${id}.json`), snapshot)
    this.lastSnapshot.set(chapter.id, { time: now.getTime(), hash })
    await this.pruneSnapshots(volumeId, chapter.id)
  }

  private async latestSnapshot(
    volumeId: string,
    chapterId: string,
  ): Promise<{ time: number; hash: string } | null> {
    const cached = this.lastSnapshot.get(chapterId)
    if (cached) return cached
    const [newest] = await this.snapshotIds(volumeId, chapterId)
    if (!newest) return null
    try {
      const file = await this.readSnapshotFile(volumeId, chapterId, newest)
      const latest = { time: Date.parse(file.savedAt), hash: file.contentHash }
      this.lastSnapshot.set(chapterId, latest)
      return latest
    } catch {
      return null
    }
  }

  /** Snapshot ids, newest first. */
  private async snapshotIds(volumeId: string, chapterId: string): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.promises.readdir(this.historyDir(volumeId, chapterId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return names
      .filter((n) => n.endsWith('.json') && SNAPSHOT_ID.test(n.slice(0, -5)))
      .map((n) => n.slice(0, -5))
      .sort()
      .reverse()
  }

  private async pruneSnapshots(
    volumeId: string,
    chapterId: string,
    light?: boolean,
  ): Promise<void> {
    const ids = await this.snapshotIds(volumeId, chapterId)
    const times = ids.map(snapshotTime)
    const keep = snapshotsToKeep(times, this.now(), light ?? (await this.isFinished(volumeId)))
    const dir = this.historyDir(volumeId, chapterId)
    for (const [i, snapshotId] of ids.entries()) {
      if (!keep.has(i)) await fs.promises.rm(join(dir, `${snapshotId}.json`), { force: true })
    }
  }

  /** A finished book keeps less history (its volume's `finished` setting). */
  private async isFinished(volumeId: string): Promise<boolean> {
    for (const seriesId of await listDirs(this.paths.seriesRoot)) {
      const dir = this.paths.volumeDir(seriesId, volumeId)
      if (!(await pathExists(dir))) continue
      const volume = await this.getVolume(seriesId, volumeId).catch(() => null)
      return volume?.settings['finished'] === true
    }
    return false
  }

  /**
   * Marks a volume finished (or not). Finished, its chapters keep fewer old
   * versions: one a week back to 3 months, then one a month. Applied at once.
   */
  async setVolumeFinished(
    seriesId: string,
    volumeId: string,
    finished: boolean,
  ): Promise<VolumeFile> {
    const volume = await this.updateVolume(seriesId, volumeId, { settings: { finished } })
    if (finished) {
      for (const chapterId of await listDirs(join(this.paths.localDir, 'history', volumeId))) {
        await this.pruneSnapshots(volumeId, chapterId, true)
      }
    }
    return volume
  }

  /** How much space the library takes on this computer, by kind (bytes). */
  async diskUsage(): Promise<{
    total: number
    writing: number
    images: number
    history: number
    trash: number
    other: number
  }> {
    const sizes = { total: 0, writing: 0, images: 0, history: 0, trash: 0, other: 0 }
    const local = relative(this.root, this.paths.localDir).split(sep).join('/')
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          await walk(full)
          continue
        }
        if (!e.isFile()) continue
        const size = (await fs.promises.stat(full).catch(() => null))?.size ?? 0
        const rel = relative(this.root, full).split(sep).join('/')
        const kind = rel.startsWith(`${local}/history/`)
          ? 'history'
          : rel.startsWith(`${local}/trash/`)
            ? 'trash'
            : rel.startsWith(`${local}/`)
              ? 'other'
              : /\/images\//.test(rel) || /(^|\/)cover\.[a-z]+$/.test(rel)
                ? 'images'
                : 'writing'
        sizes[kind] += size
        sizes.total += size
      }
    }
    await walk(this.root)
    return sizes
  }

  private readSnapshotFile(volumeId: string, chapterId: string, snapshotId: string) {
    return readJsonFile(
      join(this.historyDir(volumeId, chapterId), `${snapshotId}.json`),
      snapshotFileSchema,
    )
  }

  private historyDir(volumeId: string, chapterId: string): string {
    return join(this.paths.localDir, 'history', volumeId, chapterId)
  }

  /**
   * A volume's chapters in reading order, for export (all of them, or the
   * ones asked for). Unreadable chapters are left out and named in `skipped`.
   */
  async chaptersForExport(
    seriesId: string,
    volumeId: string,
    only?: string[],
  ): Promise<{
    series: string
    volume: string
    /** The book's own choice of chapter headings, if it made one. */
    headings: string | null
    chapters: ChapterFile[]
    skipped: string[]
  }> {
    const series = await this.getSeries(seriesId)
    const volume = await this.getVolume(seriesId, volumeId)
    const chapters: ChapterFile[] = []
    const skipped: string[] = []
    for (const chapterId of await this.chaptersInOrder(seriesId, volumeId)) {
      if (only && !only.includes(chapterId)) continue
      try {
        chapters.push(await this.readChapter(seriesId, volumeId, chapterId))
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        skipped.push(chapterId)
      }
    }
    const headings =
      typeof volume.settings['headings'] === 'string' ? volume.settings['headings'] : null
    return { series: series.name, volume: volume.name, headings, chapters, skipped }
  }

  /** Every chapter's paragraphs in reading order. Unreadable chapters are skipped. */
  async volumeTexts(
    seriesId: string,
    volumeId: string,
  ): Promise<{ id: string; title: string; paragraphs: string[] }[]> {
    const out: { id: string; title: string; paragraphs: string[] }[] = []
    for (const chapterId of await this.chaptersInOrder(seriesId, volumeId)) {
      try {
        const chapter = await this.readChapter(seriesId, volumeId, chapterId)
        out.push({
          id: chapterId,
          title: chapter.title,
          paragraphs: docParagraphs(chapter.content),
        })
      } catch (err) {
        if (!(err instanceof AppError)) throw err
      }
    }
    return out
  }

  /**
   * Lowercase words from the names and aliases of the world entries linked
   * to a volume's series (so analysis can leave names out).
   */
  async volumeNames(seriesId: string): Promise<string[]> {
    const { worldId } = await this.getSeries(seriesId)
    if (!worldId) return []
    const dir = join(this.paths.worldDir(worldId), 'entries')
    const words = new Set<string>()
    let names: string[]
    try {
      names = await fs.promises.readdir(dir)
    } catch {
      return []
    }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const entry = await readJsonFile(join(dir, name), worldEntryFileSchema)
        for (const label of [entry.name, ...entry.aliases]) {
          for (const word of label.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []) words.add(word)
        }
      } catch (err) {
        if (!(err instanceof AppError)) throw err
      }
    }
    return [...words]
  }

  /** Keeps the chapter's current version now (the "Keep this version" button). */
  async keepSnapshot(
    seriesId: string,
    volumeId: string,
    chapterId: string,
    reason: 'manual' | 'before-ai' | 'after-ai' = 'manual',
  ): Promise<void> {
    await this.lock.run(`volume:${volumeId}`, async () => {
      const chapter = await this.readChapter(seriesId, volumeId, chapterId)
      await this.snapshotChapter(volumeId, chapter, reason, true)
    })
    this.onChange({ kind: 'chapter', seriesId, volumeId, chapterId })
  }

  /** Earlier versions of a chapter, newest first. Unreadable snapshots are skipped. */
  async listSnapshots(
    seriesId: string,
    volumeId: string,
    chapterId: string,
  ): Promise<SnapshotInfo[]> {
    await this.getVolume(seriesId, volumeId)
    const list: SnapshotInfo[] = []
    for (const snapshotId of await this.snapshotIds(volumeId, chapterId)) {
      try {
        list.push(toSnapshotInfo(await this.readSnapshotFile(volumeId, chapterId, snapshotId)))
      } catch (err) {
        if (!(err instanceof AppError)) throw err
      }
    }
    return list
  }

  async readSnapshot(
    seriesId: string,
    volumeId: string,
    chapterId: string,
    snapshotId: string,
  ): Promise<{ info: SnapshotInfo; content: ChapterFile['content'] }> {
    await this.getVolume(seriesId, volumeId)
    const file = await this.readSnapshotFile(volumeId, chapterId, snapshotId)
    return { info: toSnapshotInfo(file), content: file.content }
  }

  /**
   * Puts an earlier version's text back. The current text is snapshotted
   * first, so a restore can itself be undone from the history.
   */
  async restoreSnapshot(
    seriesId: string,
    volumeId: string,
    chapterId: string,
    snapshotId: string,
  ): Promise<ChapterFile> {
    const restored = await this.lock.run(`volume:${volumeId}`, async () => {
      const snapshot = await this.readSnapshotFile(volumeId, chapterId, snapshotId)
      const existing = await this.readChapter(seriesId, volumeId, chapterId)
      await this.snapshotChapter(volumeId, existing, 'before-restore', true)
      const next: ChapterFile = {
        ...existing,
        content: snapshot.content,
        updatedAt: this.timestamp(),
      }
      await this.writeVolumeFile(seriesId, volumeId, unitPaths.chapter(chapterId), next)
      return next
    })
    this.onChange({ kind: 'chapter', seriesId, volumeId, chapterId })
    return restored
  }

  /* ---------- find and replace ---------- */

  /** Chapter ids in reading order (outline order, then any missing from it). */
  private async chaptersInOrder(seriesId: string, volumeId: string): Promise<string[]> {
    const { outline } = await this.getOutline(seriesId, volumeId)
    return outline.items.flatMap((i) => (i.type === 'arc' ? i.chapterIds : [i.id]))
  }

  async searchVolume(
    seriesId: string,
    volumeId: string,
    query: string,
    options: SearchOptions,
  ): Promise<SearchResult> {
    const pattern = searchPattern(query, options)
    const result: SearchResult = { hits: [], chapters: [], total: 0, truncated: false }
    if (!pattern) return result
    for (const chapterId of await this.chaptersInOrder(seriesId, volumeId)) {
      let chapter: ChapterFile
      try {
        chapter = await this.readChapter(seriesId, volumeId, chapterId)
      } catch (err) {
        if (err instanceof AppError) continue
        throw err
      }
      let found = false
      textNodes(chapter.content).forEach((node, index) => {
        const text = node.text ?? ''
        for (const range of findInText(text, pattern)) {
          found = true
          result.total++
          if (result.hits.length >= MAX_SEARCH_HITS) {
            result.truncated = true
            continue
          }
          result.hits.push({
            chapterId,
            node: index,
            ...range,
            before: text.slice(Math.max(0, range.start - SNIPPET), range.start),
            match: text.slice(range.start, range.end),
            after: text.slice(range.end, range.end + SNIPPET),
          })
        }
      })
      if (found) result.chapters.push({ id: chapterId, title: chapter.title })
    }
    return result
  }

  /**
   * Replaces every match in a volume. Each chapter that changes is
   * snapshotted first, so the replacement can be undone from its history.
   */
  async replaceAllInVolume(
    seriesId: string,
    volumeId: string,
    query: string,
    replacement: string,
    options: SearchOptions,
  ): Promise<{ chapters: number; replacements: number }> {
    const pattern = searchPattern(query, options)
    let chapters = 0
    let replacements = 0
    if (!pattern) return { chapters, replacements }
    for (const chapterId of await this.chaptersInOrder(seriesId, volumeId)) {
      const changed = await this.lock.run(`volume:${volumeId}`, async () => {
        let existing: ChapterFile
        try {
          existing = await this.readChapter(seriesId, volumeId, chapterId)
        } catch (err) {
          if (err instanceof AppError) return 0
          throw err
        }
        const { doc, count } = replaceInDoc(existing.content, pattern, replacement)
        if (!count) return 0
        await this.snapshotChapter(volumeId, existing, 'before-replace', true)
        const next = { ...existing, content: doc, updatedAt: this.timestamp() }
        await this.writeVolumeFile(seriesId, volumeId, unitPaths.chapter(chapterId), next)
        return count
      })
      if (changed) {
        chapters++
        replacements += changed
        this.onChange({ kind: 'chapter', seriesId, volumeId, chapterId })
      }
    }
    return { chapters, replacements }
  }

  /* ---------- covers ---------- */

  /** The cover image file for an item, if it has one. Used to serve images to windows. */
  async getCoverFile(target: CoverTarget): Promise<string | null> {
    const { dir } = await this.resolveCoverTarget(target)
    const [name] = await findCoverFiles(dir)
    return name ? join(dir, name) : null
  }

  /**
   * Sets an item's cover. The image is stored inside the item's folder as
   * `cover.<ext>` so it travels with it. A previous cover is moved to the
   * device's trash, not deleted.
   */
  async setCover(target: CoverTarget, data: Uint8Array): Promise<CoverInfo> {
    const type = detectImageType(data)
    if (!type) throw new AppError('invalid-input', 'Covers must be PNG, JPEG, WebP or GIF images.')
    const resolved = await this.resolveCoverTarget(target)
    const info = await this.lock.run(resolved.lockKey, async () => {
      await this.trashCovers(resolved)
      const name = `cover.${type.ext}`
      await writeFileAtomic(join(resolved.dir, name), data)
      if (resolved.unit) {
        await this.recordInManifest(resolved.unit, name, {
          hash: sha256(data),
          size: data.byteLength,
        })
      }
      return (await coverInfo(resolved.dir))!
    })
    this.onChange(resolved.change)
    return info
  }

  /** Removes an item's cover (moved to the device's trash). */
  async removeCover(target: CoverTarget): Promise<void> {
    const resolved = await this.resolveCoverTarget(target)
    await this.lock.run(resolved.lockKey, () => this.trashCovers(resolved))
    this.onChange(resolved.change)
  }

  private async resolveCoverTarget(target: CoverTarget): Promise<ResolvedCoverTarget> {
    switch (target.kind) {
      case 'series':
        await this.getSeries(target.seriesId)
        return {
          dir: this.paths.seriesDir(target.seriesId),
          lockKey: `series:${target.seriesId}`,
          label: target.seriesId,
          unit: null,
          change: { kind: 'series', seriesId: target.seriesId },
        }
      case 'volume': {
        const { seriesId, volumeId } = target
        await this.getVolume(seriesId, volumeId)
        const dir = this.paths.volumeDir(seriesId, volumeId)
        return {
          dir,
          lockKey: `volume:${volumeId}`,
          label: volumeId,
          unit: { type: 'volume', dir, id: volumeId },
          change: { kind: 'volume', seriesId, volumeId },
        }
      }
      case 'world': {
        await this.getWorld(target.worldId)
        const dir = this.paths.worldDir(target.worldId)
        return {
          dir,
          lockKey: `world:${target.worldId}`,
          label: target.worldId,
          unit: { type: 'world', dir, id: target.worldId },
          change: { kind: 'world', worldId: target.worldId },
        }
      }
    }
  }

  /** Call only while holding the target's lock. */
  private async trashCovers(target: ResolvedCoverTarget): Promise<void> {
    const trashDir = join(this.paths.localDir, 'trash', 'covers')
    for (const name of await findCoverFiles(target.dir)) {
      await fs.promises.mkdir(trashDir, { recursive: true })
      const stamp = this.timestamp().replace(/[:.]/g, '-')
      await fs.promises.rename(
        join(target.dir, name),
        join(trashDir, `${stamp}-${target.label}-${name}`),
      )
      if (target.unit) await this.recordInManifest(target.unit, name, null)
    }
  }

  /* ---------- AI conversations ---------- */

  private conversationsDir(seriesId: string): string {
    return join(this.paths.seriesDir(seriesId), 'ai')
  }

  /** A story's saved AI conversations, newest first (without their messages). */
  async listConversations(seriesId: string): Promise<ConversationSummary[]> {
    let names: string[]
    try {
      names = await fs.promises.readdir(this.conversationsDir(seriesId))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: ConversationSummary[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || isTempFileName(name)) continue
      try {
        const c = await readJsonFile(
          join(this.conversationsDir(seriesId), name),
          conversationFileSchema,
        )
        out.push({
          id: c.id,
          mode: c.mode,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          count: c.messages.length,
        })
      } catch (err) {
        if (!(err instanceof AppError)) throw err
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async readConversation(seriesId: string, conversationId: string): Promise<ConversationFile> {
    return readJsonFile(
      join(this.conversationsDir(seriesId), `${conversationId}.json`),
      conversationFileSchema,
    )
  }

  /** Saves a whole conversation (it's small; written after each answer). */
  async saveConversation(seriesId: string, conversation: ConversationFile): Promise<void> {
    await this.getSeries(seriesId)
    await this.lock.run(`series:${seriesId}`, async () => {
      await fs.promises.mkdir(this.conversationsDir(seriesId), { recursive: true })
      await writeJsonFile(join(this.conversationsDir(seriesId), `${conversation.id}.json`), {
        ...conversation,
        formatVersion: FORMAT_VERSION,
      })
    })
    this.onChange({ kind: 'series', seriesId })
  }

  /** Deleting a conversation moves it to this computer's trash folder (not shown in Trash). */
  async deleteConversation(seriesId: string, conversationId: string): Promise<void> {
    await this.lock.run(`series:${seriesId}`, async () => {
      const from = join(this.conversationsDir(seriesId), `${conversationId}.json`)
      const dest = join(this.paths.localDir, 'trash', 'ai', `${seriesId}-${conversationId}.json`)
      await fs.promises.mkdir(join(dest, '..'), { recursive: true })
      await fs.promises.rename(from, dest).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
      })
    })
    this.onChange({ kind: 'series', seriesId })
  }

  /* ---------- sync ---------- */

  /** The write lock of a sync unit (`series/<id>`, `series/<id>/volumes/<id>`, `worlds/<id>`). */
  lockUnit<T>(unit: string, task: () => Promise<T>): Promise<T> {
    const id = unit.slice(unit.lastIndexOf('/') + 1)
    const kind = unit.startsWith('worlds/')
      ? 'world'
      : unit.includes('/volumes/')
        ? 'volume'
        : 'series'
    return this.lock.run(`${kind}:${id}`, task)
  }

  /** Before sync replaces a chapter with the other computer's version: keep this one in history. */
  async keepBeforeSync(unit: string, rel: string): Promise<void> {
    const m = /^series\/([^/]+)\/volumes\/([^/]+)$/.exec(unit)
    const chapterId = /^chapters\/([^/]+)\.json$/.exec(rel)?.[1]
    if (!m || !chapterId) return
    try {
      const chapter = await this.readChapter(m[1]!, m[2]!, chapterId)
      await this.snapshotChapter(m[2]!, chapter, 'before-sync', true)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
    }
  }

  /**
   * A file deleted on another computer goes to this one's trash (call while
   * holding the unit's lock). Chapters, entries and maps can be restored from
   * the Trash page; other files are kept in the device folder.
   */
  async trashSyncedFile(unit: string, rel: string): Promise<void> {
    const path = join(this.root, unit, rel)
    const volume = /^series\/([^/]+)\/volumes\/([^/]+)$/.exec(unit)
    const world = /^worlds\/([^/]+)$/.exec(unit)?.[1]
    const chapterId = /^chapters\/([^/]+)\.json$/.exec(rel)?.[1]
    const entryId = /^entries\/([^/]+)\.json$/.exec(rel)?.[1]
    const mapId = /^maps\/([^/]+)\.json$/.exec(rel)?.[1]
    let item: TrashItem | null = null
    try {
      if (volume && chapterId) {
        const [seriesId, volumeId] = [volume[1]!, volume[2]!]
        const chapter = await this.readChapter(seriesId, volumeId, chapterId)
        const [series, vol] = await Promise.all([
          this.getSeries(seriesId).catch(() => null),
          this.getVolume(seriesId, volumeId).catch(() => null),
        ])
        item = this.newTrashItem(
          'chapter',
          chapter.title || 'Untitled chapter',
          series && vol ? `${series.name} › ${vol.name}` : null,
          { seriesId, volumeId, chapterId, arc: null },
        )
      } else if (world && entryId) {
        const entry = await this.world.readEntry(world, entryId)
        item = this.newTrashItem('entry', entry.name, null, { worldId: world, entryId })
      } else if (world && mapId) {
        const map = await this.world.readMap(world, mapId)
        item = this.newTrashItem('map', map.name, null, { worldId: world, mapId })
      }
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      item = null
    }
    if (item) {
      await this.putInTrash(item, path)
      this.onChange({ kind: 'trash' })
    } else {
      const stamp = this.timestamp().replace(/[:.]/g, '-')
      const dest = join(
        this.paths.localDir,
        'trash',
        'sync',
        `${stamp}-${unit}/${rel}`.replaceAll('/', '~'),
      )
      await fs.promises.mkdir(join(dest, '..'), { recursive: true })
      await fs.promises.rename(path, dest).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err
      })
    }
  }

  /** A volume, world or series deleted on another computer goes to this one's trash. */
  async trashSyncedUnit(unit: string): Promise<void> {
    const volume = /^series\/([^/]+)\/volumes\/([^/]+)$/.exec(unit)
    const series = /^series\/([^/]+)$/.exec(unit)?.[1]
    const world = /^worlds\/([^/]+)$/.exec(unit)?.[1]
    const nameOf = async (read: () => Promise<{ name: string }>, fallback: string) =>
      read().then(
        (x) => x.name,
        () => fallback,
      )
    let item: TrashItem
    if (volume) {
      const [seriesId, volumeId] = [volume[1]!, volume[2]!]
      const s = await this.getSeries(seriesId).catch(() => null)
      item = this.newTrashItem(
        'volume',
        await nameOf(() => this.getVolume(seriesId, volumeId), 'Volume'),
        s?.name ?? null,
        { seriesId, volumeId, index: Math.max(0, s?.volumeOrder.indexOf(volumeId) ?? 0) },
      )
    } else if (series) {
      item = this.newTrashItem(
        'series',
        await nameOf(() => this.getSeries(series), 'Series'),
        null,
        {
          seriesId: series,
        },
      )
    } else if (world) {
      item = this.newTrashItem('world', await nameOf(() => this.getWorld(world), 'World'), null, {
        worldId: world,
        linkedSeries: [],
      })
    } else {
      return
    }
    await this.putInTrash(item, join(this.root, unit))
    this.onChange({ kind: 'trash' })
  }

  /** Sync changed files in a unit: refresh the local manifest and tell the windows. */
  async syncedChanges(unit: string, rels: string[], unitChanged: boolean): Promise<void> {
    const volume = /^series\/([^/]+)\/volumes\/([^/]+)$/.exec(unit)
    const series = /^series\/([^/]+)$/.exec(unit)?.[1]
    const world = /^worlds\/([^/]+)$/.exec(unit)?.[1]
    const dir = join(this.root, unit)
    if ((volume || world) && (await pathExists(dir))) {
      await this.lockUnit(unit, () =>
        this.rebuildManifest(volume ? 'volume' : 'world', dir, volume ? volume[2]! : world!),
      ).catch(() => {})
    }
    if (unitChanged || series) this.onChange({ kind: 'library' })
    if (volume) {
      const [seriesId, volumeId] = [volume[1]!, volume[2]!]
      this.onChange({ kind: 'volume', seriesId, volumeId })
      this.onChange({ kind: 'outline', seriesId, volumeId })
      for (const rel of rels) {
        const chapterId = /^chapters\/([^/]+)\.json$/.exec(rel)?.[1]
        if (chapterId) this.onChange({ kind: 'chapter', seriesId, volumeId, chapterId })
      }
    }
    if (series) this.onChange({ kind: 'series', seriesId: series })
    if (world) {
      this.onChange({ kind: 'world', worldId: world })
      for (const rel of rels) {
        const entryId = /^entries\/([^/]+)\.json$/.exec(rel)?.[1]
        if (entryId) this.onChange({ kind: 'entry', worldId: world, entryId })
        if (rel === 'inbox.json' || rel.startsWith('inbox/'))
          this.onChange({ kind: 'inbox', worldId: world })
      }
    }
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
    if (rel.includes('/')) await fs.promises.mkdir(dirname(join(unitDir, rel)), { recursive: true })
    const written = await writeJsonFile(join(unitDir, rel), value)
    await this.recordInManifest({ type: unitType, dir: unitDir, id: unitId }, rel, written)
  }

  /** Updates one file's manifest entry (`null` = the file was removed). */
  private async recordInManifest(
    unit: SyncUnit,
    rel: string,
    written: { hash: string; size: number } | null,
  ): Promise<void> {
    const manifestPath = join(unit.dir, unitPaths.manifest)
    let manifest: ManifestFile
    try {
      manifest = await readJsonFile(manifestPath, manifestFileSchema)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      // Missing or damaged manifest: it is derived data, so rebuild it from the files.
      await this.rebuildManifest(unit.type, unit.dir, unit.id)
      return
    }
    if (written) manifest.files[rel] = { ...written, modifiedAt: this.timestamp() }
    else delete manifest.files[rel]
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

/** Drops keys whose value is undefined, so a patch never blanks a field by accident. */
function definedOnly<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Partial<T>
}

const COVER_NAMES = new Set(COVER_EXTENSIONS.map((ext) => `cover.${ext}`))

/** Cover files in a folder, newest first. Normally there is at most one. */
async function findCoverFiles(dir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const covers = names.filter((name) => COVER_NAMES.has(name))
  const times = await Promise.all(
    covers.map(async (name) => (await fs.promises.stat(join(dir, name))).mtimeMs),
  )
  return covers
    .map((name, i) => ({ name, time: times[i]! }))
    .sort((a, b) => b.time - a.time)
    .map((c) => c.name)
}

async function coverInfo(dir: string): Promise<CoverInfo | null> {
  const [name] = await findCoverFiles(dir)
  if (!name) return null
  const stat = await fs.promises.stat(join(dir, name))
  return { version: `${name}-${Math.round(stat.mtimeMs)}-${stat.size}` }
}

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
