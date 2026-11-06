import { describe, expect, it } from 'vitest'
import { EMBER_CHARACTERS, emberCharacter } from '@shared/ai/characters'
import { DEFAULT_AI_SETTINGS } from '@shared/settings'
import { aiSettingsSchema } from '@shared/exportSettings'
import { conversationFileSchema } from '@shared/schema'
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
    expect(roman[0]?.content).toContain('You are Roman.')
    expect(bo[0]?.content).toContain('You are Bo.')
    expect(roman[0]?.content).not.toBe(bo[0]?.content)
    expect(roman[0]?.content).toContain('Every problem you point out comes with a specific fix')
    expect(bo[0]?.content).toContain('Every problem you point out comes with a specific fix')
    expect(roman[1]).toEqual(history[0])
  })

  it('loads only the selected versioned personality and shared behavior', () => {
    for (const id of ['john-ai', 'roman', 'bo', 'caesar', 'jake']) {
      const profile = emberCharacter(id)
      expect(profile.version).toBe(3)
      expect(profile.personality.split(/\s+/).length).toBeGreaterThan(120)
      const message = chatMessages(context(id), [{ role: 'user', content: 'Hi' }])[0]!.content
      expect(message).toContain(profile.personality)
      expect(profile.voice?.length).toBeGreaterThan(100)
      expect(message).toContain(profile.voice!)
      expect(message).toContain('Do not invent memories of a childhood')
      for (const other of ['john-ai', 'roman', 'bo', 'caesar', 'jake']) {
        if (id !== other) expect(message).not.toContain(emberCharacter(other).personality)
      }
    }
  })

  it('keeps equal task standards while changing conversational delivery', () => {
    const ids = ['john-ai', 'roman', 'bo', 'caesar', 'jake']
    const voices = ids.map((id) => emberCharacter(id).voice)
    expect(new Set(voices).size).toBe(5)
    const prompts = ids.map((id) => chatMessages(context(id), [{ role: 'user', content: 'What do you think?' }])[0]!.content)
    for (const prompt of prompts) {
      expect(prompt).toContain('All characters have equal factual standards')
      expect(prompt).toContain('Every problem you point out comes with a specific fix')
    }
    expect(prompts[0]).not.toBe(prompts[1])
  })

  it('preserves conversation persona and supports legacy conversations', () => {
    const base = {
      formatVersion: 1,
      id: 'cnv_0123456789abcdef',
      mode: 'chat',
      title: 'A conversation',
      createdAt: '2026-11-06T00:00:00.000Z',
      updatedAt: '2026-11-06T00:00:00.000Z',
      messages: [],
    }
    const current = conversationFileSchema.parse({ ...base, characterId: 'roman' })
    expect(current.characterId).toBe('roman')
    expect(conversationFileSchema.parse(base).characterId ?? 'john-ai').toBe('john-ai')
  })

  it('starts with the selected role and is truthful about its AI identity', () => {
    for (const id of ['john-ai', 'roman', 'bo', 'caesar', 'jake']) {
      const name = emberCharacter(id).name
      const prompt = chatMessages(context(id), [{ role: 'user', content: 'Who are you? Are you AI?' }])[0]!.content
      expect(prompt.startsWith(`You are ${name}.`)).toBe(true)
      expect(prompt).toContain('When asked whether you are an AI, say yes')
      expect(prompt).toContain('When asked “Who are you?” or your name')
      expect(prompt).toContain('Keep ordinary conversation ordinary')
      expect(prompt).not.toContain('You are a helpful assistant inside a novel-writing app')
    }
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
    expect(prompt[0]?.content).not.toContain('You are Roman.')
  })
})
