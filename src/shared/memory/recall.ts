/**
 * Reading the story's memory for a question. The AI sees a short index of
 * the nodes (never rejected ones) and picks which to open and how deep:
 *   1 the summary, 2 + decided points, 3 + proposals and whims,
 *   4 + where each point came from, word for word.
 * Rejected nodes and points are never shown to the AI (the writer still sees them).
 */
import { z } from 'zod'
import type { MemoryNodeFile, MemoryState } from '../schema'

export type Depth = 1 | 2 | 3 | 4

/** What the AI may see of a node (nothing when the node is rejected). */
export function visible(node: MemoryNodeFile): MemoryNodeFile | null {
  if (node.state === 'rejected') return null
  return { ...node, points: node.points.filter((p) => p.state !== 'rejected') }
}

const count = (node: MemoryNodeFile, state: MemoryState) =>
  node.points.filter((p) => p.state === state).length

/** One line per node: the menu the AI picks from. */
export function memoryIndex(nodes: MemoryNodeFile[]): string {
  return nodes
    .map(visible)
    .filter((n): n is MemoryNodeFile => !!n)
    .map(
      (n) =>
        `${n.id} | ${n.title} | ${n.state} | ${count(n, 'fixed')} decided, ${count(n, 'unfixed')} proposed, ${count(n, 'whim')} whims | ${n.summary.slice(0, 200)}`,
    )
    .join('\n')
}

/** Asks which nodes to open for the question, and how deep. */
export function recallMessages(
  index: string,
  question: string,
  recent: { role: 'user' | 'assistant'; content: string }[],
): { role: 'system' | 'user'; content: string }[] {
  const lately = recent
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'Writer' : 'AI'}: ${m.content.slice(0, 600)}`)
    .join('\n')
  return [
    {
      role: 'system',
      content: `You choose what to look up in a writer's story memory before answering them. Each line is a topic: id | title | state | counts | summary.

${index}

Pick the topics that would help answer the writer's latest message, and how deep to read each:
1 = summary only (enough to know it's there), 2 = plus decided points, 3 = plus proposals and whims, 4 = plus the exact words they came from (when the writer asks what was said, or details matter).
Pick few and shallow when that's enough; none when nothing fits. Reply ONLY with JSON: {"open":[{"id":"…","depth":2}]}`,
    },
    {
      role: 'user',
      content: `${lately ? `Recent conversation:\n${lately}\n\n` : ''}Latest message: ${question}`,
    },
  ]
}

const recallSchema = z.object({
  open: z
    .array(z.object({ id: z.string(), depth: z.coerce.number().int().min(1).max(4).catch(2) }))
    .catch([]),
})

/** The AI's picks, keeping only nodes that exist and may be shown (at most `max`). */
export function parseRecall(
  text: string,
  nodes: MemoryNodeFile[],
  max: number,
): { id: string; depth: Depth }[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const r = recallSchema.safeParse(JSON.parse(text.slice(start, end + 1)))
    if (!r.success) return []
    const ok = new Set(nodes.filter((n) => visible(n)).map((n) => n.id))
    const seen = new Set<string>()
    return r.data.open
      .filter((o) => ok.has(o.id) && !seen.has(o.id) && seen.add(o.id))
      .slice(0, max)
      .map((o) => ({ id: o.id, depth: o.depth as Depth }))
  } catch {
    return []
  }
}

const norm = (s: string) => s.toLowerCase()

/** Without an AI to choose (or when it couldn't): the nodes that share the question's words. */
export function pickByWords(
  nodes: MemoryNodeFile[],
  terms: string[],
  max: number,
): { id: string; depth: Depth }[] {
  if (!terms.length) return []
  return nodes
    .map(visible)
    .filter((n): n is MemoryNodeFile => !!n)
    .map((n) => {
      const head = norm(`${n.title} ${n.summary}`)
      const body = norm(n.points.map((p) => p.text).join(' '))
      let score = 0
      for (const t of terms) {
        if (head.includes(t)) score += 3
        else if (body.includes(t)) score += 1
      }
      return { n, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => ({ id: x.n.id, depth: (x.score >= 3 ? 3 : 2) as Depth }))
}

const LABEL: Record<MemoryState, string> = {
  fixed: 'Decided',
  unfixed: 'Proposed, not settled',
  whim: 'Whims (kept, thin)',
  rejected: '',
}

/** A node as the AI reads it, at a depth. */
export function nodeForAI(node: MemoryNodeFile, depth: Depth): string {
  const n = visible(node)
  if (!n) return ''
  const lines = [`## ${n.title} (${n.loose ? 'loose ends' : n.state})`]
  if (n.state !== 'fixed' && !n.loose)
    lines.push(
      `(This whole topic is ${n.state === 'whim' ? 'only a whim' : 'not settled'}: its decided points hold only if it's used.)`,
    )
  if (n.summary) lines.push(n.summary)
  if (depth >= 2) {
    const states: MemoryState[] = depth >= 3 ? ['fixed', 'unfixed', 'whim'] : ['fixed']
    for (const state of states) {
      const points = n.points.filter((p) => p.state === state)
      if (!points.length) continue
      lines.push(`${LABEL[state]}:`)
      for (const p of points) {
        const src = p.sources[p.sources.length - 1]
        lines.push(
          depth >= 4 && src
            ? `- ${p.text} (from “${src.title}”, ${src.at.slice(0, 10)}: “${src.quote}”)`
            : `- ${p.text}`,
        )
      }
    }
  }
  return lines.join('\n')
}
