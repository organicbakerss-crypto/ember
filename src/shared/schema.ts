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
import { roundtableSessionSchema } from './ai/roundtable'

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
  /**
   * `book`: a single book, shown and opened as one (its one volume holds the
   * chapters). Adding a second volume makes it a series.
   */
  kind: z.enum(['series', 'book']).catch('series'),
  volumeOrder: z.array(id('volume')),
  /** A short description of the story (the blurb, for the writer's own use). */
  description: z.string().max(10000).optional().catch(undefined),
  /** Voices for reading aloud: VoiceStudio voice names for the narrator, others, and by character name. */
  voices: z
    .looseObject({
      narrator: z.string().max(200).catch(''),
      other: z.string().max(200).catch(''),
      characters: z.record(z.string().max(200), z.string().max(200)).catch({}),
    })
    .optional()
    .catch(undefined),
  /** Optional modules this story uses (off unless turned on; no trace of them when off). */
  modules: z
    .looseObject({
      publishing: z.boolean().catch(false).default(false),
      authorNotes: z.boolean().catch(false).default(false),
    })
    .optional()
    .catch(undefined),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type SeriesFile = z.infer<typeof seriesFileSchema>

/** Where a chapter is in being published (the publishing module). */
export const publishSchema = z.looseObject({
  status: z.enum(['posted', 'scheduled']),
  /** The day it was posted or is scheduled for (YYYY-MM-DD; '' if not set). */
  date: z.string().max(40).catch(''),
  /** Where it's posted. */
  url: z.string().max(2000).catch(''),
})
export type PublishInfo = z.infer<typeof publishSchema>

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
  /**
   * Test scenes: chapter files kept with a chapter (`chapterId`, null once
   * it's gone) instead of in the reading order. Not in the manuscript, Book
   * mode or exports; counted in words and read by the world and the AI.
   */
  tests: z
    .array(z.looseObject({ id: id('chapter'), chapterId: id('chapter').nullable() }))
    .catch([])
    .default([]),
})
export type OutlineFile = z.infer<typeof outlineFileSchema>

/* ---------- chapter ---------- */

export const chapterTypeSchema = z.enum(['chapter', 'interlude'])
export type ChapterType = z.infer<typeof chapterTypeSchema>

/** Where a chapter is: being written, revised, or finished. */
export const CHAPTER_STATUSES = ['draft', 'revised', 'done'] as const
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number]
/** Colour labels a writer can give chapters (their meaning is the writer's). */
export const CHAPTER_LABELS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const
export type ChapterLabel = (typeof CHAPTER_LABELS)[number]

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
  /** All the chapter's points of view (the first is also `pov`); empty: just `pov`, if any. */
  povs: z
    .array(
      z.looseObject({
        name: z.string().trim().min(1).max(200),
        entryId: id('entry').nullable().catch(null).default(null),
      }),
    )
    .max(20)
    .catch([])
    .default([]),
  notes: z.string(),
  /** A short summary of the chapter, by the writer (or filled in by the AI when asked). */
  synopsis: z.string().max(5000).default(''),
  /** Unknown values (from a newer app) read as none rather than failing the chapter. */
  status: z.enum(CHAPTER_STATUSES).nullable().catch(null).default(null),
  label: z.enum(CHAPTER_LABELS).nullable().catch(null).default(null),
  /** Royal Road-style author's notes, shown to readers before and after the chapter. */
  authorNoteBefore: z.string().max(20000).catch('').default(''),
  authorNoteAfter: z.string().max(20000).catch('').default(''),
  /** Posted or scheduled (the publishing module); null: not yet. */
  publish: publishSchema.nullable().catch(null).default(null),
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
  /** Parts of World mode this world uses. Off: no trace of them in its views. */
  features: z
    .looseObject({
      map: z.boolean().catch(true),
      board: z.boolean().catch(true),
      timeline: z.boolean().catch(true),
    })
    .catch({ map: true, board: true, timeline: true }),
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

