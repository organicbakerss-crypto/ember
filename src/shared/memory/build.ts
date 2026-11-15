/**
 * "Make nodes": reading conversations into the story's memory.
 *
 * A conversation is read in parts. For each part the AI says whether it fits
 * the writer's instruction (else why not: the part is listed as skipped, never
 * lost) and which topics (nodes) and points it holds, with a state for each:
 * fixed (decided), unfixed (proposed), whim (a thin idea kept anyway) or
 * rejected (turned down). Parts are merged into one draft as they come; the
 * writer looks at the draft before any of it is kept.
 */
import { z } from 'zod'
import { newId } from '../ids'
import type {
  ConversationMessage,
  MemoryNodeFile,
  MemoryPoint,
  MemorySource,
  MemoryState,
} from '../schema'

export const MEMORY_STATES: MemoryState[] = ['fixed', 'unfixed', 'whim', 'rejected']

export interface DraftPoint {
  text: string
  state: MemoryState
  source: MemorySource
  /** How its state changed while reading ("unfixed → fixed"). */
  changed?: string
}

export interface DraftNode {
  /** An existing node's id, or "new:<title>" for one the build made. */
  key: string
  existingId: string | null
  title: string
  state: MemoryState
  summary: string
  /** The book's name as the AI gave it (matched to a book when kept). */
  book: string | null
  points: DraftPoint[]
  /** Topics it's related to (keys or titles, as the AI gave them): links when kept. */
  related?: string[]
}

export interface DraftPart {
  index: number
  firstAt: string
  lastAt: string
  words: number
  status: 'pending' | 'used' | 'skipped' | 'failed'
  /** Why it was skipped (or what went wrong). */
  reason: string
  /** The start of the part, for the writer to check a skip. */
  preview: string
  /** Pass 1: which story or project the part is about (the AI's label), and what's in it. */
  label?: string
  about?: string
  names?: string[]
  /** Whether it's about the writer's story (the AI's call, or the writer's when they changed it). */
  mine?: boolean
  mineByWriter?: boolean
}

export interface MemoryDraft {
  seriesId: string
  instruction: string
  conversationIds: string[]
  from: string | null
  to: string | null
  /** Parts the writer asked to include even though they were skipped. */
  forcedParts: number[]
  /** What the writer said about their story, to tell it apart ("Josh, Rodney, a heist…"). */
  clues?: string
  /**
   * sorting: pass 1 (what each part is about); sorted: waiting for the writer
   * to check which parts are theirs; reading: pass 2 (making nodes).
   */
  phase?: 'sorting' | 'sorted' | 'reading'
  /** Pass 1's picture of the writer's story, given to pass 2. */
  identity?: string
  parts: DraftPart[]
  nodes: DraftNode[]
  loose: DraftPoint[]
  state: 'running' | 'done' | 'stopped' | 'failed'
  error: string | null
  createdAt: string
  updatedAt: string
}

/** A message of the conversations being read, with where it's from. */
export interface SourceMessage extends Pick<ConversationMessage, 'role' | 'content' | 'at'> {
  conversationId: string
  title: string
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** Messages cut into parts of about `size` words (a long message is its own part). */
export function cutParts(messages: SourceMessage[], size: number): SourceMessage[][] {
  const parts: SourceMessage[][] = []
  let current: SourceMessage[] = []
  let count = 0
  for (const m of messages) {
    const n = words(m.content)
    if (count + n > size && current.length) {
      parts.push(current)
      current = []
      count = 0
    }
    current.push(m)
    count += n
  }
  if (current.length) parts.push(current)
  return parts
}

/** The part as the AI reads it. */
export function partText(part: SourceMessage[]): string {
  return part
    .map(
      (m) => `[${m.role === 'user' ? 'Writer' : 'Assistant'}, ${m.at.slice(0, 10)}]\n${m.content}`,
    )
    .join('\n\n')
}

/* ---------- what the AI is asked, and what it answers ---------- */

const stateField = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.enum(['fixed', 'unfixed', 'whim', 'rejected']))
  .catch('unfixed')

const replyPoint = z.object({
  text: z.string().trim().min(1).max(2000),
  state: stateField,
  quote: z.string().max(600).catch('').default(''),
})

