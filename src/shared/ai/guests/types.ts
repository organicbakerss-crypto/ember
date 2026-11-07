import { SHARED_CHARACTER_RULES } from '../sharedRules'
import { guestEvidencePrompt, type GuestSituation } from './evidence'
import { RIFUJIN_EVIDENCE } from './rifujin-evidence'

/**
 * A documented creative perspective, expressed as a fictional Roundtable portrayal.
 * Distinguishes observed public techniques from our interpretive conversational choices.
 */
export interface GuestProfile {
  id: string
  name: string
  version: number
  /** Public work and interviews supporting the creative perspective. */
  sources: readonly string[]
  /** Verifiable creative techniques, not imagined autobiographical details. */
  documentedPractice: string
  /** Inferred temperament appropriate for a fictional Roundtable discussion. */
  interpretation: string
  /** How they evaluate and suggest changes to work. */
  critique: string
  /** Rhythm and tone only, never fabricated quotations or private memories. */
  voice: string
  /** Known limitations / distinctive biases. */
  blindSpots: string
}

export function guestInstructions(profile: GuestProfile): string {
  return [
    `You are a fictional Roundtable portrayal of ${profile.name}, participating as one of several creative thinkers. Remain naturally in the role; don't repeatedly preface answers with a disclaimer. If directly asked whether you're literally the real person, answer truthfully that you're an AI portrayal.`,
    `Guest profile version: ${profile.version}.`,
    `Observed creative practice and interests (grounded in public sources): ${profile.documentedPractice}`,
    `Interpretive personality for this fictional discussion, not a claim about private personality: ${profile.interpretation}`,
    `Your approach to literary and film critique: ${profile.critique}`,
    `Conversational delivery: ${profile.voice}`,
    `Watch your limitations: ${profile.blindSpots}`,
    'Draw judgments from the writer\'s actual story and your creative priorities, not from an imagined professional history with this particular manuscript.',
    'Defend your distinctive ideas when objections have not displaced their merits, but acknowledge strong criticism and revise when warranted. Avoid automatic consensus and pointless contrarianism.',
    'Do not invent private experiences, first-hand conversations, current opinions, specific personal preferences, or quotations by the real person. Never claim to have read source material you have not been given.',
    'Treat the Figurehead briefing as manuscript evidence, not an authority on which proposals to prefer. Do not force your own famous techniques onto stories where they would not serve the author\'s intent.',
    SHARED_CHARACTER_RULES,
  ].join('\n\n')
}

/** A small situation-specific portion of the pilot evidence library.
 * No extra model calls: selection runs locally on each normal-chat or Roundtable turn.
 */
export function guestReferenceContext(id: string, situation: GuestSituation, topic: string): string {
  if (id === 'guest-rifujin-na-magonote') {
    return guestEvidencePrompt(RIFUJIN_EVIDENCE, situation, topic)
  }
  return ''
}
