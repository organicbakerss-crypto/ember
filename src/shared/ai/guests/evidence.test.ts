import { describe, expect, it } from 'vitest'
import { guestEvidencePrompt, selectGuestEvidence } from './evidence'
import { RIFUJIN_EVIDENCE } from './rifujin-evidence'
import { RIFUJIN_NA_MAGONOTE_GUEST } from './rifujin-na-magonote'
import { RIFUJIN_V2_GUEST } from './rifujin-v2'
import { RIFUJIN_V1_GUEST } from './rifujin-v1'
import { guestReferenceContext } from './types'

describe('Rifujin legacy observations retained for rollback', () => {
  it('preserves V1 for comparison and keeps both profiles source-labeled', () => {
    expect(RIFUJIN_V1_GUEST.version).toBe(1)
    expect(RIFUJIN_V2_GUEST.version).toBe(2)
    expect(RIFUJIN_NA_MAGONOTE_GUEST.version).toBe(3)
    expect(RIFUJIN_NA_MAGONOTE_GUEST.id).toBe(RIFUJIN_V1_GUEST.id)
    expect(RIFUJIN_NA_MAGONOTE_GUEST.sources).toHaveLength(4)
  })

  it('research spans personal, social, humor, uncertainty, interests, character and craft', () => {
    expect(RIFUJIN_EVIDENCE.length).toBeGreaterThanOrEqual(24)
    expect(new Set(RIFUJIN_EVIDENCE.map((item) => item.category)).size).toBeGreaterThanOrEqual(10)
    expect(new Set(RIFUJIN_EVIDENCE.map((item) => item.sourceUrl)).size).toBeGreaterThanOrEqual(4)
    for (const item of RIFUJIN_EVIDENCE) {
      expect(item.question.length).toBeGreaterThan(4)
      expect(item.observation.length).toBeGreaterThan(40)
      expect(item.sourceUrl.startsWith('https://')).toBe(true)
      expect(item.limitations).toBeTruthy()
    }
  })

  it('selects a bounded, diverse evidence set, preserving ordinary life across subjects', () => {
    for (const situation of ['casual', 'creative', 'disagreement', 'uncertainty', 'final', 'vote'] as const) {
      const first = selectGuestEvidence(RIFUJIN_EVIDENCE, situation, 'broken character should change now')
      const second = selectGuestEvidence(RIFUJIN_EVIDENCE, situation, 'broken character should change now')
      expect(first).toEqual(second)
      expect(first.length).toBeLessThanOrEqual(5)
      expect(first.length).toBeGreaterThanOrEqual(3)
      expect(new Set(first.map((sample) => sample.category)).size).toBe(first.length)
      expect(first.some((sample) => ['everyday','humor','interests','social','reflection'].includes(sample.category))).toBe(true)
      expect(first.filter((sample) => sample.category === 'characters').length).toBeLessThanOrEqual(1)
    }
  })

  it('archives the old paraphrase-selector without using it as the live speech prompt', () => {
    const refs = guestEvidencePrompt(RIFUJIN_EVIDENCE, 'casual', 'What video games are fun?')
    expect(refs).toContain('PUBLIC-EVIDENCE REFERENCE')
    expect(refs).toContain('Source:')
    expect(refs.length).toBeLessThan(3500)
    expect(refs).not.toContain('redemption expert')
    expect(guestReferenceContext('guest-quentin-tarantino', 'casual', 'hi')).toBe('')
    const active = guestReferenceContext('guest-rifujin-na-magonote', 'casual', 'What video games do you enjoy?')
    expect(active).toContain('REAL QUESTION/ANSWER PAIRS')
    expect(active).not.toContain('PUBLIC-EVIDENCE REFERENCE')
  })

})