const replySchema = z.object({
  relevant: z.boolean().catch(true),
  reason: z.string().max(400).catch('').default(''),
  nodes: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((all) =>
      all.flatMap((x) => {
        const r = z
          .object({
            node: z.string().trim().max(200).catch('').default(''),
            title: z.string().trim().max(200).catch('').default(''),
            state: stateField,
            summary: z.string().max(2000).catch('').default(''),
            book: z.string().max(200).nullable().catch(null).default(null),
            related: z.array(z.string().max(200)).max(20).catch([]).default([]),
            points: z
              .array(z.unknown())
              .catch([])
              .default([])
              .transform((ps) =>
                ps.flatMap((p) => {
                  const q = replyPoint.safeParse(p)
                  return q.success ? [q.data] : []
                }),
              ),
          })
          .safeParse(x)
        return r.success && (r.data.title || r.data.node) ? [r.data] : []
      }),
    ),
  loose: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((ps) =>
      ps.flatMap((p) => {
        const q = replyPoint.safeParse(p)
        return q.success ? [q.data] : []
      }),
    ),
})
export type PartReply = z.infer<typeof replySchema>

/** The AI's answer for a part, or null when it isn't JSON of the right shape. */
export function parsePartReply(text: string): PartReply | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const r = replySchema.safeParse(JSON.parse(text.slice(start, end + 1)))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

export const STATE_RULES = `States (for a topic and for each point):
- fixed: the writer settled it (agreed, decided, or it's in the story).
- unfixed: proposed (by either of you) and not settled yet. Ideas only the assistant raised, which the writer didn't take up, are unfixed at most.
- whim: an idea the writer floated without much backing but wanted to keep ("just a thought", "maybe someday").
- rejected: the writer turned it down.
Later in the conversation wins: if something was proposed and later agreed, it's fixed; if a fixed thing was later changed, the old version is rejected and the new one fixed.`

