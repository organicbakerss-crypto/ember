import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PERSONA_ID,
  GUESTS,
  PERSONAS,
  REGULARS,
  guestNotice,
  persona,
  personaInstructions,
} from '.'

describe('AI characters', () => {
  it('has John AI and eleven guest stars, each guest with a voice shown by example', () => {
    expect(REGULARS.map((p) => p.id)).toEqual(['john-ai'])
    expect(GUESTS).toHaveLength(11)
    for (const p of PERSONAS)
      if (!(p.kind === 'regular' && p.plain)) expect(p.sounds.length).toBeGreaterThanOrEqual(3)
  })

  it('reads an unknown, old or retired character as John AI', () => {
    expect(DEFAULT_PERSONA_ID).toBe('john-ai')
    expect(persona('john-old-character').id).toBe(DEFAULT_PERSONA_ID)
    expect(persona('nora').id).toBe('john-ai')
    expect(persona('specialist-pacing').id).toBe('john-ai')
    expect(persona('john-ai').name).toBe('John AI')
    expect(persona(undefined).id).toBe(DEFAULT_PERSONA_ID)
  })

  it('tells a guest star where they go deep and where they are lighter, and that it is a portrayal', () => {
    const harmon = GUESTS.find((g) => g.name === 'Dan Harmon')!
    const prompt = personaInstructions(harmon.id)
    expect(prompt).toContain('AI portrayal of Dan Harmon')
    expect(prompt).toContain('Where you go deep')
    expect(prompt).toContain("Where you're lighter")
    expect(guestNotice(harmon)).toContain('lighter')
  })

  it('carries the anti-slop examples, and stays short', () => {
    const prompt = personaInstructions('john-ai')
    expect(prompt).toContain('That third one is sneaky.')
    expect(prompt).toContain('Suddenly it’s Sunday evening.')
    for (const p of PERSONAS)
      expect(personaInstructions(p.id).length).toBeLessThan(p.kind === 'guest' ? 11000 : 6600)
  })

  it('the anti-AI habits are about voice, never length or depth; everyone thinks things through', async () => {
    const { personaReminder } = await import('.')
    for (const p of PERSONAS) {
      const prompt = personaInstructions(p.id)
      expect(prompt).toContain('never how much')
      expect(prompt).toContain('full depth of your thinking')
    }
    expect(personaReminder('john-ai')).toContain('thorough')
    expect(personaReminder('john-ai')).not.toContain('plainly and helpfully')
  })
})

describe('John AI', () => {
  it('is a plain assistant: no personality, still no AI slop', () => {
    const prompt = personaInstructions('john-ai')
    expect(prompt).toContain('no particular personality')
    expect(prompt).not.toContain('Your way of answering')
    expect(prompt).toContain('That third one is sneaky.')
  })
})

describe('your partner at the Roundtable', () => {
  it('is John AI', async () => {
    const { yourPartner } = await import('.')
    expect(yourPartner({ characterId: 'guest-dan-harmon', lastPartnerId: 'nora' }).id).toBe(
      'john-ai',
    )
  })
})
