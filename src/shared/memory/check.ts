/**
 * Checking General ideas against the page. The page is what's true: when a
 * chapter puts an unfixed idea on the page, it's suggested as fixed; when a
 * chapter goes against an idea, that's flagged; when a chapter sets up
 * something new worth keeping as an idea, it's suggested. Nothing changes
 * until the writer ticks it. (Nothing flows the other way: the world never
 * reads ideas.)
 */
import { z } from 'zod'
import { newId } from '../ids'
import type { MemoryNodeFile, MemorySource } from '../schema'
import { samePoint } from './build'
import type { TidyKeys } from './tidy'

/** One suggestion from checking a chapter, waiting for the writer. */
export type IdeaCheck = {
  id: string
  chapterId: string
  chapterTitle: string
  at: string
  /** A few exact words from the chapter. */
  quote: string
} & (
  | {
      /** An unfixed idea (or whim) is now on the page: mark it fixed. */
      kind: 'onPage'
      nodeId: string
      pointId: string
      topic: string
      text: string
    }
  | {
      /** The chapter goes against an idea: mark it rejected (kept, hidden from the AI). */
      kind: 'contradicted'
      nodeId: string
      pointId: string
      topic: string
      text: string
      why: string
    }
  | {
      /** Something the chapter sets up that isn't an idea yet: add it (fixed: it's on the page). */
      kind: 'fresh'
      /** The topic it goes in; null with a title for a new topic, or Loose ends. */
      nodeId: string | null
      topic: string
      loose: boolean
      text: string
    }
)

export const ideaChecksFileSchema = z.looseObject({
  formatVersion: z.literal(1),
  checks: z.array(z.looseObject({ id: z.string(), kind: z.string() })),
})

const key = z.string().max(40).catch('')
const quote = z.string().max(600).catch('')
const chapter = z.string().max(20).catch('')
const replySchema = z.object({
  onPage: z
    .array(z.object({ point: key, chapter, quote }))
    .catch([])
    .default([]),
  contradicted: z
    .array(z.object({ point: key, chapter, why: z.string().max(400).catch(''), quote }))
    .catch([])
    .default([]),
  new: z
    .array(
      z.object({
        node: key,
        title: z.string().max(200).catch(''),
        text: z.string().trim().min(1).max(2000),
        chapter,
        quote,
      }),
    )
    .catch([])
    .default([]),
})

/**
 * What the AI is asked about one or more chapters (C1, C2… in story order).
 * `memory` is tidyText's view (topics with keys).
 */
export function checkMessages(input: {
  storyName: string
  memory: string
  chapters: { title: string; text: string }[]
}): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: `You check a writer's General ideas for their story “${input.storyName}” against chapters they've written (C1, C2…, in story order). The ideas are what they worked out in conversations: topics (T1, T2…) with points (P1, P2…), each fixed (decided), unfixed (a proposal) or whim (a passing thought). The chapters are what's true now; a later chapter wins over an earlier one.

Say three things, each only when a chapter clearly shows it (most chapters give few or none):
- onPage: an unfixed or whim point the chapter actually puts on the page (it happens or is established there, not just mentioned).
- contradicted: a point the chapter clearly goes against, with why (one sentence).
- new: an idea the chapter sets up that matters for the story going forward and isn't in the ideas yet: a plot thread opened, a promise or mystery planted, a turn in a relationship, a rule of how things work. Not plain facts about people, places and things (the world keeps those). "node": the topic's key it belongs in; or "" with a short "title" for a new topic; or "LOOSE" when it fits nothing. At most 5.

For each, give the chapter's key as "chapter" and a few exact words from it as "quote". Use only the keys given. Reply ONLY with JSON: {"onPage":[{"point":"P3","chapter":"C1","quote":"…"}],"contradicted":[{"point":"P5","chapter":"C2","why":"…","quote":"…"}],"new":[{"node":"T2","title":"","text":"…","chapter":"C1","quote":"…"}]}

The ideas:
${input.memory || '(none yet)'}`,
    },
    {
      role: 'user',
      content: input.chapters
        .map((c, i) => `C${i + 1}: the chapter “${c.title}”\n<<<\n${c.text}\n>>>`)
        .join('\n\n'),
    },
  ]
}

