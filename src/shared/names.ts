/**
 * Finds the names of world entries (and their aliases) in text. Names are
 * matched as whole words and case-sensitively ("Rose" the character, not
 * "rose" the flower); a possessive ("Mara's") still counts. Longer names win
 * over shorter ones that overlap ("Mara Voss" over "Mara").
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
    `(?<!${WORD})(?:${alternatives.join('|')})(?!${WORD}|['’]${WORD}{2})`,
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

/** The terms for a set of entries: each name and alias. */
export function entryTerms(entries: { id: string; name: string; aliases: string[] }[]): NameTerm[] {
  return entries.flatMap((e) => [e.name, ...e.aliases].map((term) => ({ entryId: e.id, term })))
}
