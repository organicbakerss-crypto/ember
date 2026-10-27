/**
 * The contract between the main process and renderer windows.
 *
 * The main process owns all disk access. Renderers call these requests and
 * listen for change broadcasts so every open window stays live.
 */
import { z } from 'zod'
import {
  chapterFileSchema,
  chapterTypeSchema,
  id,
  nameSchema,
  outlineFileSchema,
  type ChapterFile,
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

export interface SeriesSummary extends SeriesFile {
  volumes: VolumeFile[]
}

export interface LibrarySnapshot {
  root: string
  series: SeriesSummary[]
  worlds: WorldFile[]
  /** Files that could not be read. They are reported, never deleted or rewritten. */
  problems: LibraryProblem[]
}

export interface OutlineView {
  outline: OutlineFile
  /** Chapter metadata keyed by id (no content), for drawing the binder. */
  chapters: Record<string, Pick<ChapterFile, 'id' | 'title' | 'type' | 'pov'>>
  problems: LibraryProblem[]
}

export type LibraryChange =
  | { kind: 'library' }
  | { kind: 'series'; seriesId: string }
  | { kind: 'volume'; seriesId: string; volumeId: string }
  | { kind: 'outline'; seriesId: string; volumeId: string }
  | { kind: 'chapter'; seriesId: string; volumeId: string; chapterId: string }
  | { kind: 'world'; worldId: string }

/* ---------- request inputs (validated in the main process) ---------- */

const volumeRef = { seriesId: id('series'), volumeId: id('volume') }

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
  'chapter:save': z.object({ ...volumeRef, chapter: chapterFileSchema }),
  'world:create': z.object({ name: nameSchema }),
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
  'volume:create': VolumeFile
  'outline:get': OutlineView
  'outline:save': OutlineView
  'arc:create': OutlineView
  'chapter:create': ChapterFile
  'chapter:read': ChapterFile
  'chapter:save': ChapterFile
  'world:create': WorldFile
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
