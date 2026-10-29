/**
 * The world inside a library: entries (one small file each), templates, the
 * inbox and the list of rejected suggestions, plus derived data rebuilt
 * locally from the manuscript (mentions, appearances, the digest).
 *
 * Every write goes through the world's lock and the unit manifest. The world
 * only reads chapters; it never changes the manuscript.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import {
  FORMAT_VERSION,
  emptyDoc,
  boardFileSchema,
  inboxFileSchema,
  relationshipFileSchema,
  relationshipTypesFileSchema,
  mapFileSchema,
  rejectedFileSchema,
  templatesFileSchema,
  worldEntryFileSchema,
  type ChapterSource,
  type FactValue,
  type InboxFile,
  type BoardFile,
  type InboxItem,
  type RelationshipFile,
  type RelationshipType,
  type MapFile,
  type RichTextDoc,
  type Template,
  type TemplateField,
  type WorldEntryFile,
  type WorldFile,
} from '@shared/schema'
import { newId } from '@shared/ids'
import type { FactAnchor } from '@shared/schema'
import type {
  Appearance,
  EntryChangeResult,
  EntrySummary,
  LibraryChange,
  LibraryProblem,
  TrashEntry,
  TrashTarget,
  WorldInbox,
  WorldView,
} from '@shared/ipc'
import { detectImageType, WORLD_IMAGE } from '@shared/media'
import { entryTerms, nameMatcher } from '@shared/names'
import { docParagraphs } from '@shared/analysis/doc'
import { splitSentences } from '@shared/analysis/sentences'
import { DEFAULT_FILLER_WORDS } from '@shared/analysis/fillers'
import { catchNames } from '@shared/world/nameCatcher'
import { entryText, worldDigest } from '@shared/world/digest'
import { type StoryChapter, type WorldIndex } from '@shared/world/story'
import { isBuiltIn, worldTemplates } from '@shared/world/templates'
import { baseMaps, mapsNow, nearbyPlaces } from '@shared/world/maps'
import { anchorPosition, type ChapterPositions } from '@shared/world/facts'
import { buildTimeline, timelinePositions } from '@shared/world/timeline'
import { relationshipText, relationshipTypes } from '@shared/world/relationships'
import { AppError } from '../errors'
import { isTempFileName } from '../fs/atomicWrite'
import type { KeyedLock } from '../fs/keyedLock'
import { pathExists, readJsonFile, sha256 } from '../fs/jsonFile'
import type { LibraryPaths } from './paths'
import { unitPaths } from './paths'

/** A chapter of the story as the world sees it: reading order, text and POV. */
export interface StoryText {
  chapter: StoryChapter
  paragraphs: string[]
  povEntryId: string | null
}

/** What the world store needs from the library. */
export interface WorldHost {
  paths: LibraryPaths
  lock: KeyedLock
  timestamp(): string
  changed(change: LibraryChange): void
  getWorld(worldId: string): Promise<WorldFile>
  /** Writes a JSON file in the world (call while holding its lock). */
  writeFile(worldId: string, rel: string, value: unknown): Promise<void>
  /** Writes raw bytes in the world (call while holding its lock). */
  writeBytes(worldId: string, rel: string, bytes: Uint8Array): Promise<void>
  /** Deletes a file in the world (call while holding its lock). */
  removeFile(worldId: string, rel: string): Promise<void>
  /** Chapters of every series using this world, in reading order. */
  story(worldId: string): Promise<StoryText[]>
  moveToTrash(target: TrashTarget): Promise<TrashEntry>
}

/** A relationship as the app sends it (an id only when it already exists, or is being restored). */
export interface RelationshipInput {
  id?: string
  from: string
  to: string
  type: string
  label: string
  kin: RelationshipFile['kin']
  over: boolean
  start: RelationshipFile['start']
  end: RelationshipFile['end']
  createdAt?: string
}

export type EntryPatch = Partial<
  Pick<
    WorldEntryFile,
    | 'name'
    | 'aliases'
    | 'template'
    | 'facts'
    | 'body'
    | 'quotes'
    | 'portrait'
    | 'mergedFrom'
    | 'when'
  >
>

export type TemplateInput = {
  id?: string
  name: string
  lens: Template['lens']
  fields: {
    id?: string
    label: string
    kind: TemplateField['kind']
    quick: boolean
    multiple: boolean
    reverse?: string
  }[]
}

const SNIPPET_LENGTH = 160
const LINES_PER_CHAPTER = 3
const LINE_LENGTH = 240

export class WorldStore {
  /** Story text per world, dropped whenever the manuscript changes. */
  private readonly storyCache = new Map<string, Promise<StoryText[]>>()
  private nearbyCache: { key: string; nearby: Record<string, string[]> } | null = null
  /** Mentions per world, dropped whenever the manuscript or the entries change. */
  private readonly indexCache = new Map<string, Promise<WorldIndex>>()

  constructor(private readonly host: WorldHost) {}

  /** Forgets derived data that a change makes stale. */
  invalidate(change: LibraryChange): void {
    if (change.kind === 'inbox' || change.kind === 'trash') return
    if (change.kind !== 'entry' && change.kind !== 'world') this.storyCache.clear()
    this.indexCache.clear()
  }

  private dir(worldId: string): string {
    return this.host.paths.worldDir(worldId)
  }

  private entryPath(worldId: string, entryId: string): string {
    return join(this.dir(worldId), unitPaths.entry(entryId))
  }

  /* ---------- reading ---------- */

