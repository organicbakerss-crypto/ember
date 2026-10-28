/**
 * Text forms of the world. Every view is also plain text and links (entry
 * ids), so a language model can understand the whole world without seeing
 * any image. Derived data, rebuilt locally whenever it's asked for.
 */
import type { FactValue, Quote, Template } from '../schema'
import { currentValue, inTimeOrder, valuesAt, type ChapterPositions } from './facts'
import { chapterName, type EntryMentions, type StoryChapter } from './story'
import { effectiveTemplate, LENS_LABELS } from './templates'

export interface DigestEntry {
  id: string
  name: string
  aliases: string[]
  template: string
  facts: Record<string, FactValue[]>
  /** The first line of the entry's page. */
  snippet: string
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
): string {
  const names = new Map(entries.map((e) => [e.id, e.name]))
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
    lines.push(parts.join(' | '))
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
}

/** One entry as text: facts with their history, the page, what links here, and appearances. */
export function entryText(input: EntryTextInput): string {
  const { entry, templates, chapters } = input
  const positions: ChapterPositions = new Map(chapters.map((c, i) => [c.id, i]))
  const names = new Map(input.entries.map((e) => [e.id, e.name]))
  const template = effectiveTemplate(templates, entry.template, entry.facts)
  const out = [
    `# ${entry.name}`,
    `ID: ${entry.id}`,
    `Type: ${template.name} (${LENS_LABELS[template.lens]})`,
  ]
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
