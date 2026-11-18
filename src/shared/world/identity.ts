/**
 * Who someone is over the story: other names (and who uses them), the same
 * person under two entries (revealed at some point), and someone who becomes
 * someone else. Free of any view.
 */
import type { EntryIdentity, EntryName } from '../schema'
import { reached, type ChapterPositions, type Moment } from './facts'

export interface IdentityEntry {
  id: string
  name: string
  names?: EntryName[]
  identities?: EntryIdentity[]
}

/**
 * Which entries are shown as another at a moment: `same` folds the other
 * entry into the one holding the link once it's revealed; `becomes` folds the
 * holder into the one it becomes. Chains are followed (A becomes B, B is C).
 */
export function foldsAt(
  entries: readonly IdentityEntry[],
  at: Moment,
  positions: ChapterPositions,
): Map<string, string> {
  const into = new Map<string, string>()
  const ids = new Set(entries.map((e) => e.id))
  for (const e of entries) {
    for (const link of e.identities ?? []) {
      if (!ids.has(link.entryId) || link.entryId === e.id) continue
      if (!reached(link.at, at, positions)) continue
      if (link.kind === 'same') into.set(link.entryId, e.id)
      else into.set(e.id, link.entryId)
    }
  }
  // Follow chains to the end (and never loop).
  const out = new Map<string, string>()
  for (const id of into.keys()) {
    let target = into.get(id)!
    const seen = new Set([id])
    while (into.has(target) && !seen.has(target)) {
      seen.add(target)
      target = into.get(target)!
    }
    if (target !== id) out.set(id, target)
  }
  return out
}

/** Every name someone has been shown under, for a folded node ("Uncle Pete / Dad"). */
export function shownNames(
  id: string,
  entries: readonly IdentityEntry[],
  folds: ReadonlyMap<string, string>,
): string[] {
  const names = new Map(entries.map((e) => [e.id, e.name]))
  return [id, ...[...folds].filter(([, to]) => to === id).map(([from]) => from)]
    .map((x) => names.get(x))
    .filter((n): n is string => !!n)
}

const KIND_WORD: Record<EntryName['kind'], string> = {
  nickname: '',
  alias: 'alias',
  disguise: 'disguise',
  secret: 'secret identity',
}

/** The names and identities of one entry, as lines of text (for the AI and the digest). */
export function identityLines(
  entry: IdentityEntry,
  entries: readonly IdentityEntry[],
  when: (anchor: EntryName['from']) => string | null,
): string[] {
  const nameOf = new Map(entries.map((e) => [e.id, e.name]))
  const out: string[] = []
  const names = (entry.names ?? []).map((n) => {
    const by = n.usedBy.map((u) => nameOf.get(u)).filter(Boolean)
    const bits = [
      KIND_WORD[n.kind],
      by.length ? `what ${by.join(' and ')} call${by.length === 1 ? 's' : ''} them` : '',
      when(n.from) ? `from ${when(n.from)}` : '',
    ].filter(Boolean)
    return bits.length ? `${n.name} (${bits.join(', ')})` : n.name
  })
  if (names.length) out.push(`Other names: ${names.join('; ')}`)
  for (const link of entry.identities ?? []) {
    const other = nameOf.get(link.entryId)
    if (!other) continue
    const w = when(link.at)
    out.push(
      link.kind === 'same'
        ? `Same person as ${other}${w ? ` (revealed in ${w}; before that they seem to be two people)` : ''}`
        : `Becomes ${other}${w ? ` (from ${w})` : ''}`,
    )
  }
  for (const other of entries) {
    for (const link of other.identities ?? []) {
      if (link.entryId !== entry.id) continue
      const w = when(link.at)
      out.push(
        link.kind === 'same'
          ? `Same person as ${other.name}${w ? ` (revealed in ${w}; before that they seem to be two people)` : ''}`
          : `Was ${other.name}${w ? ` (until ${w})` : ''}`,
      )
    }
  }
  return out
}
