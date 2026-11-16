/**
 * One roster for the Roundtable UI and AI engine: John AI and the guest
 * stars, from `./personas`. Add or remove one by editing those lists.
 */
import { GUESTS, REGULARS, personaInstructions } from './personas'
import type { RoundtableParticipant } from './roundtable'

export interface RoundtableRole extends RoundtableParticipant {
  /** Full role instructions. */
  instructions: string
}

export const REGULAR_ROLES: readonly RoundtableRole[] = REGULARS.map((p) => ({
  id: p.id,
  name: p.name,
  kind: 'regular' as const,
  instructions: personaInstructions(p.id),
}))
export const GUEST_ROLES: readonly RoundtableRole[] = GUESTS.map((p) => ({
  id: p.id,
  name: p.name,
  kind: 'guest' as const,
  instructions: personaInstructions(p.id),
}))

/** Everyone who can take a seat. */
export const ROUNDTABLE_CAST: readonly RoundtableRole[] = [...REGULAR_ROLES, ...GUEST_ROLES]

const ids = new Set(ROUNDTABLE_CAST.map((role) => role.id))
if (ids.size !== ROUNDTABLE_CAST.length)
  throw new Error('Roundtable participant IDs must be unique.')

/**
 * A participant's role. One no longer installed (from an older saved
 * session: a retired partner or specialist) keeps its name and takes John
 * AI's instructions, so the session still opens and carries on.
 */
export function roundtableRole(id: string, kind: RoundtableParticipant['kind']): RoundtableRole {
  const role = ROUNDTABLE_CAST.find((p) => p.id === id && p.kind === kind)
  if (role) return role
  return { id, name: id, kind, instructions: personaInstructions(id) }
}