  async view(worldId: string): Promise<WorldView> {
    const world = await this.host.getWorld(worldId)
    const { entries, problems } = await this.readAll(worldId)
    const custom = await this.customTemplates(worldId)
    const inbox = await this.readInbox(worldId)
    const { maps, problems: mapProblems } = await this.readMaps(worldId)
    const { relationships, problems: relProblems } = await this.readRelationships(worldId)
    // Names typed on a page link to their entries, like `@` links do.
    const matcher = nameMatcher(entryTerms(entries))
    const summaries = entries.map((entry) => {
      const summary = toSummary(entry)
      const named = docParagraphs(entry.body).flatMap((p) => matcher.find(p).map((m) => m.entryId))
      summary.links = [...new Set([...summary.links, ...named])].filter((id) => id !== entry.id)
      return summary
    })
    return {
      world,
      templates: worldTemplates(custom),
      customTemplates: custom.map((t) => t.id),
      entries: summaries.sort(byName),
      problems: [...problems, ...mapProblems, ...relProblems],
      inboxCount: inbox.items.length,
      maps,
      nearby: this.nearbyFor(maps, buildTimeline(entries, []).positions),
      relationships,
      relationshipTypes: relationshipTypes(await this.customRelationshipTypes(worldId)),
      board: (await this.readBoard(worldId)).positions,
    }
  }

  async readEntry(worldId: string, entryId: string): Promise<WorldEntryFile> {
    return readJsonFile(this.entryPath(worldId, entryId), worldEntryFileSchema)
  }

