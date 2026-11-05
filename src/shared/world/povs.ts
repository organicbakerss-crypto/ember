/**
 * A chapter's points of view: the ones set by hand, plus the characters its
 * scene headings name ("Mara", "Mara interlude", "Mara's POV").
 */
export interface Pov {
  name: string
  entryId: string | null
}

export interface PovPerson {
  id: string
  name: string
  aliases: string[]
}

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()

/** The person a scene heading names, if any. */
export function headingPerson(heading: string, people: readonly PovPerson[]): PovPerson | null {
  const h = norm(heading)
    .replace(/^(pov|point of view)\s*[:—–-]\s*/, '')
    .replace(/\s*[:—–-].*$/, '')
    .replace(/('s)?\s+(interlude|pov|point of view|chapter|part \w+)$/, '')
    .replace(/'s$/, '')
    .trim()
  if (!h || h.length > 60) return null
  const exact = people.find((p) => [p.name, ...p.aliases].some((n) => norm(n) === h))
  if (exact) return exact
  // A first name alone, when only one person has it.
  const first = people.filter((p) => norm(p.name).split(' ')[0] === h)
  return first.length === 1 ? first[0]! : null
}

/** Set by hand first, then the ones from scene headings (each person once). */
export function chapterPovs(
  chapter: { pov?: string | null; povEntryId?: string | null; povs?: Pov[]; headings?: string[] },
  people: readonly PovPerson[],
): (Pov & { fromHeading: boolean })[] {
  const set: Pov[] = chapter.povs?.length
    ? chapter.povs
    : chapter.pov
      ? [{ name: chapter.pov, entryId: chapter.povEntryId ?? null }]
      : []
  const out = set.map((p) => ({ ...p, fromHeading: false }))
  for (const h of chapter.headings ?? []) {
    const person = headingPerson(h, people)
    if (!person) continue
    if (out.some((p) => p.entryId === person.id || norm(p.name) === norm(person.name))) continue
    out.push({ name: person.name, entryId: person.id, fromHeading: true })
  }
  return out
}
