/** One roster for the Roundtable UI and AI engine.
 * Specialists and guest stars are registered here after the writer approves their profiles.
 * No placeholder personalities appear as usable participants.
 */
import { EMBER_CHARACTERS, characterInstructions } from './characters'
import type { RoundtableParticipant } from './roundtable'
import { specialistInstructions, type SpecialistProfile } from './specialists/types'
import { FANTASY_SPECIALIST } from './specialists/fantasy'
import { SCIENCE_FICTION_SPECIALIST } from './specialists/science-fiction'
import { HORROR_SPECIALIST } from './specialists/horror'
import { MYSTERY_SPECIALIST } from './specialists/mystery'
import { COMEDY_SPECIALIST } from './specialists/comedy'

export interface RoundtableRole extends RoundtableParticipant {
  /** Full, source-aware role instructions. Never generic filler. */
  instructions: string
}

/** First five specialist drafts are available to test; no other specialties are invented. */
export const SPECIALIST_PROFILES: readonly SpecialistProfile[] = [
  FANTASY_SPECIALIST,
  SCIENCE_FICTION_SPECIALIST,
  HORROR_SPECIALIST,
  MYSTERY_SPECIALIST,
  COMEDY_SPECIALIST,
]
export const SPECIALIST_ROLES: readonly RoundtableRole[] = SPECIALIST_PROFILES.map((profile) => ({
  id: profile.id, name: profile.name, kind: 'specialist' as const,
  instructions: specialistInstructions(profile),
}))

/** Install guest roles one approved five-person batch at a time. */
export const GUEST_ROLES: readonly RoundtableRole[] = []

export const ROUNDTABLE_CAST: readonly RoundtableRole[] = [
  ...EMBER_CHARACTERS.map((character) => ({
    id: character.id,
    name: character.name,
    kind: 'regular' as const,
    instructions: characterInstructions(character.id),
  })),
  ...SPECIALIST_ROLES,
  ...GUEST_ROLES,
]
const ids = new Set(ROUNDTABLE_CAST.map((role) => role.id))
if (ids.size !== ROUNDTABLE_CAST.length) throw new Error('Roundtable participant IDs must be unique.')

export function roundtableRole(id: string, kind: RoundtableParticipant['kind']): RoundtableRole {
  const role = ROUNDTABLE_CAST.find((p) => p.id === id && p.kind === kind)
  if (!role) throw new Error('This Roundtable participant is not installed.')
  return role
}
