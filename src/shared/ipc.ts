/**
 * The contract between the main process and renderer windows.
 *
 * The main process owns all disk access. Renderers call these requests and
 * listen for change broadcasts so every open window stays live.
 */
import { z } from 'zod'
import { MAX_COVER_BYTES, MAX_MAP_BYTES, type CoverInfo, type CoverTarget } from './media'
import { docKeySchema, paneRouteSchema, type PaneRoute } from './panes'
import { PAGE_WIDTH, STATUS_ITEMS, type AppSettings } from './settings'
import { aiSettingsSchema, exportSettingsSchema, voiceSettingsSchema } from './exportSettings'

export { DEFAULT_APP_SETTINGS, PAGE_WIDTH, type AppSettings } from './settings'
import type { NameSuggestion } from './world/nameCatcher'
import type { StoryChapter, WorldIndex } from './world/story'
import {
  chapterSourceSchema,
  chapterTypeSchema,
  inboxItemSchema,
  factValueSchema,
  fieldIdSchema,
  id,
  lensSchema,
  portraitSchema,
  quoteSchema,
  boardFileSchema,
  pinSchema,
  relationshipFileSchema,
  conversationFileSchema,
  type ConversationFile,
  relationshipTypeSchema,
  regionSchema,
  sketchSchema,
  templateFieldSchema,
  timelinePlaceSchema,
  factAnchorSchema,
  nameSchema,
  outlineFileSchema,
  richTextDocSchema,
  volumeGoalsSchema,
  type ChapterFile,
  type ChapterSource,
  type FactValue,
  type InboxItem,
  type BoardFile,
  type MapFile,
  type RelationshipFile,
  type RelationshipType,
  type Portrait,
  type TimelinePlace,
  type RichTextDoc,
  type Template,
  type OutlineFile,
  type SeriesFile,
  type VolumeFile,
  type WorldEntryFile,
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
  chapters: Record<string, Pick<ChapterFile, 'id' | 'title' | 'type' | 'pov' | 'povEntryId'>>
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
  | { kind: 'entry'; worldId: string; entryId: string }
  | { kind: 'map'; worldId: string; mapId: string }

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
  reason:
    | 'auto'
    | 'manual'
    | 'before-deletion'
    | 'before-restore'
    | 'before-replace'
    | 'before-sync'
    | 'before-ai'
    | 'after-ai'
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
  | { kind: 'entry'; worldId: string; entryId: string }
  | { kind: 'inbox'; worldId: string }

export type { NameSuggestion, StoryChapter, WorldIndex }

/** A world entry in lists, cards and name matching (everything but the page itself). */
export interface EntrySummary {
  id: string
  name: string
  aliases: string[]
  template: string
  facts: Record<string, FactValue[]>
  /** The start of the entry's page. */
  snippet: string
  portrait: Portrait | null
  mergedFrom: string[]
  /** Entries linked from the page: with `@`, or by typing their name. */
  links: string[]
  /** For eras and events: their place on the timeline. */
  when: TimelinePlace | null
  updatedAt: string
}

export interface WorldView {
  world: WorldFile
  /** Templates in effect: built-ins, replaced or joined by this world's own. */
  templates: Template[]
  /** Ids of templates saved in this world (customised or new). */
  customTemplates: string[]
  entries: EntrySummary[]
  /** Entry files that could not be read (left untouched on disk). */
  problems: LibraryProblem[]
  /** Captured items waiting in the inbox. */
  inboxCount: number
  /** Image maps (the world map and maps of places) and the travel sketch, oldest first. */
  maps: MapFile[]
  /** Places next to each place, computed from touching map regions and sketch roads. */
  nearby: Record<string, string[]>
  /** Every relationship (the people board's lines). */
  relationships: RelationshipFile[]
  /** Relationship types in effect: built-ins, replaced or joined by this world's own. */
  relationshipTypes: RelationshipType[]
  /** Where portraits sit on the board (0–1 across and down). */
  board: BoardFile['positions']
  /**
   * Which version of the map, board and templates this was read from (sync
   * changes it). Saves send it back; one made from a replaced version is refused.
   */
  syncGen: number
}

/** A chapter where an entry is mentioned (or told from its point of view). */
export interface Appearance {
  chapter: StoryChapter
  /** Position in the world's reading order. */
  position: number
  count: number
  pov: boolean
  /** The sentences it is mentioned in (the first few). */
  lines: string[]
}

export interface WorldInbox {
  captured: InboxItem[]
  /** New names from the name catcher (empty when it is turned off). */
  names: NameSuggestion[]
}

/** AI work, running in the background of the app. */
export interface AiJobInfo {
  /** The request id. */
  id: string
  kind: 'ask' | 'edit' | 'world' | 'names' | 'voices'
  seriesId: string
  /** The conversation it belongs to (ask and edit), as it was when asked. */
  conversation: ConversationFile | null
  volumeId: string | null
  chapterId: string | null
  chapterTitle: string
  /** Edit: the chapter as sent (Markdown), to check nothing changed before the edit goes in. */
  sent: string | null
  state: 'running' | 'done' | 'failed' | 'cancelled'
  /** The answer so far (or the edited chapter). */
  text: string
  progress: string
  error: string | null
  /** Update the world (and sorting names): what it did. */
  result: {
    summary?: string
    applied: number
    suggestions: number
    continuity?: number
    questions?: number
    /** Sorting names: names it found weren't names for the world. */
    skipped?: number
    /** The audiobook script: where it was saved (null: not saved), and its size. */
    saved?: string | null
    chapters?: number
    lines?: number
  } | null
  startedAt: string
  endedAt: string | null
  /** The window that asked (its web contents id). */
  origin: number
  /** Started by itself (keeping the world up to date), not asked for. */
  auto?: boolean
}

/** A chapter in reading order with the AI's summary of it. */
export interface ChapterSummaryInfo {
  chapter: StoryChapter
  summary: string | null
  /** False when the chapter changed after the summary was made. */
  current: boolean
  words: number
}

/** A version set aside when both computers changed something. */
export interface ConflictInfo {
  id: string
  /** What it is ("Chapter order", "Map “Coast”"). */
  what: string
  /** The story, book or world it belongs to. */
  where: string
  /** The computer it came from ('' for this one's, set aside by a restore). */
  device: string
  savedAt: string
  reason: 'both-changed' | 'replaced'
}

/** What an action changed, so it can be undone. */
export interface EntryChangeResult {
  trash: TrashEntry
  /** Entries as they were before (restore these to undo). */
  before: WorldEntryFile[]
  /** Relationships changed or removed, as they were (save these again to undo). */
  relationships: RelationshipFile[]
}

/** What the right-click menu can capture into, sent by a writing window. */
export interface CaptureContext {
  worldId: string
  source: ChapterSource
  targets: { entryId: string; name: string; fields: { id: string; label: string }[] }[]
}

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
  z.object({ kind: z.literal('entry'), worldId: id('world'), entryId: id('entry') }),
  z.object({ kind: z.literal('map'), worldId: id('world'), mapId: id('map') }),
]) satisfies z.ZodType<TrashTarget>

