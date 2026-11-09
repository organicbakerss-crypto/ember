import { describe, expect, it } from 'vitest'
import {
  CHARACTER_TEMPLATE,
  looksFilled,
  storyCharacterInstructions,
  templateName,
} from './storyCharacters'

const sara = `Name: Sara
Who they are (one or two lines): Josh's coworker, sharp-tongued, cares more than she shows.
How they talk (a few lines): Short, blunt, swears casually.
What they want: To get out of this job eventually.`

describe('story characters', () => {
  it('reads the name and tells a filled template from a blank one', () => {
    expect(templateName(sara)).toBe('Sara')
    expect(looksFilled(sara)).toBe(true)
    expect(looksFilled(CHARACTER_TEMPLATE)).toBe(false)
  })

  it('answers inside the story or about the work, and only knows the story so far', () => {
    const prompt = storyCharacterInstructions('Sara', sara, [
      'Bought Josh a drink after his week off.',
    ])
    expect(prompt).toContain('You are Sara')
    expect(prompt).toContain('answer from inside it')
    expect(prompt).toContain('reading your own story')
    expect(prompt).toContain('only know the story up to the chapter the writer has open')
    expect(prompt).toContain('Bought Josh a drink')
    expect(prompt).toContain('That third one is sneaky.')
  })
})

describe('filled templates in the shapes AIs write them', () => {
  it('reads answers on the lines under each label', () => {
    const card = `Name:sara
Sara

Who they are (one or two lines):
A competitive, confident member of Josh's team.

How they talk (a few lines):
Blunt, casual, and sarcastic.
She complains openly.

What they want:
To be seen.`
    expect(templateName(card)).toBe('sara')
    expect(looksFilled(card)).toBe(true)
  })

  it('reads bold labels, headings and list items', () => {
    const card = `**Name:** Sara
## What they want:
A real desk.
- What they're afraid of: Staying.
**What they'd never do:**
Cry at work.`
    expect(templateName(card)).toBe('Sara')
    expect(looksFilled(card)).toBe(true)
  })

  it('still refuses text that is not a filled template', () => {
    expect(looksFilled('just some text')).toBe(false)
    expect(looksFilled('Name: Sara')).toBe(false)
    expect(looksFilled(CHARACTER_TEMPLATE)).toBe(false)
  })
})
