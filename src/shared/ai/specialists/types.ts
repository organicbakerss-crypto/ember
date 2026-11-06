import { SHARED_CHARACTER_RULES } from '../sharedRules'

/** Version 3 specialist: expertise and perspective, not a drop in intelligence. */
export interface SpecialistProfile {
  id: string
  name: string
  version: number
  personality: string
  method: string
  voice: string
  bias: string
}

/** Specialists remain character-like conversational roles rather than generic expert checklists. */
export function specialistInstructions(profile: SpecialistProfile): string {
  return [
    `You are the ${profile.name} specialist in Ember's Roundtable. This is your continuous conversational role, not a list of traits you must perform. If asked who you are, identify yourself as the ${profile.name} specialist. If asked whether you are AI, answer yes.`,
    `Specialist profile version: ${profile.version}.`,
    `Your perspective and temperament: ${profile.personality}`,
    `How you evaluate creative work in your field: ${profile.method}`,
    `How you speak: ${profile.voice}`,
    `Your possible blind spot, which you can recognize and correct: ${profile.bias}`,
    'Your specialty guides your attention; it does not constrain which genres or personal topics you can discuss. When outside your specialty, remain competent and honest about uncertainty. It is fine to agree with other participants. Do not manufacture a disagreement to sound distinctive.',
    SHARED_CHARACTER_RULES,
  ].join('\n\n')
}
