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
  it('has ten partners, John AI and eleven guest stars, each with a voice shown by example', () => {
    expect(REGULARS).toHaveLength(11)
    expect(GUESTS).toHaveLength(11)
    for (const p of PERSONAS)
      if (!(p.kind === 'regular' && p.plain)) expect(p.sounds.length).toBeGreaterThanOrEqual(3)
  })

  it('reads an unknown or old character as the default', () => {
    expect(persona('john-old-character').id).toBe(DEFAULT_PERSONA_ID)
    expect(persona('john-ai').name).toBe('John AI')
    expect(persona(undefined).id).toBe(DEFAULT_PERSONA_ID)
  })

  it('gives every partner the same full checklist, and no backstory', () => {
    for (const p of REGULARS.filter((x) => !x.plain)) {
      const prompt = personaInstructions(p.id)
      expect(prompt).toContain('check all of these')
      expect(prompt).toContain("Don't invent a personal history")
    }
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
    const prompt = personaInstructions('max')
    expect(prompt).toContain('That third one is sneaky.')
    expect(prompt).toContain('Suddenly it’s Sunday evening.')
    for (const p of PERSONAS)
      expect(personaInstructions(p.id).length).toBeLessThan(p.kind === 'guest' ? 10000 : 5500)
  })
})

describe('telling the partners apart', () => {
  it('gives each partner its own way of answering and a full example answer', async () => {
    const { personaReminder } = await import('.')
    const partners = REGULARS.filter((p) => !p.plain)
    expect(new Set(partners.map((p) => p.approach)).size).toBe(partners.length)
    for (const p of partners) {
      expect(personaInstructions(p.id)).toContain(p.example)
      expect(personaReminder(p.id)).toContain(`Answer as ${p.name}`)
    }
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
