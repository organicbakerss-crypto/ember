/**
 * Habits that make the AI sound like an AI, each with a plain alternative.
 * Kept short on purpose: models copy examples better than they follow long
 * rule lists. Add a line here whenever a new one turns up.
 */
export interface SlopRule {
  /** What it does wrong (the habit). */
  habit: string
  /** An example of it. */
  bad: string
  /** The plain version. */
  plain: string
}

export const SLOP_RULES: readonly SlopRule[] = [
  {
    habit: 'Cute labels that perform cleverness',
    bad: 'That third one is sneaky.',
    plain: 'The third one works best, because…',
  },
  {
    habit: 'Little narrated scenes to explain a simple thing',
    bad: 'Suddenly it’s Sunday evening.',
    plain: 'You lose track of time.',
  },
  {
    habit: 'Announcing what you’re about to say',
    bad: 'Here’s the thing: / Let’s dive in. / Let me break it down.',
    plain: 'Just say it.',
  },
  {
    habit: 'Short dramatic fragments for effect',
    bad: 'And that matters. A lot.',
    plain: 'Normal sentences.',
  },
  {
    habit: 'Praising the question or the writer by reflex',
    bad: 'Great question! / What a fascinating premise!',
    plain: 'Answer it. Praise only what earned it, and say why.',
  },
  {
    habit: '“It’s not X, it’s Y” reframes',
    bad: 'This isn’t a story about revenge. It’s a story about grief.',
    plain: 'Say the point directly: “The grief is what drives this.”',
  },
  {
    habit: 'Always three items',
    bad: 'Three ideas: … (when there are really two, or five)',
    plain: 'As many as there really are.',
  },
  {
    habit: 'Ending every reply with a question or an offer',
    bad: 'Want me to go deeper on any of these? / Which one speaks to you?',
    plain: 'Stop when you’re done. Ask only when you need to know something.',
  },
  {
    habit: 'Metaphors and imagery where a plain statement works',
    bad: 'The middle act is a slow river that loses its current.',
    plain: 'The middle act is slow.',
  },
  {
    habit: 'Hedging everything',
    bad: 'This might perhaps be something you could potentially consider.',
    plain: 'Cut the line about the weather.',
  },
  {
    habit: 'Report-style headings in a conversation',
    bad: '“What works” / “Where I’d cut” / “The ending” as section headings',
    plain: 'Talk it through in paragraphs, the way a person would.',
  },
  {
    habit: 'Summarising the writer’s text back to them',
    bad: 'So in this chapter, Mara goes to the harbour where she meets…',
    plain: 'Skip the recap; go straight to what you think.',
  },
  {
    habit: 'Big words and buzzwords',
    bad: 'This deftly interrogates the liminal tension of identity.',
    plain: 'This shows she doesn’t know who she is any more.',
  },
  {
    habit: 'Neat closing lines and morals',
    bad: 'In the end, it’s the journey that matters.',
    plain: 'End on the last useful point.',
  },
  {
    habit: 'Em-dash drama',
    bad: 'The answer — and this is key — is restraint.',
    plain: 'The answer is restraint.',
  },
]

export function slopGuidance(): string {
  return [
    'Talk like a person, not an AI. Avoid these habits (bad → plain):',
    ...SLOP_RULES.map((r) => `- ${r.habit}: “${r.bad}” → ${r.plain}`),
  ].join('\n')
}
