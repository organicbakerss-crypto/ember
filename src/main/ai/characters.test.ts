import { describe, expect, it } from 'vitest'
import { EMBER_CHARACTERS, emberCharacter } from '@shared/ai/characters'
import { DEFAULT_AI_SETTINGS } from '@shared/settings'
import { aiSettingsSchema } from '@shared/exportSettings'
import { chatMessages, editMessages, type PromptContext } from './prompts'

const context = (characterId: string): PromptContext => ({
  characterId,
  mode: 'chat',
  scope: null,
  entries: [],
})

describe('regular AI characters', () => {
  it('provides ten named foundations with John AI as the default', () => {
    expect(EMBER_CHARACTERS).toHaveLength(10)
    expect(new Set(EMBER_CHARACTERS.map((character) => character.id)).size).toBe(10)
    expect(emberCharacter(DEFAULT_AI_SETTINGS.characterId).name).toBe('John AI')
    expect(() => emberCharacter('unknown')).toThrow(/Unknown Ember AI character/)
  })

  it('persists valid character choices and falls back safely for older settings', () => {
    const parsed = aiSettingsSchema.parse({ ...DEFAULT_AI_SETTINGS, characterId: 'bo' })
    expect(parsed.characterId).toBe('bo')
    const old = { ...DEFAULT_AI_SETTINGS } as Record<string, unknown>
    delete old.characterId
    expect(aiSettingsSchema.parse(old).characterId).toBe('john-ai')
  })

  it('changes the actual system prompt while preserving the feedback rules', () => {
    const history = [{ role: 'user' as const, content: 'What do you think of this chapter?' }]
    const roman = chatMessages(context('roman'), history)
    const bo = chatMessages(context('bo'), history)
    expect(roman[0]?.content).toContain('Current Ember character: Roman.')
    expect(bo[0]?.content).toContain('Current Ember character: Bo.')
    expect(roman[0]?.content).not.toBe(bo[0]?.content)
    expect(roman[0]?.content).toContain('Every problem you point out comes with a specific fix')
    expect(bo[0]?.content).toContain('Every problem you point out comes with a specific fix')
    expect(roman[1]).toEqual(history[0])
  })

  it('does not add a character persona to exact chapter edits', () => {
    const prompt = editMessages({
      instruction: 'Fix spelling only',
      chapterTitle: 'One',
      chapter: 'Teh sun.',
      history: [],
      names: [],
    })
    expect(prompt[0]?.content).toContain('doing exactly what they ask and nothing else')
    expect(prompt[0]?.content).not.toContain('Current Ember character:')
  })
})