/** The messages that ask the AI to read one part. */
export function partMessages(input: {
  instruction: string
  storyName: string
  books: string[]
  names: string[]
  known: { key: string; title: string; state: MemoryState; summary: string }[]
  part: SourceMessage[]
  index: number
  total: number
  /** The writer asked for this part to be read even though it looked off-topic. */
  forced: boolean
  /** Pass 1's picture of the writer's story (and their own clues). */
  identity?: string
}): { role: 'system' | 'user'; content: string }[] {
  const known = input.known.length
    ? input.known
        .map((k) => `- ${k.key} | ${k.title} | ${k.state} | ${k.summary.slice(0, 160)}`)
        .join('\n')
    : '(none yet)'
  return [
    {
      role: 'system',
      content: `You keep the story memory for a writer: topics ("nodes") from their conversations about their story, each holding specific points. You're reading part ${input.index + 1} of ${input.total} of their conversations.

The story: “${input.storyName}”${input.books.length > 1 ? ` (books: ${input.books.join(', ')})` : ''}.
Names in its world: ${input.names.slice(0, 200).join(', ') || '(none listed)'}.

The writer's instruction for what to take: «${input.instruction || 'everything about this story'}»
${input.identity ? `What the writer's story is (worked out from the whole conversation): ${input.identity}\n` : ''}
${input.forced ? 'The writer asked for this part to be read even if it looks off-topic: take whatever in it fits the instruction.' : 'A conversation may cover other stories or other things entirely. If nothing in this part fits the instruction, reply {"relevant":false,"reason":"…one short sentence…","nodes":[],"loose":[]}.'}

Topics already in the memory (key | title | state | summary). Add to one of these when the part is about it (use its key in "node"); make a new one only for a new topic:
${known}

${STATE_RULES}

A topic is something you'd look up later: a character, a place, an object, a plot thread, a scene, a rule of the world, how the writer likes to work. Points are specific and self-contained (they make sense on their own, with names, not "he" or "that idea"). Don't repeat a point the topic already has unless its state changed. Keep the writer's own ideas and wording; don't invent anything. Things that fit the instruction but no topic go in "loose".

Reply ONLY with JSON:
{"relevant":true,"reason":"","nodes":[{"node":"existing key, or empty for new","title":"short topic name","state":"fixed|unfixed|whim|rejected","summary":"one or two sentences: where this topic stands now","book":"book name or null","related":["keys or titles of other topics it's connected to (the same characters, plot thread, object, scene)"],"points":[{"text":"…","state":"fixed|unfixed|whim|rejected","quote":"a few exact words from the part it comes from"}]}],"loose":[{"text":"…","state":"…","quote":"…"}]}`,
    },
    { role: 'user', content: partText(input.part) },
  ]
}

/* ---------- merging ---------- */

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** The same point said again (nearly the same words). */
export function samePoint(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y || (x.length > 30 && y.includes(x)) || (y.length > 30 && x.includes(y))) return true
  const xs = new Set(x.split(' '))
  const ys = new Set(y.split(' '))
  let both = 0
  for (const w of xs) if (ys.has(w)) both++
  return both / (xs.size + ys.size - both) >= 0.75
}

/** Where a quote is in the part: the latest message saying it (else the part's first). */
export function sourceOf(part: SourceMessage[], quote: string): MemorySource {
  const q = norm(quote)
  const hit = (q.length >= 8 && part.findLast((m) => norm(m.content).includes(q))) || part[0]!
  return {
    conversationId: hit.conversationId,
    title: hit.title,
    at: hit.at,
    quote: quote.slice(0, 600),
  }
}

function addPoints(into: DraftPoint[], points: PartReply['loose'], part: SourceMessage[]): void {
  for (const p of points) {
    const same = into.find((x) => samePoint(x.text, p.text))
    if (same) {
      // Later in the conversation wins.
      if (same.state !== p.state) {
        same.changed = `${same.changed ? `${same.changed.split(' → ')[0]}` : same.state} → ${p.state}`
        same.state = p.state
        same.source = sourceOf(part, p.quote || p.text)
      }
      continue
    }
    into.push({ text: p.text, state: p.state, source: sourceOf(part, p.quote || p.text) })
  }
}

/** Adds what the AI found in one part to the draft. */
export function mergePart(
  draft: MemoryDraft,
  reply: PartReply,
  part: SourceMessage[],
  existing: MemoryNodeFile[],
): void {
  for (const n of reply.nodes) {
    const title = n.title || n.node
    const byKey =
      draft.nodes.find((d) => d.key === n.node) ??
      draft.nodes.find((d) => norm(d.title) === norm(title))
    const saved =
      existing.find((e) => e.id === n.node) ??
      existing.find((e) => !e.loose && norm(e.title) === norm(title))
    let node = byKey ?? (saved ? draft.nodes.find((d) => d.existingId === saved.id) : undefined)
    if (!node) {
      node = {
        key: saved ? saved.id : `new:${norm(title)}`,
        existingId: saved?.id ?? null,
        title: saved?.title ?? title,
        state: n.state,
        summary: n.summary,
        book: n.book,
        points: [],
        related: [],
      }
      draft.nodes.push(node)
    } else {
      node.state = n.state
      if (n.summary) node.summary = n.summary
      if (n.book) node.book = n.book
    }
    addPoints(node.points, n.points, part)
    for (const r of n.related) {
      if (!r.trim() || norm(r) === norm(node.title) || r === node.key) continue
      node.related ??= []
      if (!node.related.some((x) => norm(x) === norm(r))) node.related.push(r.trim())
    }
  }
  addPoints(draft.loose, reply.loose, part)
}

/* ---------- keeping a draft ---------- */

const now = () => new Date().toISOString()

function toPoints(points: DraftPoint[], at: string): MemoryPoint[] {
  return points.map((p) => ({
    id: newId('point'),
    text: p.text,
    state: p.state,
    sources: [p.source],
    createdAt: at,
    updatedAt: at,
  }))
}

function mergeInto(node: MemoryNodeFile, points: DraftPoint[], at: string): number {
  let added = 0
  for (const p of points) {
    const same = node.points.find((x) => samePoint(x.text, p.text))
    if (same) {
      if (same.state !== p.state) {
        same.state = p.state
        same.updatedAt = at
      }
      if (
        !same.sources.some(
          (s) => s.conversationId === p.source.conversationId && s.at === p.source.at,
        )
      )
        same.sources.push(p.source)
      continue
    }
    node.points.push(...toPoints([p], at))
    added++
  }
  return added
}

/**
 * The nodes to save for a draft: existing ones with the new points added
 * (nothing of theirs removed), new ones made, loose points into "Loose ends".
 */
export function keepDraft(
  draft: MemoryDraft,
  existing: MemoryNodeFile[],
  books: { id: string; name: string }[],
  only?: Set<string>,
): MemoryNodeFile[] {
  const at = now()
  const out = new Map<string, MemoryNodeFile>()
  const what = `Added by Make nodes (${draft.instruction.slice(0, 120) || 'everything'})`
  const bookId = (name: string | null) =>
    (name && books.find((b) => norm(b.name) === norm(name))?.id) || null
  for (const d of draft.nodes) {
    if (only && !only.has(d.key)) continue
    const base = d.existingId ? existing.find((e) => e.id === d.existingId) : undefined
    if (base) {
      const node = structuredClone(base)
      const added = mergeInto(node, d.points, at)
      if (d.summary) node.summary = d.summary
      node.state = d.state
      node.updatedAt = at
      node.history.push({ at, by: 'ai', what: `${what}: ${added} new points` })
      out.set(node.id, node)
      continue
    }
    const id = newId('node')
    out.set(id, {
      formatVersion: 1,
      id,
      title: d.title.slice(0, 200),
      state: d.state,
      summary: d.summary,
      volumeId: bookId(d.book),
      entryIds: [],
      links: [],
      parentId: null,
      loose: false,
      pos: null,
      points: toPoints(d.points, at),
      history: [{ at, by: 'ai', what }],
      createdAt: at,
      updatedAt: at,
    })
  }
  // Related topics become links (to topics kept now or already in the memory).
  const idOf = new Map<string, string>()
  for (const d of draft.nodes) {
    const kept =
      d.existingId ??
      [...out.values()].find((n) => n.title === d.title.slice(0, 200) && !n.loose)?.id
    if (!kept || !out.has(kept)) continue
    idOf.set(d.key, kept)
    idOf.set(norm(d.title), kept)
  }
  for (const e of existing) if (!e.loose && e.state !== 'rejected') idOf.set(e.id, e.id)
  for (const e of existing)
    if (!e.loose && e.state !== 'rejected' && !idOf.has(norm(e.title)))
      idOf.set(norm(e.title), e.id)
  for (const d of draft.nodes) {
    const from = idOf.get(d.key)
    const node = from ? out.get(from) : undefined
    if (!node) continue
    for (const r of d.related ?? []) {
      const to = idOf.get(r) ?? idOf.get(norm(r))
      if (!to || to === node.id) continue
      const other = out.get(to) ?? existing.find((e) => e.id === to)
      if (node.links.includes(to) || other?.links.includes(node.id)) continue
      node.links.push(to)
    }
  }
  if (draft.loose.length && (!only || only.has('loose'))) {
    const base = existing.find((e) => e.loose)
    const node: MemoryNodeFile = base
      ? structuredClone(base)
      : {
          formatVersion: 1,
          id: newId('node'),
          title: 'Loose ends',
          state: 'unfixed',
          summary: 'Things that fit no topic yet.',
          volumeId: null,
          entryIds: [],
          links: [],
          parentId: null,
          loose: true,
          pos: null,
          points: [],
          history: [],
          createdAt: at,
          updatedAt: at,
        }
    const added = mergeInto(node, draft.loose, at)
    node.updatedAt = at
    node.history.push({ at, by: 'ai', what: `${what}: ${added} new points` })
    out.set(node.id, node)
  }
  return [...out.values()]
}

/* ---------- pass 1: sorting the conversation by story ---------- */

/** Labels seen so far, with a few of their names, so the AI keeps using the same ones. */
export function knownLabels(parts: DraftPart[]): string {
  const by = new Map<string, Set<string>>()
  for (const p of parts) {
    if (!p.label) continue
    const names = by.get(p.label) ?? new Set<string>()
    for (const n of p.names ?? []) if (names.size < 12) names.add(n)
    by.set(p.label, names)
  }
  return [...by].map(([label, names]) => `- ${label}: ${[...names].join(', ')}`).join('\n')
}

/** Pass 1 for one part: which story or project it's about, and the names in it. */
export function sortMessages(input: {
  part: SourceMessage[]
  index: number
  total: number
  labels: string
}): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: `You're sorting a long conversation between a writer and an assistant by what each part is about. A conversation like this can cover several of the writer's stories, other projects, or nothing in particular. This is part ${input.index + 1} of ${input.total}.

Give the part a short label for the story or project it's about, reusing a label below when it's the same one (the same characters, places or plot, even if a title isn't mentioned). Make a new label only for something new. Use "general" for talk that isn't about any story (writing advice, the app, small talk).

Labels so far (with names seen in them):
${input.labels || '(none yet)'}

Reply ONLY with JSON: {"label":"…","about":"one short line: what this part is about","names":["character, place and thing names in it"]}`,
    },
    { role: 'user', content: partText(input.part) },
  ]
}

const sortSchema = z.object({
  label: z.string().trim().min(1).max(80),
  about: z.string().max(300).catch('').default(''),
  names: z.array(z.string().trim().min(1).max(80)).max(40).catch([]).default([]),
})

export function parseSort(text: string): z.infer<typeof sortSchema> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const r = sortSchema.safeParse(JSON.parse(text.slice(start, end + 1)))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** Pass 1, at the end: with the whole conversation sorted, which labels are the writer's story. */
export function identifyMessages(input: {
  instruction: string
  clues: string
  storyName: string
  books: string[]
  /** Names from the story's chapters and world. */
  names: string[]
  labels: { label: string; parts: number; names: string[]; about: string[] }[]
}): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: `A writer's long conversation has been sorted into labelled stretches. Decide which labels are about the story the writer wants: they may be the same story under different labels (one from before it had a name, say).

The writer wants: «${input.instruction || 'everything about this story'}»
The story in their writing app is called “${input.storyName}”${input.books.length > 1 ? ` (books: ${input.books.join(', ')})` : ''}.
${input.clues ? `What the writer says about it: ${input.clues}\n` : ''}Names in its chapters and world: ${input.names.slice(0, 150).join(', ') || '(none yet)'}

Reply ONLY with JSON: {"identity":"a few sentences: what the writer's story is, its main characters, places and things, so someone could recognise a passage about it","labels":{"label":true or false}}`,
    },
    {
      role: 'user',
      content: input.labels
        .map(
          (l) =>
            `${l.label} (${l.parts} parts) — names: ${l.names.slice(0, 25).join(', ')} — about: ${l.about.slice(0, 6).join(' / ')}`,
        )
        .join('\n'),
    },
  ]
}

const identifySchema = z.object({
  identity: z.string().max(3000).catch('').default(''),
  labels: z.record(z.string(), z.boolean().catch(false)).catch({}),
})

export function parseIdentify(text: string): z.infer<typeof identifySchema> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const r = identifySchema.safeParse(JSON.parse(text.slice(start, end + 1)))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

/** Every label with how many parts, its names and what it's about (for the identify step). */
export function labelSummary(
  parts: DraftPart[],
): { label: string; parts: number; names: string[]; about: string[] }[] {
  const by = new Map<
    string,
    { label: string; parts: number; names: Set<string>; about: string[] }
  >()
  for (const p of parts) {
    if (!p.label) continue
    const x = by.get(p.label) ?? { label: p.label, parts: 0, names: new Set(), about: [] }
    x.parts++
    for (const n of p.names ?? []) x.names.add(n)
    if (p.about && x.about.length < 8) x.about.push(p.about)
    by.set(p.label, x)
  }
  return [...by.values()]
    .sort((a, b) => b.parts - a.parts)
    .map((x) => ({ ...x, names: [...x.names] }))
}

/** Runs of neighbouring parts with the same label, for the writer to check as a timeline. */
export function stretches(
  parts: DraftPart[],
): { label: string; mine: boolean; from: number; to: number; firstAt: string; lastAt: string }[] {
  const out: ReturnType<typeof stretches> = []
  for (const p of parts) {
    const label = p.label ?? '(not sorted)'
    const last = out[out.length - 1]
    if (last && last.label === label && last.mine === !!p.mine) {
      last.to = p.index
      last.lastAt = p.lastAt
    } else
      out.push({
        label,
        mine: !!p.mine,
        from: p.index,
        to: p.index,
        firstAt: p.firstAt,
        lastAt: p.lastAt,
      })
  }
  return out
}
