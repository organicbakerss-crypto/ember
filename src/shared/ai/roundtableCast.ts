/** One roster for the Roundtable UI and AI engine.
 * Specialists and guest stars are registered here after the writer approves their profiles.
 * No placeholder personalities appear as usable participants.
 */
import { emberCharacter, characterInstructions } from './characters'
import type { RoundtableParticipant } from './roundtable'
import { specialistInstructions, type SpecialistProfile } from './specialists/types'
import { FANTASY_SPECIALIST } from './specialists/fantasy'
import { SCIENCE_FICTION_SPECIALIST } from './specialists/science-fiction'
import { HORROR_SPECIALIST } from './specialists/horror'
import { MYSTERY_SPECIALIST } from './specialists/mystery'
import { COMEDY_SPECIALIST } from './specialists/comedy'
import { guestInstructions, type GuestProfile } from './guests/types'
import { DAN_HARMON_GUEST } from './guests/dan-harmon'
import { QUENTIN_TARANTINO_GUEST } from './guests/quentin-tarantino'

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

/** Guests are drafted and installed in pairs, after studying their creative practice. */
export const GUEST_PROFILES: readonly GuestProfile[] = [DAN_HARMON_GUEST, QUENTIN_TARANTINO_GUEST]
export const GUEST_ROLES: readonly RoundtableRole[] = GUEST_PROFILES.map((profile) => ({
  id: profile.id, name: profile.name, kind: 'guest' as const,
  instructions: guestInstructions(profile),
}))

/** Candidate list excludes regular chat characters; the currently configured one is added dynamically. */
export const ROUNDTABLE_CAST: readonly RoundtableRole[] = [
  ...SPECIALIST_ROLES,
  ...GUEST_ROLES,
]

/** One currently selected chat character can accompany specialists and guests. */
export function currentRoundtableCharacter(id: string): RoundtableRole {
  const character = emberCharacter(id)
  return {
    id: character.id, name: character.name, kind: 'regular',
    instructions: characterInstructions(character.id),
  }
}
const ids = new Set(ROUNDTABLE_CAST.map((role) => role.id))
if (ids.size !== ROUNDTABLE_CAST.length) throw new Error('Roundtable participant IDs must be unique.')

export function roundtableRole(id: string, kind: RoundtableParticipant['kind']): RoundtableRole {
  if (kind === 'regular') {
    // Legacy saved Roundtables can still load prior characters, but only the
    // single current chat character appears in the new-session selector.
    return currentRoundtableCharacter(id)
  }
  const role = ROUNDTABLE_CAST.find((p) => p.id === id && p.kind === kind)
  if (!role) throw new Error('This Roundtable participant is not installed.')
  return role
}
