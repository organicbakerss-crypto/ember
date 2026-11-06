/** One roster for the Roundtable UI and AI engine.
 * Specialists and guest stars are registered here after the writer approves their profiles.
 * No placeholder personalities appear as usable participants.
 */
import { EMBER_CHARACTERS, characterInstructions } from './characters'
import type { RoundtableParticipant } from './roundtable'

export interface RoundtableRole extends RoundtableParticipant {
  /** Full, source-aware role instructions. Never generic filler. */
  instructions: string
}

/** Install specialist roles one approved five-person batch at a time. */
export const SPECIALIST_ROLES: readonly RoundtableRole[] = []

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
