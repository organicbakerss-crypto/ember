/**
 * "Update the world from this chapter": a fixed pipeline. The app finds the
 * entries named in the chapter and gives the AI the chapter, those entries'
 * notes and the names of everything else; the AI answers narrow questions in
 * JSON (a summary, new things, facts, relationships, what doesn't fit, what
 * it can't tell). The app then checks every answer against the world: names
 * must resolve to entries, fields to the entry's template, and quotes must be
 * in the chapter. Whatever doesn't check out is dropped. What's left goes to
 * the inbox for the writer; nothing is written to the world here.
 */
import type { EntrySummary } from '@shared/ipc'
import type { InboxItem, RelationshipFile, Suggestion, Template } from '@shared/schema'
import type { RelationshipType } from '@shared/schema'
import { FALLBACK_TEMPLATE } from '@shared/world/templates'
import type { ChatMessage } from './ollama'

/** What the AI may call something new, and the template it becomes. */
export const NEW_KINDS: Record<string, { template: string; label: string }> = {
  person: { template: 'person', label: 'person' },
  place: { template: 'city', label: 'place' },
  faction: { template: 'faction', label: 'group' },
  creature: { template: 'creature', label: 'creature' },
  event: { template: 'event', label: 'event' },
  system: { template: 'magic', label: 'system' },
}

/** What each kind means, so organisations aren't filed as people. */
const KIND_GUIDE =
  'person: one individual; faction: any group or organisation, such as a company, shop, band, team, gang, church, school, radio or TV station, agency, club or family; place: a location or building; creature: an animal or non-human being'

const LIMITS = { suggestions: 30, continuity: 10, questions: 3 }

/* ---------- what the AI is asked ---------- */

export function findingsMessages(input: {
  chapterTitle: string
  text: string
  part: number
  parts: number
  /** Notes for the entries named in this text, each with the fields it can take. */
  notes: string[]
  /** Everything else in the world, by name (so it isn't suggested as new). */
  otherNames: string[]
  relationshipTypes: RelationshipType[]
  /** What the writer has told the AI before. */
  answers: { question: string; answer: string }[]
}): ChatMessage[] {
  const types = input.relationshipTypes.map((t) => `${t.id} (${t.label})`).join(', ')
  const system = `You read one chapter of a novel and note what it tells about the story's world, so the writer's world notes stay up to date. Use only what the chapter says. Reply with JSON only, exactly this shape:
{"summary":"","new":[{"name":"","kind":"","about":"","quote":""}],"facts":[{"entry":"","field":"","value":"","quote":""}],"relationships":[{"from":"","to":"","type":"","words":"","quote":""}],"continuity":[{"entry":"","problem":"","quote":""}],"questions":[{"question":"","quote":""}]}
- summary: at most 6 sentences: who is there, what happens, what changes. Keep names exactly.
- new: people, places, groups, creatures, events or systems (magic, laws) the chapter names that are not in the world notes or the list of other names. kind is one of: ${Object.keys(NEW_KINDS).join(', ')} (${KIND_GUIDE}). about: one short line.
- facts: what the chapter shows about an entry in the notes that its notes don't say yet, or that has changed (where someone is now, a new role, someone dies). entry: its exact name. field: one of the fields listed for that entry. value: a few words; for a field marked "a name", the exact name of another entry.
- relationships: two entries named in the chapter who are connected in it, if the notes don't already say so. type is one of: ${types}. words: optional, like "sister of".
- continuity: anything in the chapter that contradicts the world notes or what the writer told you (an eye colour that changed, someone in two places at once, the dead acting). problem: what doesn't fit, in one line.
- questions: at most 3 things you can't tell that matter for the notes, which only the writer can answer (for example: is "the Captain" Mara, or someone new?).
- quote: the exact sentence from the chapter it comes from, copied word for word.
Leave a list empty when there's nothing for it. Don't repeat what the notes already say. Don't guess.`
  const parts = [
    input.notes.length
      ? `World notes for the entries named in this chapter:\n\n${input.notes.join('\n\n---\n\n')}`
      : 'None of the world’s entries are named in this chapter.',
    input.otherNames.length
      ? `Other names already in the world: ${input.otherNames.join(', ')}.`
      : '',
    input.answers.length
      ? `The writer told you:\n${input.answers.map((a) => `- ${a.question} ${a.answer}`).join('\n')}`
      : '',
    `The chapter “${input.chapterTitle || 'Untitled'}”${input.parts > 1 ? ` (part ${input.part} of ${input.parts})` : ''}:\n\n${input.text}`,
  ]
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.filter(Boolean).join('\n\n') },
  ]
}

/** One entry's notes for the prompt: its text form, and the fields it can take. */
export function entryNote(entryText: string, template: Template): string {
  const fields = template.fields
    .map((f) => `${f.label}${f.kind === 'link' ? ' (a name)' : ''}`)
    .join(', ')
  return fields ? `${entryText}\nFields: ${fields}` : entryText
}

