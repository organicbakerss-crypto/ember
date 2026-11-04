/** Things to ask the AI about the whole story (it reads every chapter's summary). */
export const STORY_PROMPTS: { id: string; label: string; text: string }[] = [
  {
    id: 'blurb',
    label: 'Write a blurb',
    text: 'Write three back-cover blurbs for this story, each under 150 words, in different tones (dramatic, intriguing, warm). Don’t give away the ending. Keep names exactly.',
  },
  {
    id: 'synopsis',
    label: 'Write a synopsis',
    text: 'Write a one-page synopsis of the whole story so far, in present tense: the main characters, the main events in order, and how it ends if it does. Plain prose, no headings.',
  },
  {
    id: 'royalroad',
    label: 'Write a Royal Road description',
    text: 'Write a Royal Road description for this story: a hook as the first line, then a short paragraph about the premise and the main character, under 200 words, with no spoilers past the first few chapters. Then suggest up to 5 fitting Royal Road tags.',
  },
]
