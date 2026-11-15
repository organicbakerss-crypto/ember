/**
 * "Tidy up": the AI reviews the story's memory as it stands and suggests
 * links between related topics, merging topics that are the same thing,
 * moving points to the topic they belong to, filing loose ends (into a topic,
 * or a new one when several are about the same thing), and splitting a point
 * that has grown into a topic of its own. The writer ticks what to keep; only
 * then is anything changed. It never changes whether something is fixed,
 * unfixed or a whim: that only comes from what the writer said.
 */
import { z } from 'zod'
import { newId } from '../ids'
import type { MemoryNodeFile, MemoryPoint } from '../schema'
import { samePoint } from './build'

export type TidySuggestion =
  | { kind: 'link'; a: string; b: string; why: string }
  | { kind: 'merge'; keep: string; merge: string[]; title: string; why: string }
  | { kind: 'move'; point: string; to: string; why: string }
  | { kind: 'file'; points: string[]; to: string | null; title: string; why: string }
  | { kind: 'split'; point: string; title: string; why: string }

/* ---------- what the AI sees: short keys instead of long ids ---------- */

export interface TidyKeys {
  node: Map<string, string>
  point: Map<string, string>
}

/**
 * The memory as the AI reviews it (rejected things left out), with short
 * keys. `detail`: the topics shown with their points (the rest by title and
 * summary only, so a big memory can be reviewed in batches yet linked across).
 */
export function tidyText(
  nodes: MemoryNodeFile[],
  detail?: Set<string>,
): { text: string; keys: TidyKeys } {
  const keys: TidyKeys = { node: new Map(), point: new Map() }
  const shown = nodes.filter((n) => n.state !== 'rejected')
  const keyOf = new Map<string, string>()
  shown.forEach((n, i) => {
    keyOf.set(n.id, `T${i + 1}`)
    keys.node.set(`T${i + 1}`, n.id)
  })
  const lines: string[] = []
  let p = 0
  for (const n of shown) {
    const links = n.links.map((l) => keyOf.get(l)).filter(Boolean)
    const head = `## ${keyOf.get(n.id)} ${n.loose ? '[LOOSE ENDS]' : `“${n.title}”`} (${n.state})${links.length ? ` linked: ${links.join(', ')}` : ''}`
    if (detail && !detail.has(n.id)) {
      lines.push(`${head}${n.summary ? ` — ${n.summary.slice(0, 160)}` : ''}`)
      continue
    }
    lines.push(`${head}${n.summary ? `\n${n.summary}` : ''}`)
    for (const pt of n.points) {
      if (pt.state === 'rejected') continue
      const pk = `P${++p}`
      keys.point.set(pk, pt.id)
      lines.push(`- ${pk} [${pt.state}] ${pt.text}`)
    }
  }
  return { text: lines.join('\n'), keys }
}

/** Batches of topics whose points fit in about `words` words each. */
export function tidyBatches(nodes: MemoryNodeFile[], words: number): Set<string>[] {
  const out: Set<string>[] = []
  let current = new Set<string>()
  let count = 0
  for (const n of nodes) {
    if (n.state === 'rejected') continue
    const w = n.points.reduce((sum, p) => sum + p.text.split(/\s+/).length + 2, 8)
    if (count + w > words && current.size) {
      out.push(current)
      current = new Set()
      count = 0
    }
    current.add(n.id)
    count += w
  }
  if (current.size) out.push(current)
  return out
}

export function tidyMessages(
  text: string,
  storyName: string,
): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: `You tidy up a writer's story memory for “${storyName}”: topics (T1, T2…) holding points (P1, P2…), each marked fixed, unfixed or whim. "LOOSE ENDS" holds points that fit no topic yet.

Suggest only changes that clearly help, each with a short reason:
- link: two topics that are related (the same characters, plot thread, object, scene, theme). Most topics in a story connect to a few others: find those connections.
- merge: topics that are really the same thing (keep the fuller one; give the merged topic a good title).
- move: a point that belongs in a different topic.
- file: loose-ends points that fit a topic ("to": its key), or several loose-ends points about the same new thing ("to": null and a "title" for the new topic).
- split: a point detailed enough to be its own topic (a "title" for it); it stays linked under the topic it came from.

Never suggest changing whether anything is fixed, unfixed or a whim. Don't suggest links that are already there. Use only the keys given.

Reply ONLY with JSON: {"links":[{"a":"T1","b":"T2","why":"…"}],"merges":[{"keep":"T1","merge":["T3"],"title":"…","why":"…"}],"moves":[{"point":"P4","to":"T2","why":"…"}],"files":[{"points":["P9","P10"],"to":"T2 or null","title":"title if new","why":"…"}],"splits":[{"point":"P7","title":"…","why":"…"}]}`,
    },
    { role: 'user', content: text },
  ]
}