/** A picture kept with an entry (stored once in the world's images, by its hash). */
export const pictureSchema = z.looseObject({
  file: z.string().regex(/^[0-9a-f]{64}\.(png|jpg|gif|webp)$/),
  caption: z.string().max(500).catch('').default(''),
})
export type Picture = z.infer<typeof pictureSchema>

/** A tag on an entry: short, as the writer typed it. */
export const tagSchema = z.string().trim().min(1).max(60)

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
  /** The writer's own labels ("noble houses", "dead", "book 2"). */
  tags: z.array(tagSchema).catch([]).default([]),
  /** More pictures than the portrait: outfits, house plans, reference art. */
  gallery: z.array(pictureSchema).catch([]).default([]),
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

/**
 * A change the AI suggests for the world, already checked against it (names
 * resolved to entries, fields to the entry's template). Nothing changes until
 * the writer accepts it in the inbox.
 */
export const suggestionSchema = z.discriminatedUnion('type', [
  /** Someone or something new: added as an entry. */
  z.looseObject({
    type: z.literal('new'),
    name: nameSchema,
    template: z.string().min(1).max(60),
    about: z.string().max(1000).default(''),
  }),
  /** A fact about an entry, from this chapter on. */
  z.looseObject({
    type: z.literal('fact'),
    entryId: id('entry'),
    field: fieldIdSchema,
    text: z.string().max(1000).optional(),
    link: id('entry').optional(),
  }),
  /** Two entries connected, from this chapter on. */
  z.looseObject({
    type: z.literal('relationship'),
    from: id('entry'),
    to: id('entry'),
    relType: z.string().min(1).max(60),
    label: z.string().max(80).default(''),
  }),
])
export type Suggestion = z.infer<typeof suggestionSchema>

export const inboxItemSchema = z.looseObject({
  id: id('inbox'),
  /** What it says, in words ("Mara: Where now → Port Kell"). */
  text: z.string().min(1).max(5000),
  source: chapterSourceSchema,
  capturedAt: timestamp,
  /**
   * captured: a line the writer saved. From reading a chapter with the AI:
   * suggestion (a change to accept), continuity (something that may not fit
   * the world), question (something only the writer can answer).
   */
  kind: z
    .enum(['captured', 'suggestion', 'applied', 'continuity', 'question'])
    .catch('captured')
    .default('captured'),
  /** The line in the chapter it comes from. */
  quote: z.string().max(2000).nullable().catch(null).default(null),
  /** The entry it's about, when there is one. */
  entryId: id('entry').nullable().catch(null).default(null),
  suggestion: suggestionSchema.optional().catch(undefined),
  /** A change the AI made itself (`applied`): exactly what to take back out to undo it. */
  undo: z
    .looseObject({
      /** An entry it made (goes to the trash). */
      created: id('entry').optional(),
      /** A fact value it added. */
      fact: z
        .looseObject({ entryId: id('entry'), field: fieldIdSchema, factId: id('fact') })
        .optional(),
      /** The line it kept as a quote. */
      quote: z.looseObject({ entryId: id('entry'), quoteId: id('quote') }).optional(),
      relationshipId: id('relationship').optional(),
    })
    .optional()
    .catch(undefined),
})
export type InboxItem = z.infer<typeof inboxItemSchema>

/** One captured sentence not yet filed under an entry: `inbox/<id>.json`. */
export const inboxItemFileSchema = inboxItemSchema.extend({
  formatVersion,
  worldId: id('world'),
})

/**
 * The old single inbox file (`inbox.json`), still read: its items move to
 * their own files the first time the inbox changes.
 */
export const inboxFileSchema = z.looseObject({
  formatVersion,
  worldId: id('world'),
  items: z.array(inboxItemSchema),
})
export type InboxFile = z.infer<typeof inboxFileSchema>

/** The writer's answer to a question the AI asked: never asked again, and told to the AI. */
export const answerFileSchema = z.looseObject({
  formatVersion,
  id: id('answer'),
  worldId: id('world'),
  question: z.string().min(1).max(2000),
  answer: z.string().min(1).max(5000),
  source: chapterSourceSchema.nullable().catch(null).default(null),
  answeredAt: timestamp,
})
export type AnswerFile = z.infer<typeof answerFileSchema>

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

