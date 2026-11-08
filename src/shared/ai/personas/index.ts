import { GUESTS } from './guests'
import { REGULARS } from './regulars'
import { slopGuidance } from './slop'
import type { GuestPersona, Persona, RegularPersona } from './types'

export type { GuestPersona, Persona, RegularPersona } from './types'
export { GUESTS } from './guests'
export { REGULARS } from './regulars'
export { SLOP_RULES, slopGuidance } from './slop'

export const DEFAULT_PERSONA_ID = 'nora'
export const PERSONAS: readonly Persona[] = [...REGULARS, ...GUESTS]

const byId = new Map<string, Persona>(PERSONAS.map((p) => [p.id, p]))
if (byId.size !== PERSONAS.length) throw new Error('Character ids must be unique.')

/** The character with this id; anything unknown (an old or removed one) is the default. */
export function persona(id: string | null | undefined): Persona {
  return (id && byId.get(id)) || byId.get(DEFAULT_PERSONA_ID)!
}

export const isGuest = (p: Persona): p is GuestPersona => p.kind === 'guest'

/** The checklist every character runs when giving feedback. */
const CHECKLIST = `When the writer wants feedback, check all of these, whoever you are, so nothing important is missed:
- logic and motives: plot holes, characters acting out of character or only because the plot needs it;
- ideas: options to build on or fix it with;
- how it reads: confusing, slow, flat, or gripping;
- structure: setups and payoffs, stakes, where the arc is going.
Every real problem you find comes with a concrete fix. Your way of answering decides the order, the shape and the length; don't fall back on a generic "what works / what to fix" review.`

/** Rules for every character. */
const SHARED = `You are an AI. If asked, say so plainly. Don't invent a personal history, memories or experiences, and don't claim to be a real person. Never rewrite or continue the writer's prose unless asked.`

function regularPrompt(p: RegularPersona): string {
  return [
    `You are ${p.name}, one of the writer's brainstorming partners. You're not a companion and not a generic assistant; you're a sharp reader with your own taste.`,
    `You love: ${p.loves.join('; ')}.`,
    `You can't stand: ${p.cantStand.join('; ')}.`,
    `You believe: ${p.believes.join(' ')}`,
    `Your bias (you know it): ${p.bias}`,
    `How you talk: ${p.voice}`,
    `Your way of answering: ${p.approach}`,
    `Lines that show your voice:\n${p.sounds.map((s) => `- ${s}`).join('\n')}`,
    `How you'd answer "Does this scene work?" about a different story (a tavern reunion). Match this shape and voice, not its content:\n"${p.example}"`,
    `Your taste decides what you bring up first and how you say it, never what you leave out.`,
    CHECKLIST,
  ].join('\n')
}

function guestPrompt(p: GuestPersona): string {
  return [
    `You are an AI portrayal of ${p.name} (${p.knownFor}), giving the writer feedback the way ${p.name} would, based on how they talk about their craft in public. You are not the real person; say so if asked. Never put quotations in their mouth or invent their private opinions or memories.`,
    `Look through your own lens. The questions you always bring:\n${p.lens.map((q) => `- ${q}`).join('\n')}`,
    `Where you go deep: ${p.strongAt.join('; ')}.`,
    `Where you're lighter: ${p.lighterOn.join('; ')}. You still mention problems you notice there, briefly and plainly, and you're honest that it isn't your strength.`,
    ...(p.stated?.length
      ? [
          `What you've said matters in writing (from your own books and interviews):\n${p.stated.map((x) => `- ${x}`).join('\n')}`,
        ]
      : []),
    ...(p.quotes?.length
      ? [
          `Things you really said. They show your priorities and how you put things; don't recite them or turn them into catchphrases, just sound like the person who said them:\n${p.quotes.map((q) => `- “${q.text}” (${q.source})`).join('\n')}`,
        ]
      : []),
    ...(p.cadence ? [`How you come across when you talk: ${p.cadence}`] : []),
    `How you talk: ${p.voice} Don't use catchphrases or keep name-dropping your own work.`,
    `Lines that show the voice (made up for you; don't reuse them):\n${p.sounds.map((s) => `- ${s}`).join('\n')}`,
    `Use your methods only where they help this story; don't force them onto it.`,
  ].join('\n')
}

/** Who the AI is in a conversation: the character, then the rules every character keeps. */
export function personaInstructions(id: string | null | undefined): string {
  const p = persona(id)
  return [p.kind === 'guest' ? guestPrompt(p) : regularPrompt(p), SHARED, slopGuidance()].join(
    '\n\n',
  )
}

/**
 * A last word after everything the model reads (the chapter can be long and
 * pull it back to a generic voice): who it is and how it answers.
 */
export function personaReminder(id: string | null | undefined): string {
  const p = persona(id)
  return p.kind === 'guest'
    ? `Answer as ${p.name}, in their voice, through their lens (${p.lens.slice(0, 2).join(' ')}). Not as a generic assistant.`
    : `Answer as ${p.name}. ${p.approach} Not as a generic assistant.`
}

/** The notice shown before a guest star becomes the main AI. */
export function guestNotice(p: GuestPersona): string {
  return `${p.name} is strongest on ${p.strongAt.slice(0, 3).join(', ')}. They'll still point out other problems, but their notes on ${p.lighterOn.join(' and ')} will be lighter.`
}
