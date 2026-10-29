/**
 * Text forms of the world. Every view is also plain text and links (entry
 * ids), so a language model can understand the whole world without seeing
 * any image. Derived data, rebuilt locally whenever it's asked for.
 */
import type {
  FactValue,
  Quote,
  RelationshipFile,
  RelationshipType,
  Template,
  TimelinePlace,
} from '../schema'
import { currentValue, inTimeOrder, valuesAt, type ChapterPositions } from './facts'
import { chapterName, type EntryMentions, type StoryChapter } from './story'
import { effectiveTemplate, LENS_LABELS } from './templates'
import { buildTimeline, type Timeline } from './timeline'

export interface DigestEntry {
  id: string
  name: string
  aliases: string[]
  template: string
  facts: Record<string, FactValue[]>
  /** The first line of the entry's page. */
  snippet: string
  /** For eras and events: their place on the timeline. */
  when?: TimelinePlace | null
}

/** The world's timeline from its eras and events (those placed, or of an era or event template). */
function timelineOf(
  entries: readonly DigestEntry[],
  templates: readonly Template[],
  chapters: readonly StoryChapter[],
): Timeline {
  const timed = entries.filter(
    (e) => e.when || effectiveTemplate(templates, e.template, e.facts).lens === 'when',
  )
  return buildTimeline(
    timed.map((e) => ({ id: e.id, template: e.template, when: e.when ?? null })),
    chapters,
  )
}

/** Where an era or event sits, in words: "before the story (2 of 5)", "during Ch 3". */
function whenText(id: string, timeline: Timeline, chapters: readonly StoryChapter[]): string {
  const h = timeline.history.indexOf(id)
  if (h >= 0) return `before the story (${h + 1} of ${timeline.history.length})`
  for (const [chapterId, ids] of timeline.during) {
    if (ids.includes(id)) {
      const chapter = chapters.find((c) => c.id === chapterId)
      return chapter ? `during ${chapter.label}` : 'during the story'
    }
  }
  return 'not on the timeline yet'
}

const ONE_LINE = 120

function clip(text: string, max = ONE_LINE): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function valueText(value: FactValue, names: ReadonlyMap<string, string>): string {
  if (value.link) return `${names.get(value.link) ?? '(missing entry)'} [${value.link}]`
  return value.text?.trim() ?? ''
}

function anchorText(
  value: FactValue,
  chapters: readonly StoryChapter[],
  positions: ChapterPositions,
  names: ReadonlyMap<string, string>,
): string {
  if (!value.from) return ''
  if (value.from.kind === 'event')
    return `from ${names.get(value.from.entryId) ?? 'an event'} [${value.from.entryId}]`
  const at = positions.get(value.from.chapterId)
  return at === undefined ? 'from a chapter not in the story' : `from ${chapters[at]!.label}`
}

/**
 * One compact line per entry: id, name, aliases, type, one line, and where it
 * is and how it is now. Small enough to hand to a local model.
 */
export function worldDigest(
  worldName: string,
  entries: readonly DigestEntry[],
  templates: readonly Template[],
  positions: ChapterPositions,
  /** Places next to each place (from the maps). */
  nearby: Record<string, string[]> = {},
  /** The people board, for each entry's ties. */
  board: { relationships: readonly RelationshipFile[]; types: readonly RelationshipType[] } = {
    relationships: [],
    types: [],
  },
  /** The story's chapters in reading order, for the timeline. */
  chapters: readonly StoryChapter[] = [],
): string {
  const names = new Map(entries.map((e) => [e.id, e.name]))
  const timeline = timelineOf(entries, templates, chapters)
  const timed = new Set([
    ...timeline.history,
    ...timeline.unplaced,
    ...[...timeline.during.values()].flat(),
  ])
  const lines = [`World: ${worldName}`, `Entries: ${entries.length}`, '']
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const template = effectiveTemplate(templates, e.template, e.facts)
    const parts = [`[${e.id}] ${e.name}`]
    if (e.aliases.length) parts.push(`aka ${e.aliases.join(', ')}`)
    parts.push(`${template.name} (${LENS_LABELS[template.lens]})`)
    const line = currentValue(e.facts['role'], null, positions)?.text || e.snippet
    if (line) parts.push(clip(line))
    for (const id of ['location', 'within', 'status']) {
      const f = template.fields.find((x) => x.id === id)
      const v = f && currentValue(e.facts[id], null, positions)
      if (f && v) parts.push(`${f.label.toLowerCase()}: ${valueText(v, names)}`)
    }
    const next = (nearby[e.id] ?? []).map((id) => names.get(id)).filter(Boolean)
    if (next.length) parts.push(`borders: ${next.join(', ')}`)
    const ties = board.relationships
      .filter((r) => r.from === e.id || r.to === e.id)
      .slice(0, 8)
      .map((r) => {
        const other = names.get(r.from === e.id ? r.to : r.from) ?? '(missing)'
        const type = board.types.find((t) => t.id === r.type)?.label.toLowerCase() ?? r.type
        const words = r.from === e.id && r.label ? r.label : type
        return `${words} ${other}${r.over || r.end ? ' (over)' : ''}`
      })
    if (ties.length) parts.push(`ties: ${ties.join('; ')}`)
    if (timed.has(e.id)) parts.push(`when: ${whenText(e.id, timeline, chapters)}`)
    lines.push(parts.join(' | '))
  }
  const byId = new Map(entries.map((e) => [e.id, e]))
  const item = (id: string, at: string) => {
    const e = byId.get(id)!
    const where = currentValue(e.facts['where'], null, positions)
    const kind = e.template === 'era' ? 'era' : 'event'
    return `- ${at}: [${id}] ${e.name} (${kind})${where ? ` | where: ${valueText(where, names)}` : ''}`
  }
  const story = chapters.flatMap((c) =>
    (timeline.during.get(c.id) ?? []).map((id) => item(id, c.label)),
  )
  if (timeline.history.length || story.length) {
    lines.push('', 'Timeline (earliest first):')
    lines.push(...timeline.history.map((id) => item(id, 'before the story')), ...story)
    const unplaced = timeline.unplaced.map((id) => byId.get(id)!.name)
    if (unplaced.length) lines.push(`Not on the timeline yet: ${unplaced.join(', ')}`)
  }
  return lines.join('\n')
}

