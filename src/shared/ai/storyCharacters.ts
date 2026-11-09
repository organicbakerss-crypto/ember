/**
 * AI characters made from the writer's own story characters. The card is
 * plain labelled text (the template filled in), so any AI can fill it and
 * the writer can read and edit it.
 */
import { slopGuidance } from './personas'

export const CHARACTER_TEMPLATE = `Name:
Who they are (one or two lines):
How they talk (a few lines):
Lines in their voice (3–4 examples, from the story if possible):
What they want:
What they're afraid of:
What they believe that might be wrong:
How they see the other characters:
What they'd never do:`

/** The template's labels, lower-case, without their brackets: "who they are", "name", … */
const LABELS = CHARACTER_TEMPLATE.split('\n').map((l) => simplify(l.split(':')[0]!))

/** A label as compared: lower-case letters and spaces only, brackets dropped. */
function simplify(text: string): string {
  return text
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The answers on a filled template, by label. An answer can sit after the
 * colon or on the lines under the label (as most AIs write it), and labels
 * may come in bold, as headings or as list items.
 */
export function templateAnswers(card: string): Map<string, string> {
  const answers = new Map<string, string>()
  const labels = new Set(LABELS.map((l) => l.replace(/'/g, '')))
  let current: string | null = null
  for (const raw of card.split(/\r?\n/)) {
    const line = raw.replace(/^[ \t]*(?:#+|[-*•]|\d+[.)])?[ \t]*/, '').replace(/\*\*|__/g, '')
    const colon = line.indexOf(':')
    const label = colon > 0 ? simplify(line.slice(0, colon)) : null
    if (label !== null && labels.has(label)) {
      current = label
      answers.set(current, line.slice(colon + 1).trim())
    } else if (current !== null && line.trim()) {
      const before = answers.get(current)!
      answers.set(current, before ? `${before}\n${line.trim()}` : line.trim())
    }
  }
  return answers
}

/** The name on a filled template (the "Name:" answer's first line), or null. */
export function templateName(card: string): string | null {
  const name = templateAnswers(card).get('name')?.split('\n')[0]?.trim()
  return name ? name.slice(0, 200) : null
}

/** Whether a pasted card looks like a filled template (a name and at least a few answers). */
export function looksFilled(card: string): boolean {
  const answers = templateAnswers(card)
  const answered = [...answers.values()].filter((a) => a.trim()).length
  return !!templateName(card) && answered >= 4 // the name and three more
}

/** What the AI is told when it speaks as one of the writer's characters. */
export function storyCharacterInstructions(
  name: string,
  card: string,
  learned: readonly string[],
): string {
  return [
    `You are ${name}, a character from the writer's own story, brought to life so the writer can talk to you. This is their character: be true to the card below and to the story, not to a type.`,
    `Who you are:\n${card.trim()}`,
    ...(learned.length
      ? [
          `What has happened to you and how you've changed, from the chapters so far (newest last):\n${learned.map((x) => `- ${x}`).join('\n')}`,
        ]
      : []),
    `Two ways to answer; pick the one the question asks for:
- If the writer asks you something as a person in the story (“why did you…”, “what do you think of Josh?”, anything addressed to you inside the story), answer from inside it: in your voice, from what you've lived and know so far, as yourself.
- If the writer asks about the work (“what do you think of this chapter?”, “does this scene work?”), answer as yourself reading your own story: your voice, your taste and opinions, but knowing it's a story the writer is working on. Be honest and specific, the way you would be.
- If it's unclear, treat it as a question about the work.`,
    `You only know the story up to the chapter the writer has open. Never mention, hint at or guess events after it. If asked about something you couldn't know yet, say you don't know.`,
    `You are an AI playing this character; if the writer asks, say so plainly. Never rewrite or continue the writer's prose unless asked. Stay a person, not a performance: no catchphrases, no turning every line into a quip.`,
    slopGuidance(),
  ].join('\n\n')
}

export function storyCharacterReminder(name: string): string {
  return `Answer as ${name}, in their voice, inside the story or about the work depending on what was asked, knowing only the story so far. Not as a generic assistant.`
}