/** The AI's reply as suggestions for the writer (ones that don't fit what's there are dropped). */
export function parseCheck(
  reply: string,
  keys: TidyKeys,
  nodes: MemoryNodeFile[],
  chapters: { id: string; title: string }[],
  at: string,
): IdeaCheck[] {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let data: z.infer<typeof replySchema>
  try {
    const r = replySchema.safeParse(JSON.parse(reply.slice(start, end + 1)))
    if (!r.success) return []
    data = r.data
  } catch {
    return []
  }
  const base = (k: string) => {
    const c = chapters[Number(/^C(\d+)$/i.exec(k.trim())?.[1] ?? 1) - 1] ?? chapters[0]!
    return { chapterId: c.id, chapterTitle: c.title, at }
  }
  const pointAt = (k: string) => {
    const pointId = keys.point.get(k.trim())
    if (!pointId) return null
    for (const n of nodes) {
      const p = n.points.find((x) => x.id === pointId)
      if (p) return { n, p }
    }
    return null
  }
  const out: IdeaCheck[] = []
  const seen = new Set<string>()
  for (const s of data.onPage) {
    const hit = pointAt(s.point)
    if (!hit || hit.p.state === 'fixed' || hit.p.state === 'rejected' || seen.has(hit.p.id))
      continue
    seen.add(hit.p.id)
    out.push({
      ...base(s.chapter),
      id: newId('check'),
      quote: s.quote,
      kind: 'onPage',
      nodeId: hit.n.id,
      pointId: hit.p.id,
      topic: hit.n.title,
      text: hit.p.text,
    })
  }
  for (const s of data.contradicted) {
    const hit = pointAt(s.point)
    if (!hit || hit.p.state === 'rejected' || seen.has(hit.p.id)) continue
    seen.add(hit.p.id)
    out.push({
      ...base(s.chapter),
      id: newId('check'),
      quote: s.quote,
      kind: 'contradicted',
      nodeId: hit.n.id,
      pointId: hit.p.id,
      topic: hit.n.title,
      text: hit.p.text,
      why: s.why,
    })
  }
  for (const s of data.new.slice(0, 5)) {
    const k = s.node.trim()
    const loose = k.toUpperCase() === 'LOOSE'
    const id = loose ? undefined : keys.node.get(k)
    const node = id ? nodes.find((n) => n.id === id && n.state !== 'rejected') : undefined
    if (!node && !loose && !s.title.trim()) continue
    if (node?.points.some((p) => samePoint(p.text, s.text))) continue
    out.push({
      ...base(s.chapter),
      id: newId('check'),
      quote: s.quote,
      kind: 'fresh',
      nodeId: node?.id ?? null,
      topic: node?.title ?? (loose ? 'Loose ends' : s.title.trim()),
      loose: loose && !node,
      text: s.text,
    })
  }
  return out
}

/** The same suggestion again (from checking the chapter twice) counts once. */
export function sameCheck(a: IdeaCheck, b: IdeaCheck): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'fresh' && b.kind === 'fresh') return samePoint(a.text, b.text)
  return 'pointId' in a && 'pointId' in b && a.pointId === b.pointId
}

/** Makes the changes the writer ticked; those that no longer fit are skipped. */
export function applyChecks(
  nodes: MemoryNodeFile[],
  picked: IdeaCheck[],
  at: string,
): { save: MemoryNodeFile[]; applied: number } {
  const all = new Map(nodes.map((n) => [n.id, structuredClone(n)]))
  const changed = new Set<string>()
  let applied = 0
  const note = (n: MemoryNodeFile, what: string) => {
    n.history.push({ at, by: 'ai', what })
    n.updatedAt = at
    changed.add(n.id)
  }
  const make = (title: string, loose: boolean): MemoryNodeFile => {
    const n: MemoryNodeFile = {
      formatVersion: 1,
      id: newId('node'),
      title: title.slice(0, 200),
      state: loose ? 'unfixed' : 'fixed',
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
    return n
  }
  const norm = (s: string) => s.trim().toLowerCase()
  for (const c of picked) {
    const source: MemorySource & { chapterId: string } = {
      conversationId: '',
      chapterId: c.chapterId,
      title: `Chapter “${c.chapterTitle}”`,
      at,
      quote: c.quote,
    }
    if (c.kind === 'fresh') {
      let to = c.nodeId ? all.get(c.nodeId) : undefined
      if (to?.state === 'rejected') to = undefined
      if (!to && c.loose) to = [...all.values()].find((n) => n.loose) ?? make('Loose ends', true)
      if (!to)
        to =
          [...all.values()].find(
            (n) => !n.loose && n.state !== 'rejected' && norm(n.title) === norm(c.topic),
          ) ?? make(c.topic || 'From the page', false)
      if (to.points.some((p) => samePoint(p.text, c.text))) continue
      to.points.push({
        id: newId('point'),
        text: c.text,
        state: 'fixed',
        sources: [source],
        createdAt: at,
        updatedAt: at,
      })
      note(to, `From the page in “${c.chapterTitle}”: added “${c.text.slice(0, 80)}” (fixed)`)
      applied++
      continue
    }
    const n = all.get(c.nodeId)
    const p = n?.points.find((x) => x.id === c.pointId)
    if (!n || !p) continue
    const to = c.kind === 'onPage' ? 'fixed' : 'rejected'
    if (p.state === to) continue
    const was = p.state
    p.state = to
    p.updatedAt = at
    p.sources = [...p.sources, source]
    note(
      n,
      c.kind === 'onPage'
        ? `On the page in “${c.chapterTitle}”: “${p.text.slice(0, 60)}” ${was} → fixed`
        : `The page went another way in “${c.chapterTitle}”: “${p.text.slice(0, 60)}” ${was} → rejected${c.why ? ` (${c.why})` : ''}`,
    )
    applied++
  }
  return { save: [...changed].map((id) => all.get(id)!), applied }
}