const why = z.string().max(400).catch('').default('')
const replySchema = z.object({
  links: z
    .array(z.object({ a: z.string(), b: z.string(), why }))
    .catch([])
    .default([]),
  merges: z
    .array(
      z.object({
        keep: z.string(),
        merge: z.array(z.string()).catch([]),
        title: z.string().max(200).catch(''),
        why,
      }),
    )
    .catch([])
    .default([]),
  moves: z
    .array(z.object({ point: z.string(), to: z.string(), why }))
    .catch([])
    .default([]),
  files: z
    .array(
      z.object({
        points: z.array(z.string()).catch([]),
        to: z.string().nullable().catch(null),
        title: z.string().max(200).catch(''),
        why,
      }),
    )
    .catch([])
    .default([]),
  splits: z
    .array(z.object({ point: z.string(), title: z.string().max(200), why }))
    .catch([])
    .default([]),
})

/** The AI's suggestions with real ids, keeping only ones that make sense. */
export function parseTidy(
  reply: string,
  keys: TidyKeys,
  nodes: MemoryNodeFile[],
): TidySuggestion[] {
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
  const node = (k: string) => keys.node.get(k.trim())
  const point = (k: string) => keys.point.get(k.trim())
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const ownerOf = (pointId: string) => nodes.find((n) => n.points.some((p) => p.id === pointId))
  const out: TidySuggestion[] = []
  const seen = new Set<string>()
  const once = (key: string) => !seen.has(key) && !!seen.add(key)

  for (const l of data.links) {
    const a = node(l.a)
    const b = node(l.b)
    if (!a || !b || a === b) continue
    if (byId.get(a)!.loose || byId.get(b)!.loose) continue
    if (byId.get(a)!.links.includes(b) || byId.get(b)!.links.includes(a)) continue
    if (!once(`link:${[a, b].sort().join('|')}`)) continue
    out.push({ kind: 'link', a, b, why: l.why })
  }
  for (const m of data.merges) {
    const keep = node(m.keep)
    const merge = [...new Set(m.merge.map(node).filter((x): x is string => !!x && x !== keep))]
    if (!keep || !merge.length || byId.get(keep)!.loose || merge.some((x) => byId.get(x)!.loose))
      continue
    if (!once(`merge:${[keep, ...merge].sort().join('|')}`)) continue
    out.push({
      kind: 'merge',
      keep,
      merge,
      title: m.title.trim() || byId.get(keep)!.title,
      why: m.why,
    })
  }
  for (const m of data.moves) {
    const p = point(m.point)
    const to = node(m.to)
    if (!p || !to || ownerOf(p)?.id === to || byId.get(to)!.loose) continue
    if (!once(`point:${p}`)) continue
    out.push({ kind: 'move', point: p, to, why: m.why })
  }
  for (const f of data.files) {
    const points = [
      ...new Set(f.points.map(point).filter((x): x is string => !!x && !!ownerOf(x)?.loose)),
    ].filter((p) => !seen.has(`point:${p}`))
    const to = f.to ? node(f.to) : null
    if (!points.length || (f.to && (!to || byId.get(to)!.loose)) || (!to && !f.title.trim()))
      continue
    for (const p of points) seen.add(`point:${p}`)
    out.push({ kind: 'file', points, to: to ?? null, title: f.title.trim(), why: f.why })
  }
  for (const s of data.splits) {
    const p = point(s.point)
    if (!p || !s.title.trim() || ownerOf(p)?.loose) continue
    if (!once(`point:${p}`)) continue
    out.push({ kind: 'split', point: p, title: s.title.trim(), why: s.why })
  }
  return out
}

/* ---------- making the kept changes ---------- */

export interface TidyResult {
  /** Nodes to save (changed or new). */
  save: MemoryNodeFile[]
  /** Nodes merged into others (to the trash). */
  remove: string[]
}