/** Several part summaries as one. */
export function combineMessages(summaries: string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'These are summaries of the parts of one novel chapter, in order. Write one summary of the whole chapter in at most 6 sentences: who is there, what happens, what changes. Keep names exactly. Plain text.',
    },
    { role: 'user', content: summaries.map((s, i) => `Part ${i + 1}: ${s}`).join('\n\n') },
  ]
}

/* ---------- reading the answer ---------- */

export interface RawFindings {
  summary: string
  new: { name: string; kind: string; about: string; quote: string }[]
  facts: { entry: string; field: string; value: string; quote: string }[]
  relationships: { from: string; to: string; type: string; words: string; quote: string }[]
  continuity: { entry: string; problem: string; quote: string }[]
  questions: { question: string; quote: string }[]
}

/** The AI's JSON, read forgivingly (a code fence or a line around it is fine). Null if unreadable. */
export function parseFindings(reply: string): RawFindings | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: unknown
  try {
    data = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  const str = (v: unknown) =>
    typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
  const list = <T>(key: string, map: (o: Record<string, unknown>) => T): T[] =>
    Array.isArray(d[key])
      ? (d[key] as unknown[])
          .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
          .map(map)
      : []
  return {
    summary: str(d['summary']),
    new: list('new', (o) => ({
      name: str(o['name']),
      kind: str(o['kind']).toLowerCase(),
      about: str(o['about']),
      quote: str(o['quote']),
    })),
    facts: list('facts', (o) => ({
      entry: str(o['entry']),
      field: str(o['field']),
      value: str(o['value']),
      quote: str(o['quote']),
    })),
    relationships: list('relationships', (o) => ({
      from: str(o['from']),
      to: str(o['to']),
      type: str(o['type']).toLowerCase(),
      words: str(o['words']),
      quote: str(o['quote']),
    })),
    continuity: list('continuity', (o) => ({
      entry: str(o['entry']),
      problem: str(o['problem']),
      quote: str(o['quote']),
    })),
    questions: list('questions', (o) => ({ question: str(o['question']), quote: str(o['quote']) })),
  }
}

/* ---------- checking it against the world ---------- */

export type Finding = Pick<InboxItem, 'kind' | 'text' | 'quote' | 'entryId' | 'suggestion' | 'undo'>

export interface WorldFacts {
  entries: EntrySummary[]
  templates: Template[]
  relationshipTypes: RelationshipType[]
  relationships: RelationshipFile[]
  /** Questions already answered (not asked again). */
  answered: string[]
}

export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()

