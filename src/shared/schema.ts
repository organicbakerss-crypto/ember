/**
 * The on-disk library format.
 *
 * Every file is plain JSON, readable without the app. Each one carries a
 * `formatVersion` so later milestones can migrate files instead of guessing.
 * Objects are "loose": fields this version doesn't know about are kept and
 * written back unchanged, so an older build never strips newer data.
 */
import { z } from 'zod'
import { idPattern, type IdKind } from './ids'
import { LENSES } from './world/lenses'

export const FORMAT_VERSION = 1

export const id = (kind: IdKind) => z.string().regex(idPattern(kind), `Invalid ${kind} id`)
const timestamp = z.iso.datetime()
const formatVersion = z.number().int().positive()

export const nameSchema = z
  .string()
  .trim()
  .min(1, 'Name cannot be empty')
  .max(200, 'Name is too long')

/** TipTap / ProseMirror document JSON. Only the outer shape is checked. */
export const richTextDocSchema = z.looseObject({
  type: z.literal('doc'),
  content: z.array(z.unknown()).optional(),
})
export type RichTextDoc = z.infer<typeof richTextDocSchema>

export const emptyDoc = (): RichTextDoc => ({ type: 'doc', content: [] })

/* ---------- library root ---------- */

export const libraryFileSchema = z.looseObject({
  formatVersion,
  id: id('library'),
  createdAt: timestamp,
})
export type LibraryFile = z.infer<typeof libraryFileSchema>

/* ---------- series ---------- */

export const seriesFileSchema = z.looseObject({
  formatVersion,
  id: id('series'),
  name: nameSchema,
  worldId: id('world').nullable(),
  volumeOrder: z.array(id('volume')),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type SeriesFile = z.infer<typeof seriesFileSchema>

/* ---------- volume ---------- */

export const volumeGoalsSchema = z.looseObject({
  projectWords: z.number().int().positive().nullable(),
  sessionWords: z.number().int().positive().nullable(),
})

export const volumeFileSchema = z.looseObject({
  formatVersion,
  id: id('volume'),
  seriesId: id('series'),
  name: nameSchema,
  settings: z.record(z.string(), z.unknown()),
  goals: volumeGoalsSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type VolumeFile = z.infer<typeof volumeFileSchema>

/* ---------- outline: arcs and chapter order ---------- */

export const outlineArcSchema = z.looseObject({
  type: z.literal('arc'),
  id: id('arc'),
  name: nameSchema,
  finished: z.boolean(),
  chapterIds: z.array(id('chapter')),
})
export type OutlineArc = z.infer<typeof outlineArcSchema>

export const outlineChapterRefSchema = z.looseObject({
  type: z.literal('chapter'),
  id: id('chapter'),
})
export type OutlineChapterRef = z.infer<typeof outlineChapterRefSchema>

export const outlineItemSchema = z.discriminatedUnion('type', [
  outlineArcSchema,
  outlineChapterRefSchema,
])
export type OutlineItem = z.infer<typeof outlineItemSchema>

/** The only file a reorder touches. Top level holds arcs and loose chapters, in order. */
export const outlineFileSchema = z.looseObject({
  formatVersion,
  volumeId: id('volume'),
  items: z.array(outlineItemSchema),
})
export type OutlineFile = z.infer<typeof outlineFileSchema>

/* ---------- chapter ---------- */

export const chapterTypeSchema = z.enum(['chapter', 'interlude'])
export type ChapterType = z.infer<typeof chapterTypeSchema>

export const chapterFileSchema = z.looseObject({
  formatVersion,
  id: id('chapter'),
  volumeId: id('volume'),
  title: z.string().trim().max(200),
  type: chapterTypeSchema,
  /** Optional POV tag. Becomes a world entry link in the World milestone. */
  pov: z.string().trim().max(200).nullable(),
  /** The world entry the POV refers to, when it is one (so renaming the character keeps the link). */
  povEntryId: id('entry').nullable().optional(),
  notes: z.string(),
  content: richTextDocSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type ChapterFile = z.infer<typeof chapterFileSchema>

/* ---------- world ---------- */

export const worldFileSchema = z.looseObject({
  formatVersion,
  id: id('world'),
  name: nameSchema,
  /** Entries pinned to the top of World mode. */
  pinned: z.array(id('entry')).default([]),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type WorldFile = z.infer<typeof worldFileSchema>

/** Field ids are keys in entry files: short and plain. */
export const fieldIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,59}$/, 'Invalid field id')

/** When a fact starts to be true: from a chapter, or from an event (an entry). */
export const factAnchorSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('chapter'), chapterId: id('chapter') }),
  z.looseObject({ kind: z.literal('event'), entryId: id('entry') }),
])
export type FactAnchor = z.infer<typeof factAnchorSchema>

/** One value of a fact: text, or a link to another entry. `from: null` means "from the start". */
export const factValueSchema = z.looseObject({
  id: id('fact'),
  text: z.string().max(5000).optional(),
  link: id('entry').optional(),
  from: factAnchorSchema.nullable().default(null),
})
export type FactValue = z.infer<typeof factValueSchema>

/** Where a captured quote came from. */
export const chapterSourceSchema = z.looseObject({
  seriesId: id('series'),
  volumeId: id('volume'),
  chapterId: id('chapter'),
  chapterTitle: z.string().max(200),
})
export type ChapterSource = z.infer<typeof chapterSourceSchema>

/** A sentence saved from the manuscript ("one-click capture"), filed under a field or the notes. */
export const quoteSchema = z.looseObject({
  id: id('quote'),
  field: fieldIdSchema.nullable(),
  text: z.string().min(1).max(5000),
  source: chapterSourceSchema,
  capturedAt: timestamp,
})
export type Quote = z.infer<typeof quoteSchema>

/**
 * Where an era or event sits on the timeline: in the world's history before
 * the story (ordered by `order`, smaller first), or during a chapter.
 */
export const timelinePlaceSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('history'), order: z.number() }),
  z.looseObject({ kind: z.literal('chapter'), chapterId: id('chapter') }),
])
export type TimelinePlace = z.infer<typeof timelinePlaceSchema>

