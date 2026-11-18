/**
 * Finds the names of world entries (and their aliases) in text. Names are
 * matched as whole words and case-sensitively ("Rose" the character, not
 * "rose" the flower); a possessive ("Mara's") still counts. Longer names win
 * over shorter ones that overlap ("Mara Voss" over "Mara"). A name never
 * matches inside a hyphenated word ("Mara-blue", "half-Mara").
 */
export interface NameTerm {
  entryId: string
  term: string
}

export interface NameMatch {
  entryId: string
  start: number
  end: number
}

const WORD = '[\\p{L}\\p{N}_]'
/** Hyphens that join words (ASCII hyphen-minus, Unicode hyphen and non-breaking hyphen). */
const HYPHEN = '[-\\u2010\\u2011]'

export interface NameMatcher {
  find(text: string): NameMatch[]
}

export function nameMatcher(terms: NameTerm[]): NameMatcher {
  const byTerm = new Map<string, string>()
  for (const { entryId, term } of terms) {
    const t = term.trim()
    if (t.length >= 2 && !byTerm.has(t)) byTerm.set(t, entryId)
  }
  if (!byTerm.size) return { find: () => [] }
  const alternatives = [...byTerm.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'))
  const pattern = new RegExp(
    `(?<!${WORD}|${WORD}${HYPHEN})(?:${alternatives.join('|')})(?!${WORD}|${HYPHEN}${WORD}|['’]${WORD}{2})`,
    'gu',
  )
  return {
    find(text) {
      const matches: NameMatch[] = []
      for (const m of text.matchAll(pattern)) {
        const entryId = byTerm.get(m[0]) ?? byTerm.get(m[0].replace(/\s+/g, ' '))
        if (entryId) matches.push({ entryId, start: m.index, end: m.index + m[0].length })
      }
      return matches
    },
  }
}

/**
 * The terms for a set of entries: each name and alias, and their other names
 * that everyone uses. A name only some people use ("Dad", used by Josh) counts
 * only when one of them is in `context` (the chapter's narrator, or someone
 * in it), so it never points at the wrong person elsewhere.
 */
export function entryTerms(
  entries: {
    id: string
    name: string
    aliases: string[]
    names?: { name: string; usedBy: string[] }[]
  }[],
  context?: ReadonlySet<string>,
): NameTerm[] {
  return entries.flatMap((e) => [
    ...[e.name, ...e.aliases].map((term) => ({ entryId: e.id, term })),
    ...(e.names ?? [])
      .filter((n) => !n.usedBy.length || (context && n.usedBy.some((u) => context.has(u))))
      .map((n) => ({ entryId: e.id, term: n.name })),
  ])
}
