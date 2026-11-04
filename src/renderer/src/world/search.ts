/**
 * World mode's search: entries by name, other names, tags, facts and the
 * start of their page, best matches first. `#tag` lists the entries with
 * that tag.
 */
import type { EntrySummary } from '@shared/ipc'

export interface SearchMatch {
  entry: EntrySummary
  /** Why it matched, when it wasn't the name ("also called …", a fact, the page). */
  why: string | null
}

const MAX = 40

export function searchEntries(entries: readonly EntrySummary[], query: string): SearchMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  if (q.startsWith('#')) {
    const tag = q.slice(1).trim()
    return entries
      .filter((e) =>
        e.tags.some(
          (t) => (tag ? t.toLowerCase() === tag : true) || t.toLowerCase().startsWith(tag),
        ),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX * 5)
      .map((entry) => ({ entry, why: entry.tags.map((t) => `#${t}`).join(' ') }))
  }
  const scored: { entry: EntrySummary; score: number; why: string | null }[] = []
  for (const e of entries) {
    const name = e.name.toLowerCase()
    let score = 0
    let why: string | null = null
    if (name === q) score = 100
    else if (name.startsWith(q)) score = 80
    else if (name.split(/[\s-]+/).some((w) => w.startsWith(q))) score = 70
    else if (name.includes(q)) score = 60
    if (!score) {
      const alias = e.aliases.find((a) => a.toLowerCase().includes(q))
      if (alias) [score, why] = [50, `also called ${alias}`]
    }
    if (!score) {
      const tag = e.tags.find((t) => t.toLowerCase().includes(q))
      if (tag) [score, why] = [40, `#${tag}`]
    }
    if (!score) {
      const fact = Object.values(e.facts)
        .flat()
        .find((v) => v.text?.toLowerCase().includes(q))
      if (fact?.text) [score, why] = [30, around(fact.text, q)]
    }
    if (!score && e.snippet.toLowerCase().includes(q)) [score, why] = [20, around(e.snippet, q)]
    if (score) scored.push({ entry: e, score, why })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, MAX)
    .map(({ entry, why }) => ({ entry, why }))
}

/** A little text around the first match. */
function around(text: string, q: string): string {
  const at = text.toLowerCase().indexOf(q)
  const start = Math.max(0, at - 30)
  const end = Math.min(text.length, at + q.length + 40)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
