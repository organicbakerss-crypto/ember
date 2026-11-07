import { describe, expect, it } from 'vitest'
import { guestInstructions } from '@shared/ai/guests/types'
import { RIFUJIN_NA_MAGONOTE_GUEST } from '@shared/ai/guests/rifujin-na-magonote'
import { roundtableRole } from '@shared/ai/roundtableCast'
import { conversationFileSchema } from '@shared/schema'
import { aiSettingsSchema } from '@shared/exportSettings'
import { DEFAULT_AI_SETTINGS } from '@shared/settings'
import { chatMessages, type PromptContext } from './prompts'

const ctx = (characterId: string): PromptContext => ({
  characterId, mode: 'chat', entries: [], scope: null,
})
describe('guest personality runtime', () => {
  it('supports guests as persistent default characters in settings and saved conversations', () => {
    const id = RIFUJIN_NA_MAGONOTE_GUEST.id
    expect(aiSettingsSchema.parse({ ...DEFAULT_AI_SETTINGS, characterId: id }).characterId).toBe(id)
    const saved = conversationFileSchema.parse({
      formatVersion: 1, id:'cnv_0123456789abcdef', mode:'chat', characterId:id,
      title:'Guest conversation', createdAt:'2026-11-06T00:00:00.000Z',
      updatedAt:'2026-11-06T00:00:00.000Z', messages:[],
    })
    expect(saved.characterId).toBe(id)
  })
  it('keeps everyday chat distinct from Roundtable while using one guest identity', () => {
    const id = RIFUJIN_NA_MAGONOTE_GUEST.id
    const system = chatMessages(ctx(id), [{ role:'user', content:'What games have you been enjoying?' }])[0]!.content
    expect(system).toContain('conversing privately with the writer in Ember')
    expect(system).not.toContain('fictional Roundtable portrayal of')
    expect(system).toContain('PUBLIC-EVIDENCE REFERENCE')
    expect(system).toContain('All characters have equal factual standards')
    const table = roundtableRole(id, 'guest').instructions
    expect(table).toContain('fictional Roundtable portrayal')
    expect(table).not.toContain('PUBLIC-EVIDENCE REFERENCE')
    expect(guestInstructions(RIFUJIN_NA_MAGONOTE_GUEST, 'chat')).not.toBe(table)
  })
  it('does not contaminate other guest or regular character prompts', () => {
    const question = [{ role:'user' as const, content:'How do you think this character should act?' }]
    const id = RIFUJIN_NA_MAGONOTE_GUEST.id
    const rifujin = chatMessages(ctx(id), question)[0]!.content
    expect(rifujin).toContain('PUBLIC-EVIDENCE REFERENCE')
    const dan = chatMessages(ctx('guest-dan-harmon'), question)[0]!.content
    expect(dan).not.toContain('PUBLIC-EVIDENCE REFERENCE')
    const john = chatMessages(ctx('john-ai'), question)[0]!.content
    expect(john).not.toContain('PUBLIC-EVIDENCE REFERENCE')
  })
})
