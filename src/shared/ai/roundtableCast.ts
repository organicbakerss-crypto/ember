/**
 * One roster for the Roundtable UI and AI engine. Characters plug in here:
 * the brainstorming partners and guest stars come from `./personas`, plus
 * the genre specialists. Add or remove one by editing those lists.
 */
import { GUESTS, REGULARS, personaInstructions } from './personas'
import type { RoundtableParticipant } from './roundtable'
import { specialistInstructions, type SpecialistProfile } from './specialists/types'
import { FANTASY_SPECIALIST } from './specialists/fantasy'
import { SCIENCE_FICTION_SPECIALIST } from './specialists/science-fiction'
import { HORROR_SPECIALIST } from './specialists/horror'
import { MYSTERY_SPECIALIST } from './specialists/mystery'
import { COMEDY_SPECIALIST } from './specialists/comedy'

export interface RoundtableRole extends RoundtableParticipant {
  /** Full role instructions. */
  instructions: string
}

export const SPECIALIST_PROFILES: readonly SpecialistProfile[] = [
  FANTASY_SPECIALIST,
  SCIENCE_FICTION_SPECIALIST,
  HORROR_SPECIALIST,
  MYSTERY_SPECIALIST,
  COMEDY_SPECIALIST,
]

export const REGULAR_ROLES: readonly RoundtableRole[] = REGULARS.map((p) => ({
  id: p.id,
  name: p.name,
  kind: 'regular' as const,
  instructions: personaInstructions(p.id),
}))
export const SPECIALIST_ROLES: readonly RoundtableRole[] = SPECIALIST_PROFILES.map((profile) => ({
  id: profile.id,
  name: profile.name,
  kind: 'specialist' as const,
  instructions: specialistInstructions(profile),
}))
export const GUEST_ROLES: readonly RoundtableRole[] = GUESTS.map((p) => ({
  id: p.id,
  name: p.name,
  kind: 'guest' as const,
  instructions: personaInstructions(p.id),
}))

/** Everyone who can take a seat. */
export const ROUNDTABLE_CAST: readonly RoundtableRole[] = [
  ...REGULAR_ROLES,
  ...SPECIALIST_ROLES,
  ...GUEST_ROLES,
]

const ids = new Set(ROUNDTABLE_CAST.map((role) => role.id))
if (ids.size !== ROUNDTABLE_CAST.length)
  throw new Error('Roundtable participant IDs must be unique.')

/**
 * A participant's role. One no longer installed (from an older saved
 * session, e.g. a retired character) takes the default partner's
 * instructions, so the session still opens.
 */
export function roundtableRole(id: string, kind: RoundtableParticipant['kind']): RoundtableRole {
  const role = ROUNDTABLE_CAST.find((p) => p.id === id && p.kind === kind)
  if (role) return role
  if (kind === 'specialist') throw new Error('This Roundtable participant is not installed.')
  return { id, name: id, kind, instructions: personaInstructions(id) }
}
