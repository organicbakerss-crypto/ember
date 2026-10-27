/**
 * The contract between the main process and renderer windows.
 *
 * The main process owns all disk access. Renderers call these requests and
 * listen for change broadcasts so every open window stays live.
 */
import { z } from 'zod'
import { MAX_COVER_BYTES, type CoverInfo, type CoverTarget } from './media'
import { PAGE_WIDTH, STATUS_ITEMS, type AppSettings } from './settings'

export { DEFAULT_APP_SETTINGS, PAGE_WIDTH, type AppSettings } from './settings'
import {
  chapterTypeSchema,
  id,
  nameSchema,
  outlineFileSchema,
  richTextDocSchema,
  volumeGoalsSchema,
  type ChapterFile,
  type RichTextDoc,
  type OutlineFile,
  type SeriesFile,
  type VolumeFile,
  type WorldFile,
} from './schema'

/* ---------- shared result types ---------- */

export type LibraryStatus = { state: 'none'; defaultPath: string } | { state: 'open'; root: string }

export interface LibraryProblem {
  /** Path relative to the library root. */
  path: string
  message: string
}

export interface VolumeSummary extends VolumeFile {
  cover: CoverInfo | null
  wordCount: number
}

export interface SeriesSummary extends SeriesFile {
  cover: CoverInfo | null
  /** In reading order. */
  volumes: VolumeSummary[]
}

export interface WorldSummary extends WorldFile {
  cover: CoverInfo | null
}

export interface LibrarySnapshot {
  root: string
  series: SeriesSummary[]
  worlds: WorldSummary[]
  /** Files that could not be read. They are reported, never deleted or rewritten. */
  problems: LibraryProblem[]
  /** Items in this device's trash. */
  trashCount: number
}

export interface OutlineView {
  outline: OutlineFile
  /** Chapter metadata keyed by id (no content), for drawing the binder. */
  chapters: Record<string, Pick<ChapterFile, 'id' | 'title' | 'type' | 'pov'>>
  problems: LibraryProblem[]
}

export interface VolumeStats {
  /** Words per chapter, as saved on disk. */
  chapterWords: Record<string, number>
  /** The volume's total when this app session first opened it (for session counts). */
  sessionStartWords: number
}

/** One place a search matched, with a little text around it. */
export interface SearchHit {
  chapterId: string
  /** Which text node in the chapter (reading order) and where in it. */
  node: number
  start: number
  end: number
  before: string
  match: string
  after: string
}

export interface SearchResult {
  hits: SearchHit[]
  /** Chapter titles for the hits, keyed by id, in reading order. */
  chapters: { id: string; title: string }[]
  total: number
  /** True when there were more hits than are listed. */
  truncated: boolean
}

/** Something that can be moved to the trash. */
export type TrashTarget =
  | { kind: 'series'; seriesId: string }
  | { kind: 'volume'; seriesId: string; volumeId: string }
  | { kind: 'world'; worldId: string }
  | { kind: 'chapter'; seriesId: string; volumeId: string; chapterId: string }

/** An item in the device's trash. */
export interface TrashEntry {
  id: string
  kind: TrashTarget['kind']
  name: string
  deletedAt: string
  /** Where it came from, for display ("in The Long Night › Landfall"). */
  from: string | null
}

/** A saved earlier version of a chapter. */
export interface SnapshotInfo {
  id: string
  savedAt: string
  title: string
  wordCount: number
  /** Why it was taken: on a schedule while writing, or just before a restore or replace-all. */
  reason: 'auto' | 'manual' | 'before-deletion' | 'before-restore' | 'before-replace'
}

export const SNAPSHOT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/

export type LibraryChange =
  | { kind: 'library' }
  | { kind: 'trash' }
  | { kind: 'series'; seriesId: string }
  | { kind: 'volume'; seriesId: string; volumeId: string }
  | { kind: 'outline'; seriesId: string; volumeId: string }
  | { kind: 'chapter'; seriesId: string; volumeId: string; chapterId: string }
  | { kind: 'world'; worldId: string }

/** What a cover belongs to. Covers live inside that item's folder. */
export const coverTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('series'), seriesId: id('series') }),
  z.object({ kind: z.literal('volume'), seriesId: id('series'), volumeId: id('volume') }),
  z.object({ kind: z.literal('world'), worldId: id('world') }),
]) satisfies z.ZodType<CoverTarget>