  /** Every readable entry; unreadable files are reported and left alone. */
  private async readAll(
    worldId: string,
  ): Promise<{ entries: WorldEntryFile[]; problems: LibraryProblem[] }> {
    const entries: WorldEntryFile[] = []
    const problems: LibraryProblem[] = []
    for (const entryId of await this.entryIdsOnDisk(worldId)) {
      try {
        entries.push(await this.readEntry(worldId, entryId))
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        const rel = `worlds/${worldId}/${unitPaths.entry(entryId)}`
        problems.push({ path: rel, message: err.message.replace(/\/.*\/entries\//, 'entries/') })
      }
    }
    return { entries, problems }
  }

  private async entryIdsOnDisk(worldId: string): Promise<string[]> {
    let names: string[]
    try {
      names = await fs.promises.readdir(join(this.dir(worldId), 'entries'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return names
      .filter((n) => n.endsWith('.json') && !isTempFileName(n))
      .map((n) => n.slice(0, -'.json'.length))
      .sort()
  }

  /* ---------- entries ---------- */

  async createEntry(
    worldId: string,
    input: { name: string; template: string; facts?: Record<string, FactValue[]> },
  ): Promise<WorldEntryFile> {
    await this.host.getWorld(worldId)
    const time = this.host.timestamp()
    const id = newId('entry')
    const entry: WorldEntryFile = {
      formatVersion: FORMAT_VERSION,
      id,
      worldId,
      template: input.template,
      name: input.name.trim(),
      aliases: [],
      facts: cleanFacts(input.facts ?? {}, id),
      body: emptyDoc(),
      quotes: [],
      portrait: null,
      mergedFrom: [],
      when: null,
      createdAt: time,
      updatedAt: time,
    }
    await this.host.lock.run(`world:${worldId}`, async () => {
      await fs.promises.mkdir(join(this.dir(worldId), 'entries'), { recursive: true })
      await this.host.writeFile(worldId, unitPaths.entry(id), entry)
    })
    this.host.changed({ kind: 'entry', worldId, entryId: id })
    return entry
  }

  /** Saves changes to an entry; fields left out keep their value on disk. */
  async saveEntry(worldId: string, entryId: string, patch: EntryPatch): Promise<WorldEntryFile> {
    const saved = await this.host.lock.run(`world:${worldId}`, () =>
      this.writeEntry(worldId, entryId, patch),
    )
    this.host.changed({ kind: 'entry', worldId, entryId })
    return saved
  }

  /** Call while holding the world's lock. */
  private async writeEntry(
    worldId: string,
    entryId: string,
    patch: EntryPatch,
  ): Promise<WorldEntryFile> {
    const existing = await this.readEntry(worldId, entryId)
    const next: WorldEntryFile = { ...existing, formatVersion: FORMAT_VERSION }
    if (patch.name !== undefined) next.name = patch.name.trim()
    if (patch.aliases !== undefined) {
      next.aliases = [...new Set(patch.aliases.map((a) => a.trim()).filter(Boolean))]
    }
    if (patch.template !== undefined) next.template = patch.template
    if (patch.facts !== undefined) next.facts = cleanFacts(patch.facts, entryId)
    if (patch.body !== undefined) next.body = patch.body
    if (patch.quotes !== undefined) next.quotes = patch.quotes
    if (patch.portrait !== undefined) next.portrait = patch.portrait
    if (patch.mergedFrom !== undefined) {
      next.mergedFrom = [...new Set(patch.mergedFrom.filter((id) => id !== entryId))]
    }
    if (patch.when !== undefined) next.when = patch.when
    next.updatedAt = this.host.timestamp()
    await this.host.writeFile(worldId, unitPaths.entry(entryId), next)
    return next
  }

  /** A copy with " (copy)" after the name; quotes and appearances stay with the original. */
  async duplicate(worldId: string, entryId: string): Promise<WorldEntryFile> {
    const source = await this.readEntry(worldId, entryId)
    const copy = await this.createEntry(worldId, {
      name: `${source.name} (copy)`.slice(0, 200),
      template: source.template,
      facts: Object.fromEntries(
        Object.entries(source.facts).map(([field, values]) => [
          field,
          values.map((v) => ({ ...v, id: newId('fact') })),
        ]),
      ),
    })
    return this.saveEntry(worldId, copy.id, { body: source.body, portrait: source.portrait })
  }

  /**
   * Merges a duplicate into the entry kept: its name becomes an alias, facts,
   * quotes and page text are added, and links to it now point at the kept
   * entry. The duplicate goes to the trash. Chapters are never rewritten: POV
   * tags to the duplicate resolve through `mergedFrom`.
   */
  async merge(
    worldId: string,
    keepId: string,
    mergeId: string,
  ): Promise<EntryChangeResult & { kept: WorldEntryFile }> {
    if (keepId === mergeId) throw new AppError('invalid-input', 'Pick a different entry to merge.')
    const before: WorldEntryFile[] = []
    const kept = await this.host.lock.run(`world:${worldId}`, async () => {
      const [keep, gone] = await Promise.all([
        this.readEntry(worldId, keepId),
        this.readEntry(worldId, mergeId),
      ])
      before.push(keep)
      const facts: Record<string, FactValue[]> = { ...keep.facts }
      for (const [field, values] of Object.entries(gone.facts)) {
        const have = facts[field] ?? []
        const extra = values.filter(
          (v) =>
            !have.some(
              (h) => (h.link ?? h.text?.trim()) === (v.link ?? v.text?.trim()) && v.link !== keepId,
            ),
        )
        facts[field] = [...have, ...extra]
      }
      const body: RichTextDoc = hasText(gone.body)
        ? {
            ...keep.body,
            content: [
              ...(keep.body.content ?? []),
              {
                type: 'heading',
                attrs: { level: 3 },
                content: [{ type: 'text', text: `From ${gone.name}` }],
              },
              ...(gone.body.content ?? []),
            ],
          }
        : keep.body
      const result = await this.writeEntry(worldId, keepId, {
        aliases: [...keep.aliases, gone.name, ...gone.aliases].filter((a) => a !== keep.name),
        facts,
        body,
        quotes: [...keep.quotes, ...gone.quotes],
        portrait: keep.portrait ?? gone.portrait,
        mergedFrom: [...keep.mergedFrom, mergeId, ...gone.mergedFrom],
      })
      // Links to the duplicate now point at the entry kept.
      for (const other of (await this.readAll(worldId)).entries) {
        if (other.id === keepId || other.id === mergeId) continue
        if (!linksTo(other, mergeId)) continue
        before.push(other)
        await this.writeEntry(worldId, other.id, {
          facts: mapLinks(other.facts, (to) => (to === mergeId ? keepId : to)),
        })
      }
      return result
    })
    for (const e of before) this.host.changed({ kind: 'entry', worldId, entryId: e.id })
    // Relationships of the duplicate move to the entry kept (one between the two is dropped).
    const relationships = await this.rewriteRelationships(worldId, (r) => {
      const from = r.from === mergeId ? keepId : r.from
      const to = r.to === mergeId ? keepId : r.to
      if (from === r.from && to === r.to) return r
      return from === to ? null : { ...r, from, to }
    })
    const trash = await this.host.moveToTrash({ kind: 'entry', worldId, entryId: mergeId })
    await this.unpin(worldId, mergeId)
    return { kept, trash, before, relationships }
  }

  /**
   * Moves an entry to the trash. With `unlink`, links to it are removed from
   * other entries first; otherwise they stay and show as missing until it is
   * restored.
   */
  async deleteEntry(worldId: string, entryId: string, unlink: boolean): Promise<EntryChangeResult> {
    const before: WorldEntryFile[] = []
    if (unlink) {
      await this.host.lock.run(`world:${worldId}`, async () => {
        for (const other of (await this.readAll(worldId)).entries) {
          if (other.id === entryId || !linksTo(other, entryId)) continue
          before.push(other)
          await this.writeEntry(worldId, other.id, {
            facts: mapLinks(other.facts, (to) => (to === entryId ? null : to)),
          })
        }
      })
    }
    for (const e of before) this.host.changed({ kind: 'entry', worldId, entryId: e.id })
    // With unlink, its relationships go too; otherwise they wait (hidden) until it's restored.
    const relationships = unlink
      ? await this.rewriteRelationships(worldId, (r) =>
          r.from === entryId || r.to === entryId ? null : r,
        )
      : []
    const trash = await this.host.moveToTrash({ kind: 'entry', worldId, entryId })
    await this.unpin(worldId, entryId)
    return { trash, before, relationships }
  }

  /** Entries that link to this one through their facts. */
  async linkedFrom(worldId: string, entryId: string): Promise<WorldEntryFile[]> {
    return (await this.readAll(worldId)).entries.filter(
      (e) => e.id !== entryId && linksTo(e, entryId),
    )
  }

  /* ---------- portraits ---------- */

  imagePath(worldId: string, file: string): string {
    if (!WORLD_IMAGE.test(file)) throw new AppError('not-found', 'No such image.')
    return join(this.dir(worldId), 'images', file)
  }

  /** Stores an image once, named by its content hash (call while holding the world's lock). */
  private async storeImage(worldId: string, data: Uint8Array, what: string): Promise<string> {
    const type = detectImageType(data)
    if (!type) throw new AppError('invalid-input', `${what} must be PNG, JPEG, WebP or GIF images.`)
    const file = `${sha256(data)}.${type.ext}`
    if (!(await pathExists(this.imagePath(worldId, file)))) {
      await fs.promises.mkdir(join(this.dir(worldId), 'images'), { recursive: true })
      await this.host.writeBytes(worldId, `images/${file}`, data)
    }
    return file
  }

  /** Stores the image once (named by its hash) and makes it the entry's portrait. */
  async setPortrait(worldId: string, entryId: string, data: Uint8Array): Promise<WorldEntryFile> {
    if (!detectImageType(data))
      throw new AppError('invalid-input', 'Portraits must be PNG, JPEG, WebP or GIF images.')
    const saved = await this.host.lock.run(`world:${worldId}`, async () => {
      const file = await this.storeImage(worldId, data, 'Portraits')
      return this.writeEntry(worldId, entryId, {
        portrait: { file, crop: { x: 0.5, y: 0.5, size: 1 } },
      })
    })
    this.host.changed({ kind: 'entry', worldId, entryId })
    return saved
  }

  /* ---------- maps ---------- */

  private mapPath(worldId: string, mapId: string): string {
    return join(this.dir(worldId), unitPaths.map(mapId))
  }

  async readMap(worldId: string, mapId: string): Promise<MapFile> {
    return readJsonFile(this.mapPath(worldId, mapId), mapFileSchema)
  }

  /** Every readable map, oldest first; unreadable files are reported and left alone. */
  private async readMaps(
    worldId: string,
  ): Promise<{ maps: MapFile[]; problems: LibraryProblem[] }> {
    let names: string[] = []
    try {
      names = await fs.promises.readdir(join(this.dir(worldId), 'maps'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const maps: MapFile[] = []
    const problems: LibraryProblem[] = []
    for (const name of names.filter((n) => n.endsWith('.json') && !isTempFileName(n)).sort()) {
      const mapId = name.slice(0, -'.json'.length)
      try {
        maps.push(await this.readMap(worldId, mapId))
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        problems.push({
          path: `worlds/${worldId}/${unitPaths.map(mapId)}`,
          message: 'Not a readable map file.',
        })
      }
    }
    maps.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return { maps, problems }
  }

  /**
   * A new map: an imported image (stored once, by content hash), or a travel
   * sketch when there is no image. `placeId` is the place it shows (null for
   * the world map). With `version`, a later version of an existing map, from
   * an event onwards: a copy of the version shown (its regions and pins
   * scaled to a new image if there is one).
   */
  async createMap(
    worldId: string,
    input: {
      name: string
      placeId: string | null
      image: { data: Uint8Array; width: number; height: number } | null
      version?: { of: string; copyFrom: string; from: FactAnchor }
    },
  ): Promise<MapFile> {
    await this.host.getWorld(worldId)
    const time = this.host.timestamp()
    const map = await this.host.lock.run(`world:${worldId}`, async () => {
      const image = input.image && {
        file: await this.storeImage(worldId, input.image.data, 'Maps'),
        width: input.image.width,
        height: input.image.height,
      }
      let created: MapFile = {
        formatVersion: FORMAT_VERSION,
        id: newId('map'),
        worldId,
        name: input.name.trim(),
        placeId: input.placeId,
        image,
        regions: [],
        pins: [],
        sketch: image ? null : { nodes: [], roads: [] },
        versionOf: null,
        from: null,
        createdAt: time,
        updatedAt: time,
      }
      if (input.version) {
        const base = await this.readMap(worldId, input.version.of)
        if (base.versionOf) throw new AppError('invalid-input', 'That map is itself a version.')
        const source = await this.readMap(worldId, input.version.copyFrom)
        if (source.id !== base.id && source.versionOf !== base.id) {
          throw new AppError('invalid-input', 'That map is not a version of this one.')
        }
        const sx = image && source.image ? image.width / source.image.width : 1
        const sy = image && source.image ? image.height / source.image.height : 1
        created = {
          ...created,
          name: base.name,
          placeId: base.placeId,
          image: image ?? source.image,
          regions: source.regions.map((r) => ({
            ...r,
            rings: r.rings.map((ring) =>
              ring.map(([x, y]) => [x * sx, y * sy] as [number, number]),
            ),
          })),
          pins: source.pins.map((p) => ({ ...p, x: p.x * sx, y: p.y * sy })),
          sketch: source.sketch,
          versionOf: base.id,
          from: input.version.from,
        }
      }
      await fs.promises.mkdir(join(this.dir(worldId), 'maps'), { recursive: true })
      await this.host.writeFile(worldId, unitPaths.map(created.id), created)
      return created
    })
    this.host.changed({ kind: 'world', worldId })
    return map
  }

  /** Saves a map's name, regions, sketch or place; fields left out keep their value. */
  async saveMap(
    worldId: string,
    mapId: string,
    patch: Partial<Pick<MapFile, 'name' | 'regions' | 'pins' | 'sketch' | 'placeId'>>,
  ): Promise<MapFile> {
    const saved = await this.host.lock.run(`world:${worldId}`, async () => {
      const map = await this.readMap(worldId, mapId)
      const next: MapFile = { ...map, formatVersion: FORMAT_VERSION }
      if (patch.name !== undefined) next.name = patch.name.trim()
      if (patch.regions !== undefined) next.regions = patch.regions
      if (patch.pins !== undefined) next.pins = patch.pins
      if (patch.sketch !== undefined) next.sketch = patch.sketch
      if (patch.placeId !== undefined) next.placeId = patch.placeId
      next.updatedAt = this.host.timestamp()
      await this.host.writeFile(worldId, unitPaths.map(mapId), next)
      return next
    })
    this.host.changed({ kind: 'world', worldId })
    return saved
  }

  /** Places next to each place, from touching regions and sketch roads (cached per map version). */
  private nearbyFor(maps: MapFile[], positions: ChapterPositions): Record<string, string[]> {
    const key = maps.map((m) => `${m.id}@${m.updatedAt}`).join('|')
    // Only each map's latest version counts. Versions are ordered by history
    // (positions without chapters: ones from events during the story go by age).
    const order = maps.map((m) => `${m.id}:${m.from ? anchorPosition(m.from, positions) : ''}`)
    const keyed = `${key}#${order.join(',')}`
    if (this.nearbyCache?.key !== keyed) {
      this.nearbyCache = { key: keyed, nearby: nearbyPlaces(mapsNow(maps, positions)) }
    }
    return this.nearbyCache.nearby
  }

  /* ---------- relationships and the people board ---------- */

  private async readRelationships(
    worldId: string,
  ): Promise<{ relationships: RelationshipFile[]; problems: LibraryProblem[] }> {
    let names: string[] = []
    try {
      names = await fs.promises.readdir(join(this.dir(worldId), 'relationships'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const relationships: RelationshipFile[] = []
    const problems: LibraryProblem[] = []
    for (const name of names.filter((n) => n.endsWith('.json') && !isTempFileName(n)).sort()) {
      const relId = name.slice(0, -'.json'.length)
      try {
        relationships.push(
          await readJsonFile(
            join(this.dir(worldId), unitPaths.relationship(relId)),
            relationshipFileSchema,
          ),
        )
      } catch (err) {
        if (!(err instanceof AppError)) throw err
        problems.push({
          path: `worlds/${worldId}/${unitPaths.relationship(relId)}`,
          message: 'Not a readable relationship file.',
        })
      }
    }
    relationships.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return { relationships, problems }
  }

  /**
   * Creates or updates a relationship (an id that doesn't exist yet is
   * created with that id, so undo can put a deleted one back exactly).
   */
  async saveRelationship(worldId: string, input: RelationshipInput): Promise<RelationshipFile> {
    if (input.from === input.to) {
      throw new AppError('invalid-input', 'A relationship needs two different entries.')
    }
    await Promise.all([this.readEntry(worldId, input.from), this.readEntry(worldId, input.to)])
    const time = this.host.timestamp()
    const id = input.id ?? newId('relationship')
    const saved = await this.host.lock.run(`world:${worldId}`, async () => {
      let existing: RelationshipFile | null = null
      try {
        existing = await readJsonFile(
          join(this.dir(worldId), unitPaths.relationship(id)),
          relationshipFileSchema,
        )
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'not-found') throw err
      }
      const next: RelationshipFile = {
        ...existing,
        ...input,
        formatVersion: FORMAT_VERSION,
        id,
        worldId,
        label: input.label.trim(),
        kin: input.type === 'family' ? input.kin : null,
        createdAt: existing?.createdAt ?? input.createdAt ?? time,
        updatedAt: time,
      }
      await fs.promises.mkdir(join(this.dir(worldId), 'relationships'), { recursive: true })
      await this.host.writeFile(worldId, unitPaths.relationship(id), next)
      return next
    })
    this.host.changed({ kind: 'world', worldId })
    return saved
  }

  /** Deletes a relationship; returns it as it was (saving it again undoes the delete). */
  async deleteRelationship(worldId: string, relId: string): Promise<RelationshipFile> {
    const removed = await this.host.lock.run(`world:${worldId}`, async () => {
      const rel = unitPaths.relationship(relId)
      const file = await readJsonFile(join(this.dir(worldId), rel), relationshipFileSchema)
      await this.host.removeFile(worldId, rel)
      return file
    })
    this.host.changed({ kind: 'world', worldId })
    return removed
  }

  /** Changes (or deletes, with null) every relationship; returns the changed ones as they were. */
  private async rewriteRelationships(
    worldId: string,
    change: (r: RelationshipFile) => RelationshipFile | null,
  ): Promise<RelationshipFile[]> {
    const before: RelationshipFile[] = []
    await this.host.lock.run(`world:${worldId}`, async () => {
      for (const r of (await this.readRelationships(worldId)).relationships) {
        const next = change(r)
        if (next === r) continue
        before.push(r)
        const rel = unitPaths.relationship(r.id)
        if (next)
          await this.host.writeFile(worldId, rel, { ...next, updatedAt: this.host.timestamp() })
        else await this.host.removeFile(worldId, rel)
      }
    })
    if (before.length) this.host.changed({ kind: 'world', worldId })
    return before
  }

  private async customRelationshipTypes(worldId: string): Promise<RelationshipType[]> {
    try {
      return (
        await readJsonFile(
          join(this.dir(worldId), 'relationship-types.json'),
          relationshipTypesFileSchema,
        )
      ).types
    } catch (err) {
      if (err instanceof AppError) return []
      throw err
    }
  }

  /** Saves the world's relationship types (renamed, recoloured or new ones). */
  async saveRelationshipTypes(
    worldId: string,
    types: RelationshipType[],
  ): Promise<RelationshipType[]> {
    await this.host.getWorld(worldId)
    await this.host.lock.run(`world:${worldId}`, () =>
      this.host.writeFile(worldId, 'relationship-types.json', {
        formatVersion: FORMAT_VERSION,
        worldId,
        types,
      }),
    )
    this.host.changed({ kind: 'world', worldId })
    return relationshipTypes(types)
  }

  private async readBoard(worldId: string): Promise<BoardFile> {
    try {
      return await readJsonFile(join(this.dir(worldId), 'board.json'), boardFileSchema)
    } catch (err) {
      if (!(err instanceof AppError)) throw err
      // Layout only: a missing or damaged file starts empty (and is replaced on the next move).
      return {
        formatVersion: FORMAT_VERSION,
        worldId,
        positions: {},
        updatedAt: this.host.timestamp(),
      }
    }
  }

  /** Saves where portraits sit on the board. Layout only: the people themselves never change. */
  async saveBoard(worldId: string, positions: BoardFile['positions']): Promise<void> {
    await this.host.getWorld(worldId)
    await this.host.lock.run(`world:${worldId}`, () =>
      this.host.writeFile(worldId, 'board.json', {
        formatVersion: FORMAT_VERSION,
        worldId,
        positions,
        updatedAt: this.host.timestamp(),
      }),
    )
    this.host.changed({ kind: 'world', worldId })
  }

  /* ---------- capture and the inbox ---------- */

  /** Saves a sentence from the manuscript under one of an entry's fields (or its notes). */
  async capture(
    worldId: string,
    entryId: string,
    field: string | null,
    text: string,
    source: ChapterSource,
  ): Promise<WorldEntryFile> {
    const saved = await this.host.lock.run(`world:${worldId}`, async () => {
      const entry = await this.readEntry(worldId, entryId)
      return this.writeEntry(worldId, entryId, {
        quotes: [
          ...entry.quotes,
          {
            id: newId('quote'),
            field,
            text: text.trim(),
            source,
            capturedAt: this.host.timestamp(),
          },
        ],
      })
    })
    this.host.changed({ kind: 'entry', worldId, entryId })
    return saved
  }

  private async readInbox(worldId: string): Promise<InboxFile> {
    const path = join(this.dir(worldId), 'inbox.json')
    try {
      return await readJsonFile(path, inboxFileSchema)
    } catch (err) {
      // Missing is normal. A damaged inbox is never overwritten: it reads as empty
      // and writes are refused (see changeInbox).
      if (err instanceof AppError && err.code === 'not-found') {
        return { formatVersion: FORMAT_VERSION, worldId, items: [] }
      }
      if (err instanceof AppError) return { formatVersion: FORMAT_VERSION, worldId, items: [] }
      throw err
    }
  }

  private async changeInbox(
    worldId: string,
    change: (items: InboxItem[]) => InboxItem[],
  ): Promise<void> {
    await this.host.lock.run(`world:${worldId}`, async () => {
      const path = join(this.dir(worldId), 'inbox.json')
      let inbox: InboxFile
      try {
        inbox = await readJsonFile(path, inboxFileSchema)
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'not-found') throw err
        inbox = { formatVersion: FORMAT_VERSION, worldId, items: [] }
      }
      await this.host.writeFile(worldId, 'inbox.json', { ...inbox, items: change(inbox.items) })
    })
    this.host.changed({ kind: 'inbox', worldId })
  }

  async inboxCapture(worldId: string, text: string, source: ChapterSource): Promise<InboxItem> {
    await this.host.getWorld(worldId)
    const item: InboxItem = {
      id: newId('inbox'),
      text: text.trim(),
      source,
      capturedAt: this.host.timestamp(),
    }
    await this.changeInbox(worldId, (items) => [...items, item])
    return item
  }

  async inboxDismiss(worldId: string, itemId: string): Promise<InboxItem> {
    const item = (await this.readInbox(worldId)).items.find((i) => i.id === itemId)
    if (!item) throw new AppError('not-found', 'That inbox item is gone.')
    await this.changeInbox(worldId, (items) => items.filter((i) => i.id !== itemId))
    return item
  }

  /** Files a captured item under an entry: it becomes one of the entry's quotes. */
  async inboxFile(
    worldId: string,
    itemId: string,
    entryId: string,
    field: string | null,
  ): Promise<WorldEntryFile> {
    const item = (await this.readInbox(worldId)).items.find((i) => i.id === itemId)
    if (!item) throw new AppError('not-found', 'That inbox item is gone.')
    // Entry first: if the inbox write fails, the quote is kept twice, never lost.
    const saved = await this.capture(worldId, entryId, field, item.text, item.source)
    await this.changeInbox(worldId, (items) => items.filter((i) => i.id !== itemId))
    return saved
  }

  async inbox(worldId: string, withNames: boolean): Promise<WorldInbox> {
    const captured = (await this.readInbox(worldId)).items
    if (!withNames) return { captured, names: [] }
    const [story, { entries }, rejected] = await Promise.all([
      this.host.story(worldId),
      this.readAll(worldId),
      this.rejected(worldId),
    ])
    const known = entries.flatMap((e) =>
      [e.name, ...e.aliases].flatMap((n) => n.match(/[\p{L}\p{N}'’-]+/gu) ?? []),
    )
    const names = catchNames(
      story.map((s) => ({ id: s.chapter.id, paragraphs: s.paragraphs })),
      known,
      [...DEFAULT_FILLER_WORDS, ...rejected],
    )
    return { captured, names }
  }

  private async rejected(worldId: string): Promise<string[]> {
    try {
      return (await readJsonFile(join(this.dir(worldId), 'rejected.json'), rejectedFileSchema))
        .names
    } catch (err) {
      if (err instanceof AppError) return []
      throw err
    }
  }

  /** Remembers turned-down suggestions (or forgets them again, to undo). */
  async rejectNames(worldId: string, names: string[], rejected: boolean): Promise<void> {
    await this.host.lock.run(`world:${worldId}`, async () => {
      const path = join(this.dir(worldId), 'rejected.json')
      let current: string[] = []
      try {
        current = (await readJsonFile(path, rejectedFileSchema)).names
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'not-found') throw err
      }
      const lower = new Set(names.map((n) => n.toLowerCase()))
      const next = rejected
        ? [...new Set([...current, ...names])]
        : current.filter((n) => !lower.has(n.toLowerCase()))
      await this.host.writeFile(worldId, 'rejected.json', {
        formatVersion: FORMAT_VERSION,
        worldId,
        names: next.sort(),
      })
    })
    this.host.changed({ kind: 'inbox', worldId })
  }

  /* ---------- pins and templates ---------- */

  async pin(worldId: string, entryId: string, pinned: boolean): Promise<WorldFile> {
    const next = await this.host.lock.run(`world:${worldId}`, async () => {
      const world = await this.host.getWorld(worldId)
      const list = world.pinned.filter((id) => id !== entryId)
      const updated = {
        ...world,
        pinned: pinned ? [...list, entryId] : list,
        updatedAt: this.host.timestamp(),
      }
      await this.host.writeFile(worldId, unitPaths.world, updated)
      return updated
    })
    this.host.changed({ kind: 'world', worldId })
    return next
  }

  private async unpin(worldId: string, entryId: string): Promise<void> {
    const world = await this.host.getWorld(worldId)
    if (world.pinned.includes(entryId)) await this.pin(worldId, entryId, false)
  }

  private async customTemplates(worldId: string): Promise<Template[]> {
    try {
      return (await readJsonFile(join(this.dir(worldId), 'templates.json'), templatesFileSchema))
        .templates
    } catch (err) {
      // A damaged file is left alone (and the built-ins are used) until it is fixed.
      if (err instanceof AppError) return []
      throw err
    }
  }

  private async changeTemplates(
    worldId: string,
    change: (templates: Template[]) => Template[],
  ): Promise<void> {
    await this.host.lock.run(`world:${worldId}`, async () => {
      const path = join(this.dir(worldId), 'templates.json')
      let templates: Template[] = []
      try {
        templates = (await readJsonFile(path, templatesFileSchema)).templates
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'not-found') throw err
      }
      await this.host.writeFile(worldId, 'templates.json', {
        formatVersion: FORMAT_VERSION,
        worldId,
        templates: change(templates),
      })
    })
    this.host.changed({ kind: 'world', worldId })
  }

  /** Saves a customised or new template into the world folder (so it travels with the world). */
  async saveTemplate(worldId: string, input: TemplateInput): Promise<Template> {
    await this.host.getWorld(worldId)
    const ids = new Set<string>()
    const template: Template = {
      id: input.id ?? `${slug(input.name)}-${newId('template').slice(4, 10)}`,
      name: input.name.trim(),
      lens: input.lens,
      fields: input.fields.map((f) => {
        let id = f.id ?? newId('field')
        if (ids.has(id)) id = newId('field')
        ids.add(id)
        return { ...f, id, label: f.label.trim() }
      }),
    }
    await this.changeTemplates(worldId, (list) => [
      ...list.filter((t) => t.id !== template.id),
      template,
    ])
    return template
  }

  /** Removes a world's own template; a customised built-in goes back to the original. */
  async deleteTemplate(worldId: string, templateId: string): Promise<void> {
    const custom = await this.customTemplates(worldId)
    if (!custom.some((t) => t.id === templateId)) {
      throw new AppError(
        'not-found',
        isBuiltIn(templateId) ? 'This template is already the original.' : 'No such template.',
      )
    }
    await this.changeTemplates(worldId, (list) => list.filter((t) => t.id !== templateId))
  }

  /* ---------- derived data ---------- */

  /** Chapters in reading order and where each entry is mentioned. */
  index(worldId: string): Promise<WorldIndex> {
    let cached = this.indexCache.get(worldId)
    if (!cached) {
      cached = this.buildIndex(worldId)
      cached.catch(() => this.indexCache.delete(worldId))
      this.indexCache.set(worldId, cached)
    }
    return cached
  }

  private async buildIndex(worldId: string): Promise<WorldIndex> {
    const [story, { entries }] = await Promise.all([
      this.cachedStory(worldId),
      this.readAll(worldId),
    ])
    const matcher = nameMatcher(entryTerms(entries))
    const owner = ownerOf(entries)
    const mentions: WorldIndex['mentions'] = {}
    const get = (id: string) => (mentions[id] ??= { chapters: [], counts: [], pov: [] })
    story.forEach((text, position) => {
      const counts = new Map<string, number>()
      for (const p of text.paragraphs) {
        for (const m of matcher.find(p)) counts.set(m.entryId, (counts.get(m.entryId) ?? 0) + 1)
      }
      for (const [id, count] of counts) {
        get(id).chapters.push(position)
        get(id).counts.push(count)
      }
      const pov = text.povEntryId && owner.get(text.povEntryId)
      if (pov) get(pov).pov.push(position)
    })
    return { chapters: story.map((s) => s.chapter), mentions }
  }

  private cachedStory(worldId: string): Promise<StoryText[]> {
    let cached = this.storyCache.get(worldId)
    if (!cached) {
      cached = this.host.story(worldId)
      cached.catch(() => this.storyCache.delete(worldId))
      this.storyCache.set(worldId, cached)
    }
    return cached
  }

  /** Chapters where an entry is mentioned, with the sentences it is mentioned in. */
  async appearances(worldId: string, entryId: string): Promise<Appearance[]> {
    const [entry, story] = await Promise.all([
      this.readEntry(worldId, entryId),
      this.cachedStory(worldId),
    ])
    const matcher = nameMatcher(entryTerms([entry]))
    const ids = new Set([entryId, ...entry.mergedFrom])
    const out: Appearance[] = []
    story.forEach((text, position) => {
      let count = 0
      const lines: string[] = []
      for (const p of text.paragraphs) {
        const found = matcher.find(p)
        if (!found.length) continue
        count += found.length
        for (const s of splitSentences(p)) {
          if (lines.length >= LINES_PER_CHAPTER) break
          if (found.some((m) => m.start >= s.start && m.start < s.end)) {
            lines.push(clip(p.slice(s.start, s.end).trim(), LINE_LENGTH))
          }
        }
      }
      const pov = !!text.povEntryId && ids.has(text.povEntryId)
      if (count || pov) out.push({ chapter: text.chapter, position, count, pov, lines })
    })
    return out
  }

  /** A compact text summary of every entry, for language models. */
  async digest(worldId: string): Promise<string> {
    const [view, index] = await Promise.all([this.view(worldId), this.index(worldId)])
    return worldDigest(
      view.world.name,
      view.entries,
      view.templates,
      timelinePositions(view.entries, index),
      view.nearby,
      { relationships: view.relationships, types: view.relationshipTypes },
      index.chapters,
    )
  }

  /** One entry as plain text and links. */
  async entryText(worldId: string, entryId: string): Promise<string> {
    const [entry, view, index] = await Promise.all([
      this.readEntry(worldId, entryId),
      this.view(worldId),
      this.index(worldId),
    ])
    return entryText({
      entry,
      body: docParagraphs(entry.body),
      templates: view.templates,
      entries: view.entries,
      chapters: index.chapters,
      mentions: index.mentions[entryId],
      nearby: view.nearby[entryId] ?? [],
      maps: baseMaps(view.maps)
        .filter((m) => m.placeId === entryId)
        .map((m) => m.name),
      pinnedOn: mapsNow(view.maps, timelinePositions(view.entries, index))
        .filter((m) => m.pins.some((p) => p.placeId === entryId))
        .map((m) => m.name),
      relationships: view.relationships
        .filter((r) => r.from === entryId || r.to === entryId)
        .map((r) =>
          relationshipText(
            r,
            new Map(view.entries.map((e) => [e.id, e.name])),
            view.relationshipTypes,
            (id) => index.chapters.find((c) => c.id === id)?.label,
          ),
        ),
    })
  }
}

/* ---------- helpers ---------- */

function toSummary(entry: WorldEntryFile): EntrySummary {
  const text = docParagraphs(entry.body).join(' ').replace(/\s+/g, ' ').trim()
  return {
    id: entry.id,
    name: entry.name,
    aliases: entry.aliases,
    template: entry.template,
    facts: entry.facts,
    snippet: clip(text, SNIPPET_LENGTH),
    portrait: entry.portrait,
    mergedFrom: entry.mergedFrom,
    links: bodyLinks(entry.body),
    when: entry.when,
    updatedAt: entry.updatedAt,
  }
}

/** Entries linked explicitly from a page (the `@` picker adds a `worldLink` mark). */
export function bodyLinks(doc: RichTextDoc): string[] {
  const found = new Set<string>()
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const n = node as {
      marks?: { type?: string; attrs?: { entryId?: unknown } }[]
      content?: unknown[]
    }
    for (const mark of n.marks ?? []) {
      if (mark.type === 'worldLink' && typeof mark.attrs?.entryId === 'string') {
        found.add(mark.attrs.entryId)
      }
    }
    n.content?.forEach(walk)
  }
  walk(doc)
  return [...found]
}

/** Drops empty values and links to the entry itself. */
function cleanFacts(
  facts: Record<string, FactValue[]>,
  selfId: string,
): Record<string, FactValue[]> {
  const out: Record<string, FactValue[]> = {}
  for (const [field, values] of Object.entries(facts)) {
    const kept = values
      .filter((v) => (v.link ? v.link !== selfId : !!v.text?.trim()))
      .map((v) => (v.link ? { ...v, text: undefined } : { ...v, text: v.text!.trim() }))
      .map((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)))
    if (kept.length) out[field] = kept as FactValue[]
  }
  return out
}

function linksTo(entry: WorldEntryFile, target: string): boolean {
  return Object.values(entry.facts).some((values) =>
    values.some(
      (v) => v.link === target || (v.from?.kind === 'event' && v.from.entryId === target),
    ),
  )
}

/** Rewrites (or with `null`, removes) links, including "from event" anchors. */
function mapLinks(
  facts: Record<string, FactValue[]>,
  map: (to: string) => string | null,
): Record<string, FactValue[]> {
  const out: Record<string, FactValue[]> = {}
  for (const [field, values] of Object.entries(facts)) {
    out[field] = values.flatMap((v) => {
      let next = v
      if (v.link) {
        const to = map(v.link)
        if (!to) return []
        next = { ...next, link: to }
      }
      if (v.from?.kind === 'event') {
        const to = map(v.from.entryId)
        next = { ...next, from: to ? { ...v.from, entryId: to } : null }
      }
      return [next]
    })
  }
  return out
}

/** Maps an entry id, or the id of an entry merged into it, to the entry. */
function ownerOf(entries: WorldEntryFile[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const e of entries) for (const old of e.mergedFrom) map.set(old, e.id)
  for (const e of entries) map.set(e.id, e.id)
  return map
}

function hasText(doc: RichTextDoc): boolean {
  return docParagraphs(doc).some((p) => p.trim())
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function slug(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return /^[a-z]/.test(s) ? s : `t-${s}`.replace(/-$/, '')
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

export type { StoryChapter }