/** Portrait images are stored once per world, named by content hash. Crop is in fractions of the image. */
export const portraitSchema = z.looseObject({
  file: z.string().regex(/^[0-9a-f]{64}\.(png|jpg|gif|webp)$/),
  crop: z.looseObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    size: z.number().min(0.05).max(1),
  }),
})
export type Portrait = z.infer<typeof portraitSchema>

export const worldEntryFileSchema = z.looseObject({
  formatVersion,
  id: id('entry'),
  worldId: id('world'),
  /** Template id (built in, like `person`, or one saved in the world's templates file). */
  template: z.string().min(1).max(60),
  name: nameSchema,
  aliases: z.array(z.string().trim().min(1)),
  /** Field id → values over time (oldest first). Fields not in the template are kept. */
  facts: z.record(fieldIdSchema, z.array(factValueSchema)).default({}),
  /** The free-written page. */
  body: richTextDocSchema,
  quotes: z.array(quoteSchema).default([]),
  portrait: portraitSchema.nullable().default(null),
  /** Entries merged into this one; links and POV tags to them now mean this entry. */
  mergedFrom: z.array(id('entry')).default([]),
  /** For eras and events: their place on the timeline (null: not placed yet). */
  when: timelinePlaceSchema.nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type WorldEntryFile = z.infer<typeof worldEntryFileSchema>

export { LENSES }
export const lensSchema = z.enum(LENSES)

export const templateFieldSchema = z.looseObject({
  id: fieldIdSchema,
  label: z.string().trim().min(1).max(60),
  kind: z.enum(['text', 'link']),
  /** Shown in the quick facts strip and hover cards. */
  quick: z.boolean().default(false),
  /** Holds several values at once (members, territory), not one value that changes. */
  multiple: z.boolean().default(false),
  /** How the linked entry lists this link ("Inside it", "Members"). */
  reverse: z.string().trim().max(60).optional(),
})
export type TemplateField = z.infer<typeof templateFieldSchema>

export const templateSchema = z.looseObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
  name: z.string().trim().min(1).max(60),
  lens: lensSchema,
  fields: z.array(templateFieldSchema).max(40),
})
export type Template = z.infer<typeof templateSchema>

/** Templates customised for one world (same id as a built-in one replaces it). */
export const templatesFileSchema = z.looseObject({
  formatVersion,
  worldId: id('world'),
  templates: z.array(templateSchema),
})
export type TemplatesFile = z.infer<typeof templatesFileSchema>

/** Captured sentences not yet filed under an entry. */
export const inboxFileSchema = z.looseObject({
  formatVersion,
  worldId: id('world'),
  items: z.array(
    z.looseObject({
      id: id('inbox'),
      text: z.string().min(1).max(5000),
      source: chapterSourceSchema,
      capturedAt: timestamp,
    }),
  ),
})
export type InboxFile = z.infer<typeof inboxFileSchema>
export type InboxItem = InboxFile['items'][number]

/** Suggestions the writer turned down; they never come back. */
export const rejectedFileSchema = z.looseObject({
  formatVersion,
  worldId: id('world'),
  names: z.array(z.string().max(200)),
})
export type RejectedFile = z.infer<typeof rejectedFileSchema>

/* ---------- relationships (the people board) ---------- */