/** Applies the kept suggestions, in a safe order; ones that no longer fit are skipped. */
export function applyTidy(nodes: MemoryNodeFile[], kept: TidySuggestion[]): TidyResult {
  const at = new Date().toISOString()
  const all = new Map(nodes.map((n) => [n.id, structuredClone(n)]))
  const changed = new Set<string>()
  const removed = new Set<string>()
  // A merged-away topic's id now means the topic it went into.
  const alias = new Map<string, string>()
  const real = (id: string) => {
    let x = id
    while (alias.has(x)) x = alias.get(x)!
    return x
  }
  const note = (n: MemoryNodeFile, what: string) => {
    n.history.push({ at, by: 'ai', what: `Tidy up: ${what}` })
    n.updatedAt = at
    changed.add(n.id)
  }
  const takePoint = (pointId: string): { from: MemoryNodeFile; point: MemoryPoint } | null => {
    for (const n of all.values()) {
      if (removed.has(n.id)) continue
      const i = n.points.findIndex((p) => p.id === pointId)
      if (i >= 0) return { from: n, point: n.points.splice(i, 1)[0]! }
    }
    return null
  }
  const addPoint = (to: MemoryNodeFile, point: MemoryPoint) => {
    const same = to.points.find((p) => samePoint(p.text, point.text))
    if (same) {
      for (const s of point.sources)
        if (!same.sources.some((x) => x.conversationId === s.conversationId && x.at === s.at))
          same.sources.push(s)
      return
    }
    to.points.push({ ...point, updatedAt: at })
  }
  const link = (a: MemoryNodeFile, b: MemoryNodeFile) => {
    if (a.id === b.id || a.links.includes(b.id) || b.links.includes(a.id)) return false
    a.links.push(b.id)
    return true
  }
  const newNode = (title: string, state: MemoryNodeFile['state'], parentId: string | null) => {
    const n: MemoryNodeFile = {
      formatVersion: 1,
      id: newId('node'),
      title: title.slice(0, 200),
      state,
      summary: '',
      volumeId: null,
      entryIds: [],
      links: [],
      parentId,
      loose: false,
      pos: null,
      points: [],
      history: [],
      createdAt: at,
      updatedAt: at,
    }
    all.set(n.id, n)
    return n
  }

  // Merges first (so later suggestions follow the merged topic), then points, then links.
  const order: TidySuggestion['kind'][] = ['merge', 'move', 'file', 'split', 'link']
  for (const kind of order) {
    for (const s of kept.filter((x) => x.kind === kind)) {
      if (s.kind === 'merge') {
        const keep = all.get(real(s.keep))
        if (!keep || removed.has(keep.id)) continue
        const names: string[] = []
        for (const id of s.merge) {
          const other = all.get(real(id))
          if (!other || other.id === keep.id || removed.has(other.id)) continue
          for (const p of other.points) addPoint(keep, p)
          for (const l of other.links)
            if (real(l) !== keep.id && !keep.links.includes(l)) keep.links.push(l)
          if (other.summary && !keep.summary.includes(other.summary))
            keep.summary = [keep.summary, other.summary].filter(Boolean).join(' ')
          removed.add(other.id)
          alias.set(other.id, keep.id)
          names.push(`“${other.title}”`)
        }
        if (!names.length) continue
        if (s.title) keep.title = s.title.slice(0, 200)
        note(keep, `merged in ${names.join(', ')}`)
      } else if (s.kind === 'move') {
        const to = all.get(real(s.to))
        if (!to || removed.has(to.id) || to.points.some((p) => p.id === s.point)) continue
        const got = takePoint(s.point)
        if (!got) continue
        addPoint(to, got.point)
        note(got.from, `moved “${got.point.text.slice(0, 60)}” to “${to.title}”`)
        note(to, `moved in from “${got.from.title}”: ${got.point.text.slice(0, 60)}`)
      } else if (s.kind === 'file') {
        const target = s.to ? all.get(real(s.to)) : null
        if (s.to && (!target || removed.has(target.id))) continue
        const taken = s.points.map(takePoint).filter((x): x is NonNullable<typeof x> => !!x)
        if (!taken.length) continue
        const states = taken.map((t) => t.point.state)
        const to =
          target ??
          newNode(
            s.title,
            states.every((st) => st === 'fixed')
              ? 'fixed'
              : states.every((st) => st === 'whim')
                ? 'whim'
                : 'unfixed',
            null,
          )
        for (const t of taken) addPoint(to, t.point)
        note(taken[0]!.from, `filed ${taken.length} into “${to.title}”`)
        note(
          to,
          target
            ? `filed in ${taken.length} from loose ends`
            : `made from ${taken.length} loose ends`,
        )
      } else if (s.kind === 'split') {
        const got = takePoint(s.point)
        if (!got) continue
        const child = newNode(s.title, got.point.state, got.from.id)
        child.points.push(got.point)
        link(got.from, child)
        note(got.from, `“${s.title}” became its own topic`)
        note(child, `grew out of “${got.from.title}”`)
      } else if (s.kind === 'link') {
        const a = all.get(real(s.a))
        const b = all.get(real(s.b))
        if (!a || !b || removed.has(a.id) || removed.has(b.id)) continue
        if (link(a, b)) {
          note(a, `linked to “${b.title}”`)
          note(b, `linked to “${a.title}”`)
        }
      }
    }
  }
  // Links to merged-away topics follow them.
  for (const n of all.values()) {
    if (removed.has(n.id)) continue
    const fixed = [...new Set(n.links.map(real))].filter((l) => l !== n.id && !removed.has(l))
    if (fixed.join() !== n.links.join()) {
      n.links = fixed
      changed.add(n.id)
    }
  }
  return {
    save: [...changed].filter((id) => !removed.has(id)).map((id) => all.get(id)!),
    remove: [...removed],
  }
}