/* ---------- chapter summaries (made by the AI, kept with the volume) ---------- */

export const chapterSummaryFileSchema = z.looseObject({
  formatVersion,
  chapterId: id('chapter'),
  text: z.string().min(1).max(5000),
  /** The chapter's text it was made from (sha256): a different one means it's out of date. */
  textHash: z.string(),
  createdAt: timestamp,
})
export type ChapterSummaryFile = z.infer<typeof chapterSummaryFileSchema>

/* ---------- who says what (made by the AI, kept with the volume) ---------- */

const speakerSchema = z.looseObject({
  /** The world entry, when the speaker is one. */
  entryId: id('entry').nullable().catch(null).default(null),
  /** The name to use (the script's voice tag); '' when unknown. */
  name: z.string().max(200).catch(''),
})
export type Speaker = z.infer<typeof speakerSchema>

export const chapterSpeakersFileSchema = z.looseObject({
  formatVersion,
  chapterId: id('chapter'),
  /** The chapter text this was made from (sha256). */
  textHash: z.string(),
  /** Who tells the chapter: a first-person narrator, or nobody (a plain narrator). */
  narrator: speakerSchema.nullable().catch(null).default(null),
  /** Who says each line of dialogue, by the line's key (its first words). */
  lines: z.record(z.string(), speakerSchema).catch({}).default({}),
  /** The writer's own fixes, by line key: they win over the AI's, and survive re-marking. */
  fixed: z.record(z.string(), speakerSchema).catch({}).default({}),
  createdAt: timestamp,
})
export type ChapterSpeakersFile = z.infer<typeof chapterSpeakersFileSchema>

/* ---------- AI conversations (kept with their story) ---------- */

export const conversationMessageSchema = z.looseObject({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  at: timestamp,
  /** What the AI read with this message, in words ("your selection in “Arrival”, ~40 words"). */
  read: z.string().nullable().catch(null).default(null),
})
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

export const conversationFileSchema = z.looseObject({
  formatVersion,
  id: id('conversation'),
  mode: z.enum(['chat', 'brainstorm', 'ask']),
  /** The character the conversation is with (an unknown or old one reads as the default). */
  characterId: z.string().min(1).max(80).optional().catch(undefined),
  /** Structured Roundtable session, saved and synced alongside other AI conversations. */
  roundtable: roundtableSessionSchema.optional(),
  /** Brought in from a ChatGPT share link: read-only, looked through when the AI answers. */
  source: z
    .looseObject({
      kind: z.literal('chatgpt-share'),
      shareId: z.string().min(1).max(80),
      url: z.string().max(500),
      importedAt: timestamp,
    })
    .optional()
    .catch(undefined),
  title: z.string().max(200),
  createdAt: timestamp,
  updatedAt: timestamp,
  messages: z.array(conversationMessageSchema),
})
export type ConversationFile = z.infer<typeof conversationFileSchema>

/* ---------- AI characters from the story (one file each, in the world) ---------- */

/** One thing an adaptive story character picked up from a chapter. */
export const learnedNoteSchema = z.looseObject({
  text: z.string().trim().min(1).max(600),
  /** The chapter it came from: only used when the reader is at or past it. */
  chapterId: id('chapter').nullable(),
  at: timestamp,
})

export const aiCharacterFileSchema = z.looseObject({
  formatVersion,
  id: id('character'),
  worldId: id('world'),
  /** The world entry this character is (Sara's entry), if any. */
  entryId: id('entry').nullable().catch(null).default(null),
  name: z.string().trim().min(1).max(200),
  /** The filled-in template, as plain labelled text the writer can edit. */
  card: z.string().max(20000),
  // One bad note is dropped on its own, never the whole list.
  learned: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((notes) =>
      notes
        .map((n) => learnedNoteSchema.safeParse(n))
        .flatMap((r) => (r.success ? [r.data] : []))
        .slice(-300),
    ),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type AiCharacterFile = z.infer<typeof aiCharacterFileSchema>

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