/* ---------- request inputs (validated in the main process) ---------- */

const volumeRef = { seriesId: id('series'), volumeId: id('volume') }

export const trashTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('series'), seriesId: id('series') }),
  z.object({ kind: z.literal('volume'), seriesId: id('series'), volumeId: id('volume') }),
  z.object({ kind: z.literal('world'), worldId: id('world') }),
  z.object({ kind: z.literal('chapter'), ...volumeRef, chapterId: id('chapter') }),
]) satisfies z.ZodType<TrashTarget>

export const ipcInputs = {
  'library:status': z.void(),
  'library:choose': z.void(),
  'library:openDefault': z.void(),
  'library:snapshot': z.void(),
  'series:create': z.object({
    name: nameSchema,
    world: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('none') }),
      z.object({ mode: z.literal('existing'), worldId: id('world') }),
      z.object({ mode: z.literal('new'), name: nameSchema }),
    ]),
  }),
  'series:rename': z.object({ seriesId: id('series'), name: nameSchema }),
  'world:rename': z.object({ worldId: id('world'), name: nameSchema }),
  'arc:delete': z.object({
    ...volumeRef,
    arcId: id('arc'),
    /** What happens to the arc's chapters: moved out to the top level, or trashed too. */
    chapters: z.enum(['keep', 'trash']),
  }),
  'history:list': z.object({ ...volumeRef, chapterId: id('chapter') }),
  'history:read': z.object({
    ...volumeRef,
    chapterId: id('chapter'),
    snapshotId: z.string().regex(SNAPSHOT_ID),
  }),
  'history:keep': z.object({ ...volumeRef, chapterId: id('chapter') }),
  'history:restore': z.object({
    ...volumeRef,
    chapterId: id('chapter'),
    snapshotId: z.string().regex(SNAPSHOT_ID),
  }),
  'search:volume': z.object({
    ...volumeRef,
    query: z.string().min(1).max(500),
    matchCase: z.boolean(),
    wholeWord: z.boolean(),
  }),
  'search:replaceAll': z.object({
    ...volumeRef,
    query: z.string().min(1).max(500),
    replacement: z.string().max(500),
    matchCase: z.boolean(),
    wholeWord: z.boolean(),
  }),
  'spelling:languages': z.void(),
  'trash:add': z.object({ target: trashTargetSchema }),
  'trash:list': z.void(),
  'trash:restore': z.object({ trashId: id('trash') }),
  'trash:purge': z.object({ trashId: id('trash') }),
  'trash:empty': z.void(),
  'series:setWorld': z.object({ seriesId: id('series'), worldId: id('world').nullable() }),
  'volume:create': z.object({ seriesId: id('series'), name: nameSchema }),
  'outline:get': z.object(volumeRef),
  'outline:save': z.object({ ...volumeRef, outline: outlineFileSchema }),
  'arc:create': z.object({ ...volumeRef, name: nameSchema }),
  'chapter:create': z.object({
    ...volumeRef,
    title: z.string().trim().max(200),
    type: chapterTypeSchema.optional(),
    arcId: id('arc').optional(),
  }),
  'chapter:read': z.object({ ...volumeRef, chapterId: id('chapter') }),
  'chapter:save': z.object({
    ...volumeRef,
    chapterId: id('chapter'),
    /** Only the fields that changed. Anything left out keeps its value on disk. */
    patch: z.object({
      title: z.string().trim().max(200).optional(),
      type: chapterTypeSchema.optional(),
      pov: z.string().trim().max(200).nullable().optional(),
      notes: z.string().optional(),
      content: richTextDocSchema.optional(),
    }),
  }),
  'volume:update': z.object({
    ...volumeRef,
    name: nameSchema.optional(),
    goals: volumeGoalsSchema.optional(),
  }),
  'volume:stats': z.object(volumeRef),
  /** Every chapter's paragraphs, in reading order (for volume-wide diagnostics). */
  'volume:texts': z.object(volumeRef),
  /** Words from the names of characters and places in the volume's world. */
  'volume:names': z.object(volumeRef),
  'settings:get': z.void(),
  'settings:update': z.object({
    theme: z.string().min(1).max(100).optional(),
    spellcheck: z.boolean().optional(),
    spellLanguages: z.array(z.string().max(20)).max(10).optional(),
    dictionary: z.array(z.string().trim().min(1).max(100)).max(50000).optional(),
    analysis: z
      .object({
        fillerWords: z.array(z.string().trim().toLowerCase().min(1).max(50)).max(2000),
        includeNames: z.boolean(),
        echoRange: z.number().int().min(5).max(500),
        rhythmMediumFrom: z.number().int().min(2).max(100),
        rhythmLongFrom: z.number().int().min(3).max(200),
        rhythmColors: z.object({
          short: z
            .string()
            .regex(/^#[0-9a-f]{6}$/i)
            .nullable(),
          medium: z
            .string()
            .regex(/^#[0-9a-f]{6}$/i)
            .nullable(),
          long: z
            .string()
            .regex(/^#[0-9a-f]{6}$/i)
            .nullable(),
        }),
      })
      .refine((a) => a.rhythmLongFrom > a.rhythmMediumFrom, {
        message: 'Long sentences must start above the medium threshold.',
      })
      .optional(),
    statusBar: z.array(z.enum(STATUS_ITEMS)).max(STATUS_ITEMS.length).optional(),
    pageWidth: z.number().int().min(PAGE_WIDTH.min).max(PAGE_WIDTH.max).optional(),
  }),
  /** Sent by a window once it has saved everything, in reply to `window:flush`. */
  'window:flushed': z.void(),
  'world:create': z.object({ name: nameSchema }),
  'cover:set': z.object({
    target: coverTargetSchema,
    data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= MAX_COVER_BYTES, {
      message: 'That image is too large (20 MB at most).',
    }),
  }),
  'cover:remove': z.object({ target: coverTargetSchema }),
} satisfies Record<string, z.ZodType>

export type IpcChannel = keyof typeof ipcInputs
export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcInputs)[C]>