export interface EntryTextInput {
  entry: {
    id: string
    name: string
    aliases: string[]
    template: string
    facts: Record<string, FactValue[]>
    quotes: Quote[]
    when?: TimelinePlace | null
  }
  /** The page's paragraphs. */
  body: string[]
  templates: readonly Template[]
  /** Every entry in the world (for names and reverse links). */
  entries: readonly DigestEntry[]
  chapters: readonly StoryChapter[]
  mentions?: EntryMentions
  /** Places next to this one (from the maps). */
  nearby?: string[]
  /** Names of maps of this place. */
  maps?: string[]
  /** Names of maps it is pinned on. */
  pinnedOn?: string[]
  /** Its relationships, as text (see relationshipText). */
  relationships?: string[]
}

/** One entry as text: facts with their history, the page, what links here, and appearances. */
export function entryText(input: EntryTextInput): string {
  const { entry, templates, chapters } = input
  const timeline = timelineOf(
    [...input.entries.filter((e) => e.id !== entry.id), { ...entry, snippet: '' }],
    templates,
    chapters,
  )
  const positions: ChapterPositions = timeline.positions
  const names = new Map(input.entries.map((e) => [e.id, e.name]))
  const template = effectiveTemplate(templates, entry.template, entry.facts)
  const out = [
    `# ${entry.name}`,
    `ID: ${entry.id}`,
    `Type: ${template.name} (${LENS_LABELS[template.lens]})`,
  ]
  if (entry.when || template.lens === 'when')
    out.push(`When: ${whenText(entry.id, timeline, chapters)}`)
  if (entry.aliases.length) out.push(`Also called: ${entry.aliases.join(', ')}`)

  const facts: string[] = []
  for (const field of template.fields) {
    const values = entry.facts[field.id] ?? []
    if (!values.length) continue
    const shown = field.multiple
      ? valuesAt(field, values, null, positions)
      : inTimeOrder(values, positions)
    const text = shown
      .map((v) => {
        const anchor = anchorText(v, chapters, positions, names)
        return anchor ? `${valueText(v, names)} (${anchor})` : valueText(v, names)
      })
      .join(field.multiple ? '; ' : ', then ')
    facts.push(`- ${field.label}: ${text}`)
  }
  if (facts.length) out.push('', '## Facts', ...facts)

  const body = input.body.map((p) => p.trim()).filter(Boolean)
  if (body.length) out.push('', '## Page', ...body)

  const linked: string[] = []
  for (const other of input.entries) {
    if (other.id === entry.id) continue
    const otherTemplate = effectiveTemplate(templates, other.template, other.facts)
    for (const field of otherTemplate.fields) {
      if ((other.facts[field.id] ?? []).some((v) => v.link === entry.id)) {
        linked.push(
          `- ${field.reverse ?? field.label}: ${other.name} [${other.id}] (${other.name} → ${field.label})`,
        )
      }
    }
  }
  if (linked.length) out.push('', '## Linked from', ...linked)

  if (entry.quotes.length) {
    out.push('', '## From the story')
    for (const q of entry.quotes) {
      const label = q.field
        ? (template.fields.find((f) => f.id === q.field)?.label ?? q.field)
        : 'Notes'
      const at = positions.get(q.source.chapterId)
      out.push(
        `- ${label}: “${clip(q.text, 400)}” (${at === undefined ? q.source.chapterTitle || 'a chapter' : chapterName(chapters[at]!)})`,
      )
    }
  }

  const nearby = (input.nearby ?? []).filter((id) => names.has(id))
  if (nearby.length) {
    out.push('', '## Nearby', ...nearby.map((id) => `- ${names.get(id)} [${id}]`))
  }
  if (input.maps?.length) out.push('', `Has its own map: ${input.maps.join(', ')}`)
  if (input.pinnedOn?.length) out.push(`Pinned on: ${input.pinnedOn.join(', ')}`)
  if (input.relationships?.length)
    out.push('', '## Relationships', ...input.relationships.map((r) => `- ${r}`))

  const m = input.mentions
  if (m && (m.chapters.length || m.pov.length)) {
    out.push('', '## In the story')
    if (m.chapters.length)
      out.push(
        `Mentioned in: ${m.chapters.map((i, n) => `${chapters[i]!.label} (${m.counts[n]})`).join(', ')}`,
      )
    if (m.pov.length)
      out.push(`Point of view in: ${m.pov.map((i) => chapters[i]!.label).join(', ')}`)
  }
  return out.join('\n')
}