/** Drops what doesn't check out; resolves names to entries and fields to templates. */
export function checkFindings(
  raws: RawFindings[],
  chapterText: string,
  world: WorldFacts,
): Finding[] {
  const text = norm(chapterText)
  const quoteOf = (q: string) => {
    const t = q.replace(/^["“”']+|["“”']+$/g, '').trim()
    return t.length >= 6 && text.includes(norm(t)) ? t.slice(0, 600) : null
  }
  const byName = new Map<string, EntrySummary>()
  for (const e of world.entries) {
    for (const n of [e.name, ...e.aliases]) {
      const k = norm(n)
      if (k && !byName.has(k)) byName.set(k, e)
    }
  }
  const find = (name: string): EntrySummary | undefined =>
    byName.get(norm(name)) ?? byName.get(norm(name.replace(/^the\s+/i, '')))
  const templateOf = (e: EntrySummary) =>
    world.templates.find((t) => t.id === e.template) ?? FALLBACK_TEMPLATE
  const typeOf = (t: string) =>
    world.relationshipTypes.find(
      (r) =>
        r.id.toLowerCase() === t ||
        norm(r.label) === norm(t) ||
        norm(r.label).startsWith(`${norm(t)} `),
    )

  const out: Finding[] = []
  const seen = new Set<string>()
  const add = (key: string, f: Finding) => {
    if (seen.has(key)) return
    seen.add(key)
    out.push(f)
  }

  for (const raw of raws) {
    for (const n of raw.new) {
      const kind = NEW_KINDS[n.kind]
      const name = n.name.replace(/\s+/g, ' ').trim()
      if (!kind || !name || name.length > 120 || find(name)) continue
      if (!world.templates.some((t) => t.id === kind.template)) continue
      if (!text.includes(norm(name))) continue // Not actually in the chapter.
      const suggestion: Suggestion = {
        type: 'new',
        name,
        template: kind.template,
        about: n.about.slice(0, 300),
      }
      add(`new:${norm(name)}`, {
        kind: 'suggestion',
        text: `New ${kind.label}: ${name}${n.about ? ` — ${n.about.slice(0, 300)}` : ''}`,
        quote: quoteOf(n.quote),
        entryId: null,
        suggestion,
      })
    }

    for (const f of raw.facts) {
      const entry = find(f.entry)
      const value = f.value.trim()
      if (!entry || !value || value.length > 200) continue
      const field = templateOf(entry).fields.find(
        (x) => norm(x.label) === norm(f.field) || x.id.toLowerCase() === f.field.toLowerCase(),
      )
      if (!field) continue
      const current = entry.facts[field.id] ?? []
      let suggestion: Suggestion
      let shown: string
      if (field.kind === 'link') {
        const target = find(value)
        if (!target || target.id === entry.id) continue
        if (current.at(-1)?.link === target.id) continue
        if (field.multiple && current.some((v) => v.link === target.id)) continue
        suggestion = { type: 'fact', entryId: entry.id, field: field.id, link: target.id }
        shown = target.name
      } else {
        if (current.some((v) => v.text && norm(v.text) === norm(value))) continue
        suggestion = { type: 'fact', entryId: entry.id, field: field.id, text: value }
        shown = value
      }
      add(`fact:${entry.id}:${field.id}:${norm(shown)}`, {
        kind: 'suggestion',
        text: `${entry.name}: ${field.label} → ${shown}`,
        quote: quoteOf(f.quote),
        entryId: entry.id,
        suggestion,
      })
    }

    for (const r of raw.relationships) {
      const a = find(r.from)
      const b = find(r.to)
      const type = typeOf(r.type)
      if (!a || !b || a.id === b.id || !type) continue
      const exists = world.relationships.some(
        (x) =>
          x.type === type.id &&
          ((x.from === a.id && x.to === b.id) || (x.from === b.id && x.to === a.id)),
      )
      if (exists) continue
      const [p, q] = [a.id, b.id].sort()
      const label = r.words.slice(0, 80)
      add(`rel:${p}:${q}:${type.id}`, {
        kind: 'suggestion',
        text: `${a.name} and ${b.name}: ${type.label}${label ? ` (${label})` : ''}`,
        quote: quoteOf(r.quote),
        entryId: a.id,
        suggestion: { type: 'relationship', from: a.id, to: b.id, relType: type.id, label },
      })
    }

    for (const c of raw.continuity) {
      const problem = c.problem.trim()
      if (!problem) continue
      const quote = quoteOf(c.quote)
      if (!quote) continue // A claim about the text must point at the text.
      add(`cont:${norm(problem)}`, {
        kind: 'continuity',
        text: problem.slice(0, 600),
        quote,
        entryId: find(c.entry)?.id ?? null,
      })
    }

    for (const q of raw.questions) {
      const question = q.question.trim()
      if (!question || world.answered.some((a) => norm(a) === norm(question))) continue
      add(`q:${norm(question)}`, {
        kind: 'question',
        text: question.slice(0, 600),
        quote: quoteOf(q.quote),
        entryId: null,
      })
    }
  }

  const count: Record<Finding['kind'], number> = {
    suggestion: 0,
    applied: 0,
    continuity: 0,
    question: 0,
    captured: 0,
  }
  const max: Record<Finding['kind'], number> = {
    suggestion: LIMITS.suggestions,
    applied: 0,
    continuity: LIMITS.continuity,
    question: LIMITS.questions,
    captured: 0,
  }
  return out.filter((f) => ++count[f.kind] <= max[f.kind])
}

/** Splits a chapter's paragraphs into parts of about `words` words. */
export function chapterParts(paragraphs: string[], words: number): string[] {
  const parts: string[][] = [[]]
  let count = 0
  for (const p of paragraphs) {
    const n = p.split(/\s+/).filter(Boolean).length
    if (count > 0 && count + n > words) {
      parts.push([])
      count = 0
    }
    parts[parts.length - 1]!.push(p)
    count += n
  }
  return parts.map((p) => p.join('\n\n')).filter((p) => p.trim())
}

/* ---------- sorting new names ---------- */

/** Asks what each name is (or that it's not one for the world). */
export function sortNamesMessages(names: { name: string; quote: string }[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `These capitalised words keep coming up in a novel. For each, say what it is in the story's world, from the sentence it's in. Reply with JSON only: {"names":[{"name":"","kind":"","about":""}]}
kind is one of: ${Object.keys(NEW_KINDS).join(', ')}, or none (${KIND_GUIDE}).
Use none for anything that isn't something in the world: real holidays and festivals (like Halloween or Christmas), days, months, seasons, languages, titles or forms of address on their own, exclamations, ordinary words at the start of a sentence. A holiday or festival made up for the story is an event.
about: one short line from the sentence (leave it empty for none). Keep each name exactly as given.`,
    },
    {
      role: 'user',
      content: names.map((n) => `${n.name}: “${n.quote}”`).join('\n'),
    },
  ]
}

/** The AI's sorting, read forgivingly: name → kind (a NEW_KINDS key or 'none') and a line about it. */
export function parseSortedNames(reply: string): Map<string, { kind: string; about: string }> {
  const out = new Map<string, { kind: string; about: string }>()
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return out
  try {
    const data = JSON.parse(reply.slice(start, end + 1)) as { names?: unknown }
    for (const x of Array.isArray(data.names) ? data.names : []) {
      if (!x || typeof x !== 'object') continue
      const o = x as Record<string, unknown>
      const name = typeof o['name'] === 'string' ? o['name'].trim() : ''
      const kind = typeof o['kind'] === 'string' ? o['kind'].trim().toLowerCase() : ''
      if (!name || (kind !== 'none' && !NEW_KINDS[kind])) continue
      out.set(norm(name), { kind, about: typeof o['about'] === 'string' ? o['about'].trim() : '' })
    }
  } catch {
    // Unreadable: nothing sorted.
  }
  return out
}
