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
  notes: z.string(),
  content: richTextDocSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type ChapterFile = z.infer<typeof chapterFileSchema>

/* ---------- world ---------- */

export const categorySectionSchema = z.looseObject({
  id: id('section'),
  name: nameSchema,
})

export const worldCategorySchema = z.looseObject({
  id: id('category'),
  name: nameSchema,
  sections: z.array(categorySectionSchema),
})
export type WorldCategory = z.infer<typeof worldCategorySchema>

export const worldFileSchema = z.looseObject({
  formatVersion,
  id: id('world'),
  name: nameSchema,
  categories: z.array(worldCategorySchema),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type WorldFile = z.infer<typeof worldFileSchema>

export const entrySectionSchema = z.looseObject({
  id: id('section'),
  title: z.string().trim().max(200),
  content: richTextDocSchema,
})

export const worldEntryFileSchema = z.looseObject({
  formatVersion,
  id: id('entry'),
  worldId: id('world'),
  categoryId: id('category').nullable(),
  name: nameSchema,
  aliases: z.array(z.string().trim().min(1)),
  sections: z.array(entrySectionSchema),
  createdAt: timestamp,
  updatedAt: timestamp,
})
export type WorldEntryFile = z.infer<typeof worldEntryFileSchema>

export const timelineFileSchema = z.looseObject({
  formatVersion,
  worldId: id('world'),
  events: z.array(
    z.looseObject({
      id: id('event'),
      title: z.string().trim().max(200),
      date: z.string().nullable(),
      entryIds: z.array(id('entry')),
      chapterIds: z.array(id('chapter')),
    }),
  ),
})
export type TimelineFile = z.infer<typeof timelineFileSchema>

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
