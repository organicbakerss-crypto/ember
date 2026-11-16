/**
 * Keeping the story memory up to date as the writer talks: after each answer
 * the AI reads that exchange and says what to change: new points (in a
 * topic, a new topic, or loose ends), states the writer's words settled
 * ("yes, do that" fixes a proposal; "no" rejects it), links between topics
 * the exchange connects, and summaries that moved on. Nothing needs asking
 * for; every change is listed on its topic and can be undone.
 */
import { z } from 'zod'
import { newId } from '../ids'
import type { MemoryNodeFile, MemorySource, MemoryState } from '../schema'
import { samePoint, STATE_RULES } from './build'
import type { TidyKeys } from './tidy'

const stateField = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.enum(['fixed', 'unfixed', 'whim', 'rejected']))

const updateSchema = z.object({
  points: z
    .array(
      z.object({
        node: z.string().max(200).catch(''),
        title: z.string().max(200).catch(''),
        text: z.string().trim().min(1).max(2000),
        state: stateField.catch('unfixed'),
        quote: z.string().max(600).catch(''),
      }),
    )
    .catch([])
    .default([]),
  states: z
    .array(z.object({ point: z.string(), state: stateField, why: z.string().max(300).catch('') }))
    .catch([])
    .default([]),
  links: z
    .array(z.object({ a: z.string(), b: z.string() }))
    .catch([])
    .default([]),
  summaries: z
    .array(z.object({ node: z.string(), summary: z.string().max(2000) }))
    .catch([])
    .default([]),
})
export type MemoryUpdateReply = z.infer<typeof updateSchema>

export function parseUpdate(text: string): MemoryUpdateReply | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const r = updateSchema.safeParse(JSON.parse(text.slice(start, end + 1)))
    return r.success ? r.data : null
  } catch {
    return null
  }
}

const clip = (s: string, words: number) => {
  const all = s.split(/\s+/)
  return all.length > words ? `${all.slice(0, words).join(' ')} …` : s
}

/**
 * What the AI is asked about something the writer hands it for their ideas:
 * a block from a ChatGPT chat, their plot, notes (in parts when it's long).
 */
export function handedMessages(input: {
  storyName: string
  memory: string
  name: string
  text: string
  instruction: string
  part: number
  parts: number
}): { role: 'system' | 'user'; content: string }[] {
  const system = updateMessages({ ...input, question: '', answer: '' })[0]!.content
  return [
    {
      role: 'system',
      content: system
        .replace(
          'as they talk with an AI about it.',
          'from things they hand you: a piece of a ChatGPT conversation, their plot, their notes.',
        )
        .replace(
          'After the exchange that follows, say what changed. Most exchanges change little or nothing: then reply with empty lists.',
          `Read what they handed you and say what to change: add everything worth keeping that isn't there yet, and update what it changes. In a conversation, the writer's own ideas and what they agreed to are fixed; the other side's suggestions they didn't take up are unfixed at most; what they turned down is rejected. In the writer's own plot or notes, what's stated as decided is fixed.${input.instruction.trim() ? ` The writer says: “${input.instruction.trim()}”. Follow that (leave out what it excludes).` : ''}`,
        ),
    },
    {
      role: 'user',
      content: `${input.parts > 1 ? `Part ${input.part} of ${input.parts} of ` : ''}“${input.name}”:\n<<<\n${input.text}\n>>>`,
    },
  ]
}

/** What the AI is asked after an exchange. `memory` is tidyText's view (topics with keys). */
export function updateMessages(input: {
  storyName: string
  memory: string
  question: string
  answer: string
}): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: `You keep the story memory for a writer's story “${input.storyName}” up to date as they talk with an AI about it. Below is the memory: topics (T1, T2…) and, for the topics that matter here, their points (P1, P2…). After the exchange that follows, say what changed. Most exchanges change little or nothing: then reply with empty lists.

${STATE_RULES}

What to give:
- points: new things worth keeping (decisions, ideas, facts about the story, how the writer likes to work). "node": the topic's key; or "" with a "title" for a new topic (only when nothing fits); or "LOOSE" when it fits no topic. Don't repeat what a topic already has. Only the writer's ideas and what they agreed to are fixed; the AI's own suggestions they didn't take up are unfixed at most.
- states: an existing point whose state the writer's words changed ("yes, let's do that": fixed; "no": rejected), with the reason.
- links: two topics this exchange connects (key pairs), when they aren't linked already.
- summaries: a topic whose short summary is now out of date: its new summary.

Use only the keys given. Reply ONLY with JSON: {"points":[{"node":"T3","title":"","text":"…","state":"fixed|unfixed|whim|rejected","quote":"a few exact words"}],"states":[{"point":"P5","state":"fixed","why":"…"}],"links":[{"a":"T1","b":"T4"}],"summaries":[{"node":"T3","summary":"…"}]}

The memory:
${input.memory || '(empty so far)'}`,
    },
    {
      role: 'user',
      content: `The writer said:\n<<<\n${clip(input.question, 3000)}\n>>>\n\nThe AI answered:\n<<<\n${clip(input.answer, 4000)}\n>>>`,
    },
  ]
}