export interface IpcResults {
  'library:status': LibraryStatus
  'library:choose': LibraryStatus
  'library:openDefault': LibraryStatus
  'library:snapshot': LibrarySnapshot
  'series:create': SeriesFile
  'series:setWorld': SeriesFile
  'series:rename': SeriesFile
  'world:rename': WorldFile
  'arc:delete': OutlineView
  'history:list': SnapshotInfo[]
  'history:read': { info: SnapshotInfo; content: RichTextDoc }
  'history:keep': null
  'history:restore': ChapterFile
  'search:volume': SearchResult
  'search:replaceAll': { chapters: number; replacements: number }
  'spelling:languages': string[]
  'trash:add': TrashEntry
  'trash:list': TrashEntry[]
  'trash:restore': TrashEntry
  'trash:purge': null
  'trash:empty': null
  'volume:create': VolumeFile
  'outline:get': OutlineView
  'outline:save': OutlineView
  'arc:create': OutlineView
  'chapter:create': ChapterFile
  'chapter:read': ChapterFile
  'chapter:save': ChapterFile
  'world:create': WorldFile
  'volume:update': VolumeFile
  'volume:stats': VolumeStats
  'volume:texts': { id: string; title: string; paragraphs: string[] }[]
  'volume:names': string[]
  'settings:get': AppSettings
  'settings:update': AppSettings
  'window:flushed': null
  'cover:set': CoverInfo
  'cover:remove': null
}

export type IpcResult<C extends IpcChannel> = IpcResults[C]

/** What actually crosses the IPC boundary. Errors are values, not thrown. */
export type IpcEnvelope<T> =
  { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } }

export type ErrorCode =
  | 'invalid-input'
  | 'no-library'
  | 'not-a-library'
  | 'not-found'
  | 'corrupt'
  | 'conflict'
  | 'cancelled'
  | 'internal'

export interface IpcEvents {
  'library:changed': LibraryChange
  'settings:changed': AppSettings
  /** The window is about to close: save everything, then invoke `window:flushed`. */
  'window:flush': null
}

/** Shape of `window.api`, exposed by the preload script. */
export interface RendererApi {
  invoke<C extends IpcChannel>(
    channel: C,
    ...args: IpcInput<C> extends void ? [] : [IpcInput<C>]
  ): Promise<IpcResult<C>>
  on<E extends keyof IpcEvents>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

export const IPC_INVOKE_PREFIX = 'invoke:'
export const IPC_EVENT_PREFIX = 'event:'