export const relationshipTypeIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)

/**
 * One relationship between two entries, in its own small file. The reverse
 * side is worked out, never stored twice, so links added on two devices
 * never conflict.
 */
export const relationshipFileSchema = z.looseObject({
  formatVersion,
  id: id('relationship'),
  worldId: id('world'),
  from: id('entry'),
  to: id('entry'),
  type: relationshipTypeIdSchema,
  /** Words for it, read from → to ("sister of", "mentor to"). Optional. */
  label: z.string().trim().max(80).default(''),
  /** For family: `from` is `to`'s parent, they are siblings, or partners (for the family tree). */
  kin: z.enum(['parent', 'sibling', 'partner']).nullable().default(null),
  /** Over (shown dashed), whether or not an end is known. */
  over: z.boolean().default(false),
  start: factAnchorSchema.nullable().default(null),
  end: factAnchorSchema.nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type RelationshipFile = z.infer<typeof relationshipFileSchema>

export const relationshipTypeSchema = z.looseObject({
  id: relationshipTypeIdSchema,
  label: z.string().trim().min(1).max(40),
  colour: z.string().regex(/^#[0-9a-f]{6}$/i),
})
export type RelationshipType = z.infer<typeof relationshipTypeSchema>

/** A world's own relationship types (same id as a built-in one replaces it). */
export const relationshipTypesFileSchema = z.looseObject({
  formatVersion,
  worldId: id('world'),
  types: z.array(relationshipTypeSchema),
})

/** Where portraits sit on the board: layout, kept apart from the people themselves. */
export const boardFileSchema = z.looseObject({
  formatVersion,
  worldId: id('world'),
  positions: z.record(
    id('entry'),
    z.looseObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  ),
  updatedAt: timestamp,
})
export type BoardFile = z.infer<typeof boardFileSchema>

/* ---------- maps ---------- */

/** A point in image pixels. */
export const pointSchema = z.tuple([z.number(), z.number()])
export type Point = z.infer<typeof pointSchema>

/** A region of a map: a vector outline (in image pixels), separate from the image itself. */
export const regionSchema = z.looseObject({
  id: id('region'),
  /** The outline first; any further rings are holes (a lake inside a kingdom). */
  rings: z.array(z.array(pointSchema).min(3)).min(1),
  /** The place this region is. */
  placeId: id('entry').nullable().default(null),
})
export type MapRegion = z.infer<typeof regionSchema>

/** A place marked at one point of a map (a city, a landmark), in image pixels. */
export const pinSchema = z.looseObject({
  id: id('pin'),
  placeId: id('entry'),
  x: z.number(),
  y: z.number(),
})
export type MapPin = z.infer<typeof pinSchema>

/** A travel sketch: places as dots (positions from 0 to 1) joined by roads. */
export const sketchSchema = z.looseObject({
  nodes: z.array(
    z.looseObject({
      placeId: id('entry'),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    }),
  ),
  roads: z.array(z.looseObject({ from: id('entry'), to: id('entry') })),
})
export type Sketch = z.infer<typeof sketchSchema>

export const mapFileSchema = z.looseObject({
  formatVersion,
  id: id('map'),
  worldId: id('world'),
  name: nameSchema,
  /** The place this map shows (a kingdom's own map); null for the world map. */
  placeId: id('entry').nullable(),
  /** The map image, stored once in the world's images folder (named by content hash). */
  image: z
    .looseObject({
      file: z.string().regex(/^[0-9a-f]{64}\.(png|jpg|gif|webp)$/),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .nullable(),
  regions: z.array(regionSchema).default([]),
  pins: z.array(pinSchema).default([]),
  /** Without an image: the travel sketch. */
  sketch: sketchSchema.nullable().default(null),
  /**
   * A later version of another map (a coastline drowns, borders shift): it
   * replaces that map from `from` (usually an event) onwards. Places keep
   * their identity across versions.
   */
  versionOf: id('map').nullable().default(null),
  from: factAnchorSchema.nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type MapFile = z.infer<typeof mapFileSchema>

/* ---------- manifest (per sync unit: a volume or a world) ---------- */

export const manifestFileEntrySchema = z.looseObject({
  /** SHA-256 of the file's bytes, hex. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  modifiedAt: timestamp,
})
export type ManifestFileEntry = z.infer<typeof manifestFileEntrySchema>

export const manifestFileSchema = z.looseObject({
  formatVersion,
  unitType: z.enum(['volume', 'world']),
  unitId: z.string(),
  /** Keyed by path relative to the unit folder, always with forward slashes. */
  files: z.record(z.string(), manifestFileEntrySchema),
})
export type ManifestFile = z.infer<typeof manifestFileSchema>