export const ipcInputs = {
  'library:status': z.void(),
  'library:choose': z.void(),
  'library:openDefault': z.void(),
  'library:snapshot': z.void(),
  /** How much space the library takes on this computer. */
  'library:size': z.void(),
  /** How much space the library takes in the cloud. */
  'sync:usage': z.void(),
  'series:create': z.object({
    name: nameSchema,
    world: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('none') }),
      z.object({ mode: z.literal('existing'), worldId: id('world') }),
      z.object({ mode: z.literal('new'), name: nameSchema }),
    ]),
    kind: z.enum(['series', 'book']).optional(),
  }),
  /** Shows a story as a single book or as a series. */
  'series:setKind': z.object({ seriesId: id('series'), kind: z.enum(['series', 'book']) }),
  /** Turns the map, the people board or the timeline on or off for one world. */
  'world:setFeatures': z.object({
    worldId: id('world'),
    features: z.object({
      map: z.boolean().optional(),
      board: z.boolean().optional(),
      timeline: z.boolean().optional(),
    }),
  }),
  'series:rename': z.object({ seriesId: id('series'), name: nameSchema }),
  'series:describe': z.object({ seriesId: id('series'), description: z.string().max(10000) }),
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
  'history:keep': z.object({
    ...volumeRef,
    chapterId: id('chapter'),
    reason: z.enum(['manual', 'before-ai', 'after-ai']).optional(),
  }),
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
  'world:get': z.object({ worldId: id('world') }),
  'world:index': z.object({ worldId: id('world') }),
  'world:digest': z.object({ worldId: id('world') }),
  'world:pin': z.object({ worldId: id('world'), entryId: id('entry'), pinned: z.boolean() }),
  'template:save': z.object({
    worldId: id('world'),
    /** The world view's `syncGen` the change was made from. */
    seen: z.number().int().nonnegative().optional(),
    template: z.object({
      /** Leave out for a new template. */
      id: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{0,59}$/)
        .optional(),
      name: z.string().trim().min(1).max(60),
      lens: lensSchema,
      fields: z.array(templateFieldSchema.extend({ id: fieldIdSchema.optional() })).max(40),
    }),
  }),
  'template:delete': z.object({
    worldId: id('world'),
    templateId: z.string().min(1).max(60),
    seen: z.number().int().nonnegative().optional(),
  }),
  'entry:create': z.object({
    worldId: id('world'),
    name: nameSchema,
    template: z.string().min(1).max(60),
    facts: z.record(fieldIdSchema, z.array(factValueSchema).max(200)).optional(),
  }),
  'entry:read': z.object({ worldId: id('world'), entryId: id('entry') }),
  'entry:save': z.object({
    worldId: id('world'),
    entryId: id('entry'),
    patch: z.object({
      name: nameSchema.optional(),
      aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
      template: z.string().min(1).max(60).optional(),
      facts: z.record(fieldIdSchema, z.array(factValueSchema).max(200)).optional(),
      body: richTextDocSchema.optional(),
      quotes: z.array(quoteSchema).max(2000).optional(),
      portrait: portraitSchema.nullable().optional(),
      mergedFrom: z.array(id('entry')).max(500).optional(),
      when: timelinePlaceSchema.nullable().optional(),
    }),
  }),
  'entry:appearances': z.object({ worldId: id('world'), entryId: id('entry') }),
  'entry:text': z.object({ worldId: id('world'), entryId: id('entry') }),
  'entry:duplicate': z.object({ worldId: id('world'), entryId: id('entry') }),
  'entry:merge': z.object({ worldId: id('world'), keepId: id('entry'), mergeId: id('entry') }),
  'entry:delete': z.object({
    worldId: id('world'),
    entryId: id('entry'),
    /** Also remove links to it from other entries (otherwise they show as missing). */
    unlink: z.boolean(),
  }),
  'entry:portrait': z.object({
    worldId: id('world'),
    entryId: id('entry'),
    data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= MAX_COVER_BYTES, {
      message: 'That image is too large (20 MB at most).',
    }),
  }),
  'entry:capture': z.object({
    worldId: id('world'),
    entryId: id('entry'),
    field: fieldIdSchema.nullable(),
    text: z.string().trim().min(1).max(5000),
    source: chapterSourceSchema,
  }),
  'inbox:get': z.object({ worldId: id('world'), names: z.boolean() }),
  'inbox:capture': z.object({
    worldId: id('world'),
    text: z.string().trim().min(1).max(5000),
    source: chapterSourceSchema,
  }),
  'inbox:file': z.object({
    worldId: id('world'),
    itemId: id('inbox'),
    entryId: id('entry'),
    field: fieldIdSchema.nullable(),
  }),
  'inbox:dismiss': z.object({ worldId: id('world'), itemId: id('inbox') }),
  'names:reject': z.object({
    worldId: id('world'),
    names: z.array(z.string().trim().min(1).max(200)).max(500),
    /** False takes names off the list again (undo). */
    rejected: z.boolean(),
  }),
  'map:create': z.object({
    worldId: id('world'),
    name: nameSchema,
    placeId: id('entry').nullable(),
    image: z
      .object({
        data: z.instanceof(Uint8Array).refine((d) => d.byteLength <= MAX_MAP_BYTES, {
          message: 'That map image is too large (60 MB at most).',
        }),
        width: z.number().int().positive().max(20000),
        height: z.number().int().positive().max(20000),
      })
      .nullable(),
    /**
     * A new version of an existing map, from an event onwards: it starts as a
     * copy of `copyFrom` (the version shown), with a new image if one is given.
     */
    version: z.object({ of: id('map'), copyFrom: id('map'), from: factAnchorSchema }).optional(),
  }),
  'map:save': z.object({
    worldId: id('world'),
    /** The world view's `syncGen` the change was made from. */
    seen: z.number().int().nonnegative().optional(),
    mapId: id('map'),
    patch: z.object({
      name: nameSchema.optional(),
      regions: z.array(regionSchema).max(5000).optional(),
      pins: z.array(pinSchema).max(5000).optional(),
      sketch: sketchSchema.nullable().optional(),
      placeId: id('entry').nullable().optional(),
    }),
  }),
  'relationship:save': z.object({
    worldId: id('world'),
    relationship: relationshipFileSchema
      .pick({ from: true, to: true, type: true, kin: true, over: true, start: true, end: true })
      .extend({
        id: id('relationship').optional(),
        label: z.string().trim().max(80),
        createdAt: z.iso.datetime().optional(),
      }),
  }),
  'relationship:delete': z.object({ worldId: id('world'), relationshipId: id('relationship') }),
  'relationship:types': z.object({
    worldId: id('world'),
    /** The world view's `syncGen` the change was made from. */
    seen: z.number().int().nonnegative().optional(),
    types: z.array(relationshipTypeSchema).max(60),
  }),
  'board:save': z.object({
    worldId: id('world'),
    /** The world view's `syncGen` the change was made from. */
    seen: z.number().int().nonnegative().optional(),
    positions: boardFileSchema.shape.positions,
  }),
  'capture:context': z.object({
    context: z
      .object({
        worldId: id('world'),
        source: chapterSourceSchema,
        targets: z
          .array(
            z.object({
              entryId: id('entry'),
              name: z.string().max(200),
              fields: z.array(z.object({ id: fieldIdSchema, label: z.string().max(60) })).max(40),
            }),
          )
          .max(30),
      })
      .nullable(),
  }),
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
      povEntryId: id('entry').nullable().optional(),
      notes: z.string().optional(),
      content: richTextDocSchema.optional(),
    }),
  }),
  'volume:update': z.object({
    ...volumeRef,
    name: nameSchema.optional(),
    goals: volumeGoalsSchema.optional(),
    /** This book's chapter headings in exports (overrides Settings). */
    headings: z.enum(['both', 'number', 'title']).nullable().optional(),
    /** Finished: its chapters keep fewer old versions. */
    finished: z.boolean().optional(),
  }),
  'volume:stats': z.object(volumeRef),
  /** Every chapter's paragraphs, in reading order (for volume-wide diagnostics). */
  'volume:texts': z.object(volumeRef),
  /** Words from the names of characters and places in the volume's world. */
  'volume:names': z.object(volumeRef),
  'settings:get': z.void(),
  'settings:update': z.object({
    theme: z.string().min(1).max(100).optional(),
    pageView: z.enum(['pages', 'continuous']).optional(),
    paperSize: z.enum(['a4', 'letter', 'trade']).optional(),
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
    linkNames: z.boolean().optional(),
    world: z
      .object({
        hoverCards: z.boolean(),
        nameCatcher: z.boolean(),
        quietAfter: z.number().int().min(1).max(200),
        map: z.boolean(),
        lighter: z.boolean(),
        blendLines: z.boolean(),
        timeScrubber: z.boolean(),
        trails: z.boolean(),
        skin: z.enum(['full', 'plain', 'minimal']),
        vocabulary: z.boolean(),
      })
      .optional(),
    export: exportSettingsSchema.optional(),
    ai: aiSettingsSchema.optional(),
    voice: voiceSettingsSchema.optional(),
    pageWidth: z.number().int().min(PAGE_WIDTH.min).max(PAGE_WIDTH.max).optional(),
  }),
  /** Sent by a window once it has saved everything, in reply to `window:flush`. */
  'window:flushed': z.void(),
  /** Exports a volume (or some of its chapters) to a file the writer picks. */
  'export:volume': z.object({
    seriesId: id('series'),
    volumeId: id('volume'),
    format: z.enum(['docx', 'pdf', 'epub', 'markdown']),
    /** Only these chapters (in reading order); the whole volume when left out. */
    chapterIds: z.array(id('chapter')).min(1).max(5000).optional(),
  }),
  /** Copies one chapter for pasting into Royal Road. */
  'export:royalRoad': z.object({
    seriesId: id('series'),
    volumeId: id('volume'),
    chapterId: id('chapter'),
  }),
  /** Picks a Word file and reads it for import (nothing is created yet). */
  'import:docx': z.void(),
  'sync:status': z.void(),
  /**
   * Connects this library to a cloud bucket. When the cloud already holds
   * other work and so does this library, it asks first (`confirm` to go ahead).
   */
  'sync:connect': z.union([
    /** One Cloudflare API token: the app makes (or finds) its own bucket. */
    z.object({
      token: z.string().trim().min(20).max(400),
      device: z.string().trim().min(1).max(60),
      confirm: z.boolean().optional(),
    }),
    /** A bucket set up by hand. */
    z.object({
      url: z.string().trim().min(1).max(500),
      accessKeyId: z.string().trim().min(1).max(200),
      secretAccessKey: z.string().trim().min(1).max(200),
      device: z.string().trim().min(1).max(60),
      confirm: z.boolean().optional(),
    }),
  ]),
  /** Whether the AI (Ollama) can be reached, and which models it has. */
  'ai:status': z
    .object({
      host: z.string().trim().min(1).max(300).optional(),
      provider: z.enum(['ollama', 'chatgpt']).optional(),
    })
    .optional(),
  /** Chat, brainstorm or ask the story about what the writer is reading (streams `ai:token`). */
  'ai:ask': z.object({
    requestId: z.string().min(1).max(80),
    seriesId: id('series'),
    /** The conversation with the new message: saved now, and with the answer when it comes. */
    conversation: conversationFileSchema,
    mode: z.enum(['chat', 'brainstorm', 'ask']),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20000) }))
      .min(1)
      .max(100),
    scope: z
      .object({
        kind: z.enum(['selection', 'screen', 'chapter', 'story']),
        seriesId: id('series'),
        volumeId: id('volume').nullable(),
        chapterId: id('chapter').nullable(),
        text: z.string().max(200000),
      })
      .nullable(),
  }),
  /**
   * The AI's edit of the open chapter, as asked (streams `ai:token`). Nothing
   * is written: the window puts it in, keeps versions and shows the changes.
   */
  'ai:editChapter': z.object({
    requestId: z.string().min(1).max(80),
    seriesId: id('series'),
    volumeId: id('volume'),
    chapterId: id('chapter'),
    /** The conversation with the request (saved now). */
    conversation: conversationFileSchema,
    instruction: z.string().trim().min(1).max(20000),
    chapterTitle: z.string().max(300),
    chapter: z.string().max(500000),
    messages: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20000) }))
      .max(40),
  }),
  'ai:cancel': z.object({ requestId: z.string().min(1).max(80) }),
  /** The story's AI work: running, and finished but not yet shown. */
  'ai:jobs': z.object({ seriesId: id('series') }),
  /** A pane has shown a finished job's result. */
  'ai:jobSeen': z.object({ id: z.string().min(1).max(80) }),
  /** Reads a chapter for the world: summary kept, findings to the inbox (progress as `ai:progress`). */
  'ai:updateWorld': z.object({
    requestId: z.string().min(1).max(80),
    seriesId: id('series'),
    volumeId: id('volume'),
    chapterId: id('chapter'),
  }),
  /** A story's chapters in reading order with their AI summaries. */
  'ai:summaries': z.object({ seriesId: id('series') }),
  /** Accepts an AI suggestion from the inbox: the change is made in the world. */
  'inbox:accept': z.object({ worldId: id('world'), itemId: id('inbox') }),
  /** Takes back a change the AI made itself. */
  'inbox:undo': z.object({ worldId: id('world'), itemId: id('inbox') }),
  /** The AI sorts new names: what each is (an entry made), or not a name (turned down). */
  'ai:sortNames': z.object({
    requestId: z.string().min(1).max(80),
    seriesId: id('series'),
    worldId: id('world'),
    names: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(200),
          quote: z.string().max(2000),
          chapterId: id('chapter'),
        }),
      )
      .min(1)
      .max(300),
  }),
  /**
   * The audiobook script for VoiceStudio (a chapter, a volume or the whole
   * story): who speaks is marked by the AI first; then it asks where to save.
   */
  'voice:script': z.object({
    requestId: z.string().min(1).max(80),
    seriesId: id('series'),
    volumeId: id('volume').nullable(),
    chapterId: id('chapter').nullable(),
  }),
  /** Whether VoiceStudio is running (and will be used), and its voices. */
  'voice:status': z.void(),
  /** Speech for a passage, in a VoiceStudio voice (by name; '' its default), as WAV. */
  'voice:speak': z.object({
    text: z.string().min(1).max(5000),
    voice: z.string().max(200),
    /** Make it again (Redo), not the kept one. */
    fresh: z.boolean().optional(),
  }),
  /** What was said in a recording (VoiceStudio), tidied with the story's names. */
  'voice:transcribe': z.object({
    audio: z.instanceof(Uint8Array).refine((d) => d.byteLength <= 50_000_000),
    mime: z.string().max(100),
    seriesId: id('series').nullable(),
  }),
  /** Who says each line of a chapter, and who narrates (marked by the AI if needed). */
  'voice:chapterSpeakers': z.object({
    requestId: z.string().min(1).max(80),
    seriesId: id('series'),
    volumeId: id('volume'),
    chapterId: id('chapter'),
  }),
  /** Every line of dialogue in a chapter with who says it (marked by the AI if needed). */
  'voice:lines': z.object({
    requestId: z.string().min(1).max(80),
    seriesId: id('series'),
    volumeId: id('volume'),
    chapterId: id('chapter'),
  }),
  /** The writer fixes who says a line ('' = anyone else). */
  'voice:fixLine': z.object({
    seriesId: id('series'),
    volumeId: id('volume'),
    chapterId: id('chapter'),
    key: z.string().min(1).max(200),
    name: z.string().max(200),
  }),
  /** The voices a story is read with. */
  'voice:setCast': z.object({
    seriesId: id('series'),
    voices: z.object({
      narrator: z.string().max(200),
      other: z.string().max(200),
      characters: z.record(z.string().max(200), z.string().max(200)),
    }),
  }),
  'voice:cast': z.object({ seriesId: id('series') }),
  /** Answers a question the AI asked. */
  'inbox:answer': z.object({
    worldId: id('world'),
    itemId: id('inbox'),
    answer: z.string().trim().min(1).max(5000),
  }),
  /** Puts an inbox item back as it was (undo). */
  'inbox:restore': z.object({ worldId: id('world'), item: inboxItemSchema }),
  /** What another window's writing view shows for a story (for a torn-off AI window). */
  'ai:scope': z.object({ seriesId: id('series') }),
  'ai:scopeReply': z.object({
    requestId: z.string().min(1).max(80),
    scope: z
      .object({
        volumeId: id('volume'),
        chapterId: id('chapter').nullable(),
        chapterTitle: z.string().max(300),
        selection: z.string().max(200000).nullable(),
        screen: z.string().max(200000),
      })
      .nullable(),
  }),
  /** A story's saved AI conversations (newest first, without messages). */
  'ai:conversations': z.object({ seriesId: id('series') }),
  'ai:conversation': z.object({ seriesId: id('series'), conversationId: id('conversation') }),
  'ai:saveConversation': z.object({ seriesId: id('series'), conversation: conversationFileSchema }),
  'ai:deleteConversation': z.object({
    seriesId: id('series'),
    conversationId: id('conversation'),
  }),
  /** Signs in with ChatGPT (opens OpenAI's page; resolves when done). */
  'ai:chatgptSignIn': z.void(),
  'ai:chatgptSignOut': z.void(),
  /** Opens Cloudflare's token page, filled in with the permission sync needs. */
  'sync:openCloudflare': z.void(),
  /** Stops syncing on this computer (nothing is deleted anywhere). */
  'sync:disconnect': z.void(),
  'sync:now': z.void(),
  /** Versions set aside when both computers changed something. */
  'sync:conflicts': z.void(),
  /** Puts a set-aside version back (the one it replaces is set aside instead). */
  'sync:conflictRestore': z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }),
  'sync:conflictDelete': z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }),
  /** Brings a chapter's versions saved by other computers into its history. */
  'history:fetchCloud': z.object({ volumeId: id('volume'), chapterId: id('chapter') }),
  /** Adds imported chapters at the end of a volume, in order. */
  'import:chapters': z.object({
    seriesId: id('series'),
    volumeId: id('volume'),
    chapters: z
      .array(
        z.object({
          title: z.string().trim().max(200),
          type: chapterTypeSchema,
          content: richTextDocSchema,
        }),
      )
      .min(1)
      .max(2000),
  }),
  /** Pops a pane out into a window of its own (`atCursor`: where its tab was dropped). */
  'window:open': z.object({ route: paneRouteSchema, atCursor: z.boolean().optional() }),
  /** A torn-off window's tab was dropped outside it: docks if that was over the main window. */
  'window:dropped': z.object({ route: paneRouteSchema }),
  /**
   * Puts this torn-off window's pane back beside the main window's view, and
   * closes this window; with `keep`, just shows the route there (this window stays).
   */
  'window:dock': z.object({ route: paneRouteSchema, keep: z.boolean().optional() }),
  /** This window's pane moved (remembered so it reopens there). */
  'window:route': z.object({ route: paneRouteSchema }),
  /** Shows an entry in a torn-off window of its world, if there is one. Returns whether it did. */
  'window:showEntry': z.object({ worldId: id('world'), entryId: id('entry') }),
  /** Asks to edit a document; `take` asks whoever is editing it to save and stop. */
  'doc:claim': z.object({ key: docKeySchema, pane: z.string().min(1).max(80), take: z.boolean() }),
  'doc:release': z.object({ key: docKeySchema, pane: z.string().min(1).max(80) }),
  /** Reply to `doc:yield`: everything is saved and this pane stopped editing. */
  'doc:yielded': z.object({ key: docKeySchema, pane: z.string().min(1).max(80) }),
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
  'series:setKind': SeriesFile
  'library:size': {
    total: number
    writing: number
    images: number
    history: number
    trash: number
    other: number
  }
  'sync:usage': { bytes: number; files: number } | null
  'world:setFeatures': WorldFile
  'series:rename': SeriesFile
  'series:describe': SeriesFile
  'world:rename': WorldFile
  'arc:delete': OutlineView
  'history:list': SnapshotInfo[]
  'history:read': { info: SnapshotInfo; content: RichTextDoc }
  'history:keep': null
  'history:restore': ChapterFile
  'search:volume': SearchResult
  'search:replaceAll': { chapters: number; replacements: number }
  'spelling:languages': string[]
  'world:get': WorldView
  'world:index': WorldIndex
  'world:digest': string
  'world:pin': WorldFile
  'template:save': Template
  'template:delete': null
  'entry:create': WorldEntryFile
  'entry:read': WorldEntryFile
  'entry:save': WorldEntryFile
  'entry:appearances': Appearance[]
  'entry:text': string
  'entry:duplicate': WorldEntryFile
  'entry:merge': EntryChangeResult & { kept: WorldEntryFile }
  'entry:delete': EntryChangeResult
  'entry:portrait': WorldEntryFile
  'entry:capture': WorldEntryFile
  'inbox:get': WorldInbox
  'inbox:capture': InboxItem
  'inbox:file': WorldEntryFile
  'inbox:dismiss': InboxItem
  'names:reject': null
  'capture:context': null
  'map:create': MapFile
  'relationship:save': RelationshipFile
  'relationship:delete': RelationshipFile
  'relationship:types': RelationshipType[]
  'board:save': null
  'map:save': MapFile
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
  'window:open': null
  'export:volume': { path: string; chapters: number; skipped: string[] }
  'export:royalRoad': { title: string }
  'import:docx': { fileName: string; html: string; warnings: string[] }
  'import:chapters': { created: number }
  'sync:status': SyncStatus
  'sync:connect': { status: SyncStatus } | { confirm: { series: number; worlds: number } }
  'sync:disconnect': SyncStatus
  'sync:openCloudflare': null
  'ai:status': AiStatus
  'ai:ask': { text: string }
  'ai:editChapter': { text: string }
  'ai:cancel': null
  'ai:jobs': AiJobInfo[]
  'ai:jobSeen': null
  'ai:updateWorld': {
    summary: string
    applied: number
    suggestions: number
    continuity: number
    questions: number
  }
  'ai:summaries': ChapterSummaryInfo[]
  'inbox:accept': { item: InboxItem; entryId: string | null; relationshipId: string | null }
  'inbox:answer': null
  'inbox:undo': InboxItem
  'voice:status': { studio: boolean; voices: { id: string; name: string }[]; url: string }
  'voice:speak': Uint8Array
  'voice:transcribe': string
  'voice:chapterSpeakers': { narrator: string | null; lines: Record<string, string> }
  'voice:setCast': null
  'voice:lines': {
    narrator: string | null
    lines: { key: string; text: string; before: string; speaker: string | null; fixed: boolean }[]
  }
  'voice:fixLine': null
  'voice:cast': { narrator: string; other: string; characters: Record<string, string> }
  'voice:script': { saved: string | null; chapters: number; lines: number }
  'ai:sortNames': { applied: number; suggestions: number; skipped: number }
  'inbox:restore': null
  'ai:scope': {
    volumeId: string
    chapterId: string | null
    chapterTitle: string
    selection: string | null
    screen: string
  } | null
  'ai:scopeReply': null
  'ai:conversations': ConversationSummary[]
  'ai:conversation': ConversationFile
  'ai:saveConversation': null
  'ai:deleteConversation': null
  'ai:chatgptSignIn': null
  'ai:chatgptSignOut': null
  'sync:now': SyncStatus
  'sync:conflicts': ConflictInfo[]
  'sync:conflictRestore': null
  'sync:conflictDelete': null
  'history:fetchCloud': { added: number }
  'window:dropped': boolean
  'window:dock': null
  'window:route': null
  'window:showEntry': boolean
  'doc:claim': { editing: boolean }
  'doc:release': null
  'doc:yielded': null
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
  /** "Add to world" was chosen on selected text (from the right-click menu). */
  'text:quickAdd': string
  /** Something was captured from the right-click menu (a short confirmation to show). */
  'text:captured': string
  'settings:changed': AppSettings
  /** A short message from main to show as a notice (e.g. "Screenshot copied"). */
  'app:notice': string
  /** The window is about to close: save everything, then invoke `window:flushed`. */
  'window:flush': null
  /** A torn-off pane was docked back: open it beside the current view. */
  'pane:dock': PaneRoute
  /** Show this entry (in this torn-off world window). */
  'pane:showEntry': { worldId: string; entryId: string }
  /** Another place wants to edit this document: save, stop editing, invoke `doc:yielded`. */
  'doc:yield': { key: string; pane: string }
  /** Sync has written the other computer's version: reload this document and carry on editing. */
  'doc:returned': { key: string; pane: string }
  'sync:status': SyncStatus
  /** Sync is replacing (held) or has replaced a world's map, board or templates. */
  'sync:hold': { worldId: string; held: boolean }
  /** Another window asks what this one's writing view shows (reply with `ai:scopeReply`). */
  'ai:scopeRequest': { requestId: string; seriesId: string }
  /** What a long AI job is doing now ("Reading part 2 of 3…"). */
  'ai:progress': { requestId: string; text: string }
  /** AI work started, finished, failed or stopped (to every window). */
  'ai:job': AiJobInfo
  /** AI work this window asked for is finished (to that window only). */
  'ai:jobDone': AiJobInfo
  /** More of an AI answer. */
  'ai:token': { requestId: string; text: string }
}

/** A saved AI conversation in lists. */
export interface ConversationSummary {
  id: string
  mode: ConversationFile['mode']
  title: string
  createdAt: string
  updatedAt: string
  /** How many messages. */
  count: number
}

export interface AiStatus {
  enabled: boolean
  provider: 'ollama' | 'chatgpt'
  /** Signed in to ChatGPT as… (ChatGPT only). */
  account: { email: string | null; plan: string | null } | null
  host: string
  reachable: boolean
  models: string[]
  /** The model in use (the chosen one, or the first installed). */
  model: string | null
  error: string | null
}

/** Sync as the status bar and settings show it. */
export interface SyncStatus {
  connected: boolean
  state: 'off' | 'idle' | 'syncing' | 'offline' | 'error'
  /** Files changed here that the cloud doesn't have yet. */
  pending: number
  lastSyncedAt: string | null
  /** Why it's offline or failing. */
  message: string | null
  device: string
  /** Where it syncs to (bucket name), when connected. */
  bucket: string | null
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
