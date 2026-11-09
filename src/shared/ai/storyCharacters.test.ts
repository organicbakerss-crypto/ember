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
