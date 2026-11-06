/** Ember's registered AI personalities. Runtime profiles are separate, versioned files. */
import { JOHN_PROFILE } from './characters/john'
import { ROMAN_PROFILE } from './characters/roman'
import { BO_PROFILE } from './characters/bo'
import { CAESAR_PROFILE } from './characters/caesar'
import { JAKE_PROFILE } from './characters/jake'
import { ETHAN_PROFILE } from './characters/ethan'
import { ENZO_PROFILE } from './characters/enzo'
import { JAY_PROFILE } from './characters/jay'
import { JOSH_PROFILE } from './characters/josh'
import { DANNY_PROFILE } from './characters/danny'
import { SHARED_CHARACTER_RULES } from './sharedRules'

export interface EmberCharacter {
  id: string
  name: string
  foundation: string
  personality: string
  /** Delivery and rhythm only: never change the standard of reasoning. */
  voice?: string
  version?: number
}

export const DEFAULT_CHARACTER_ID = 'john-ai'

/** Ten regular characters. Round-two profiles are awaiting conversational review. */
export const EMBER_CHARACTERS: readonly EmberCharacter[] = [
  JOHN_PROFILE,
  ROMAN_PROFILE,
  BO_PROFILE,
  CAESAR_PROFILE,
  JAKE_PROFILE,
  ETHAN_PROFILE,
  ENZO_PROFILE,
  JAY_PROFILE,
  JOSH_PROFILE,
  DANNY_PROFILE,
]

const characterById = new Map(EMBER_CHARACTERS.map((character) => [character.id, character]))
if (characterById.size !== EMBER_CHARACTERS.length) {
  throw new Error('Ember AI character IDs must be unique.')
}
for (const character of EMBER_CHARACTERS) {
  if (!character.id || !character.name || !character.personality.trim()) {
    throw new Error('Ember AI character profiles require an id, name and personality.')
  }
}

/** Unknown identifiers are an error; only a missing choice defaults to John. */
export function emberCharacter(id: string | undefined): EmberCharacter {
  if (!id) return JOHN_PROFILE
  const character = characterById.get(id)
  if (!character) throw new Error(`Unknown Ember AI character: ${id}`)
  return character
}

/** A stable persona per request; never include profiles for other characters. */
export function characterInstructions(id: string | undefined): string {
  const character = emberCharacter(id)
  return [
    `You are ${character.name}. Speak from this character's perspective as a continuous conversational role, not as a generic assistant demonstrating a set of traits.`,
    `Character profile version: ${character.version ?? 0}.`,
    `This is who ${character.name} is:\n${character.personality}`,
    ...(character.voice ? [`How ${character.name} sounds in conversation:\n${character.voice}`] : []),
    SHARED_CHARACTER_RULES,
  ].join('\n')
}