export interface UpdateResult {
  /** Nodes to save (changed or new), as they'll be. */
  save: MemoryNodeFile[]
  /** Ids of nodes this made (an undo deletes them). */
  created: string[]
  /** What changed, in words, for the writer. */
  what: string[]
}

/** Makes the AI's changes (ones that no longer fit are skipped). */
export function applyUpdate(
  nodes: MemoryNodeFile[],
  reply: MemoryUpdateReply,
  keys: TidyKeys,
  source: MemorySource,
): UpdateResult {
  const at = source.at
  const all = new Map(nodes.map((n) => [n.id, structuredClone(n)]))
  const changed = new Set<string>()
  const created: string[] = []
  const what: string[] = []
  const note = (n: MemoryNodeFile, text: string) => {
    n.history.push({ at, by: 'ai', what: `From “${source.title}”: ${text}` })
    n.updatedAt = at
    changed.add(n.id)
  }
  const node = (key: string) => {
    const id = keys.node.get(key.trim())
    const n = id ? all.get(id) : undefined
    return n && n.state !== 'rejected' ? n : undefined
  }
  const make = (title: string, state: MemoryState, loose = false): MemoryNodeFile => {
    const n: MemoryNodeFile = {
      formatVersion: 1,
      id: newId('node'),
      title: title.slice(0, 200),
      state,
      summary: loose ? 'Things that fit no topic yet.' : '',
      volumeId: null,
      entryIds: [],
      links: [],
      parentId: null,
      loose,
      pos: null,
      points: [],
      history: [],
      createdAt: at,
      updatedAt: at,
    }
    all.set(n.id, n)
    created.push(n.id)
    return n
  }
  const norm = (s: string) => s.trim().toLowerCase()

  for (const p of reply.points) {
    let to: MemoryNodeFile | undefined
    if (p.node.trim().toUpperCase() === 'LOOSE') {
      to = [...all.values()].find((n) => n.loose) ?? make('Loose ends', 'unfixed', true)
    } else if (p.node.trim()) {
      to = node(p.node)
    }
    if (!to && p.title.trim()) {
      to =
        [...all.values()].find(
          (n) => !n.loose && n.state !== 'rejected' && norm(n.title) === norm(p.title),
        ) ??
        make(
          p.title.trim(),
          p.state === 'fixed' ? 'fixed' : p.state === 'whim' ? 'whim' : 'unfixed',
        )
    }
    if (!to || to.points.some((x) => samePoint(x.text, p.text))) continue
    to.points.push({
      id: newId('point'),
      text: p.text,
      state: p.state,
      sources: [{ ...source, quote: p.quote }],
      createdAt: at,
      updatedAt: at,
    })
    note(to, `added “${p.text.slice(0, 80)}” (${p.state})`)
    what.push(`added a point to “${to.title}”`)
  }
  for (const s of reply.states) {
    const pointId = keys.point.get(s.point.trim())
    if (!pointId) continue
    for (const n of all.values()) {
      const p = n.points.find((x) => x.id === pointId)
      if (!p || p.state === s.state) continue
      const was = p.state
      p.state = s.state
      p.updatedAt = at
      note(n, `“${p.text.slice(0, 60)}” ${was} → ${s.state}${s.why ? ` (${s.why})` : ''}`)
      what.push(`marked a point in “${n.title}” ${s.state}`)
    }
  }
  for (const l of reply.links) {
    const a = node(l.a)
    const b = node(l.b)
    if (!a || !b || a.id === b.id || a.loose || b.loose) continue
    if (a.links.includes(b.id) || b.links.includes(a.id)) continue
    a.links.push(b.id)
    note(a, `linked to “${b.title}”`)
    note(b, `linked to “${a.title}”`)
    what.push(`linked “${a.title}” and “${b.title}”`)
  }
  for (const s of reply.summaries) {
    const n = node(s.node)
    if (!n || !s.summary.trim() || n.summary === s.summary.trim()) continue
    n.summary = s.summary.trim()
    note(n, 'summary brought up to date')
  }
  return { save: [...changed].map((id) => all.get(id)!), created, what }
}

/** "added a point to “X”" ×3 → "added 3 points to “X”", for a short line under the answer. */
export function describeChanges(what: string[]): string {
  const counts = new Map<string, number>()
  for (const w of what) counts.set(w, (counts.get(w) ?? 0) + 1)
  return [...counts]
    .map(([w, n]) =>
      n > 1
        ? w
            .replace(/^added a point/, `added ${n} points`)
            .replace(/^marked a point/, `marked ${n} points`)
        : w,
    )
    .join('; ')
}
