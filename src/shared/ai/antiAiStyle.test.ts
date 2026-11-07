import { describe, expect, it } from 'vitest'
import {
  ANTI_AI_CATALOG_VERSION,
  ANTI_AI_PATTERNS,
  ANTI_AI_DETECTORS,
  antiAiStyleGuidance,
  inspectAiStyle,
  type AntiAiPattern,
} from './antiAiStyle'

describe('shared anti-AI conversational style', () => {
  it('has a versioned, broad catalog of unique rules, not just observed Rifujin tells', () => {
    expect(ANTI_AI_CATALOG_VERSION).toBeGreaterThanOrEqual(1)
    expect(ANTI_AI_PATTERNS.length).toBeGreaterThanOrEqual(45)
    expect(new Set(ANTI_AI_PATTERNS.map((x) => x.id)).size).toBe(ANTI_AI_PATTERNS.length)
    expect(new Set(ANTI_AI_PATTERNS.map((x) => x.category)).size).toBe(6)
    for (const entry of ANTI_AI_PATTERNS) {
      expect(entry.id).toMatch(/^[a-z][a-z0-9-]+$/)
      expect(entry.guidance.length).toBeGreaterThan(30)
    }
    for (const id of [
      'artificial-scenarios', 'reflexive-concession','automatic-categories',
      'fake-epigram','false-symmetry','stock-vocabulary','voice-flattening',
      'unsupported-firstperson','rule-of-three','closing-question',
      'bulleted-default','vague-importance','faux-insight-hook',
    ]) expect(ANTI_AI_PATTERNS.some((p) => p.id === id)).toBe(true)
  })

  it('includes every currently defined catalog entry in conversational prompts', () => {
    for (const context of ['chat','roundtable'] as const) {
      const prompt = antiAiStyleGuidance(context)
      for (const rule of ANTI_AI_PATTERNS) expect(prompt).toContain(rule.guidance)
      expect(prompt).toContain('not a universal ban')
      expect(prompt).toContain('evidenced individual cadence')
      expect(prompt).toContain('substantive reasoning')
    }
  })

  it('permits new categories of tells without duplicating hand-written prompt logic', () => {
    const custom: AntiAiPattern = { id: 'unexpected-new-pattern', category: 'delivery',
      guidance: 'Avoid a newly observed repetitive rhetorical tic when it lacks a real communicative purpose.' }
    const prompt = antiAiStyleGuidance('chat', [...ANTI_AI_PATTERNS, custom])
    expect(prompt).toContain(custom.guidance)
    expect(prompt).not.toContain('unrelated sentinel')
  })

  it('preserves strict output formats rather than introducing conversational prose into ballots', () => {
    const output = antiAiStyleGuidance('structured')
    expect(output).toContain('machine-readable format exactly')
    expect(output).toContain('schema validity')
    expect(output).not.toContain('Starts and conversational setup')
  })

  it('developer diagnostic flags several observed patterns but is not an AI authorship classifier', () => {
    const result = inspectAiStyle("Here's the thing. That third one is sneaky. I was too quick to agree. You don't owe the better game an evening.")
    expect(result.map(x=>x.id)).toContain('throat-clearing')
    expect(result.map(x=>x.id)).toContain('performative-humor')
    expect(result.map(x=>x.id)).toContain('reflexive-concession')
    expect(result.map(x=>x.id)).toContain('fake-epigram')
    expect(inspectAiStyle('Rain started around noon. The bus came late.').length).toBe(0)
    for (const regex of Object.values(ANTI_AI_DETECTORS)) expect(regex.global).toBe(true)
  })

  it('developer diagnostic supports future pattern detectors without a paid rewrite call', () => {
    const result = inspectAiStyle('blue umbrella', { 'new-tic': /blue umbrella/i })
    expect(result).toEqual([{ id:'new-tic', snippet:'blue umbrella' }])
  })
})
