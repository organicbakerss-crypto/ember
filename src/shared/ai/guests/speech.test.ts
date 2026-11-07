import { describe, expect, it } from 'vitest'
import { RIFUJIN_EXCHANGES } from './rifujin-exchanges'
import { interviewSpeechPrompt, selectInterviewExchanges } from './speech'
import { guestReferenceContext } from './types'

describe('Rifujin V3 source-grounded question/answer construction', () => {
  it('covers a broad range of actual question/answer contexts, not only flawed characters', () => {
    expect(RIFUJIN_EXCHANGES.length).toBeGreaterThanOrEqual(16)
    expect(new Set(RIFUJIN_EXCHANGES.map(x => x.situation))).toEqual(new Set(['casual','social','uncertainty','disagreement','creative']))
    expect(new Set(RIFUJIN_EXCHANGES.map(x => x.source)).size).toBeGreaterThanOrEqual(2)
    const topicList = new Set(RIFUJIN_EXCHANGES.flatMap(x => x.topic))
    for(const topic of ['games','friends','writing','work','books','uncertainty','worldbuilding']) expect(topicList.has(topic)).toBe(true)
    for (const item of RIFUJIN_EXCHANGES) {
      expect(item.question.length).toBeGreaterThan(20)
      expect(item.moves.length).toBeGreaterThanOrEqual(2)
      expect(item.moves.every(move => move.length > 25)).toBe(true)
      expect(item.anchor.length).toBeGreaterThan(5)
      expect(item.source.startsWith('https://')).toBe(true)
      expect(item.language).toBe('ja')
      expect(item.medium).toBe('edited-written-interview')
      if (item.quote) expect(item.quote.length).toBeLessThanOrEqual(25)
    }
  })

  it('selects multiple ordered answer constructions without repeating one conversation pattern', () => {
    for (const situation of ['casual','creative','disagreement','uncertainty','final','vote'] as const) {
      const chosen = selectInterviewExchanges(RIFUJIN_EXCHANGES, situation, 'Should everyone play more video games?')
      expect(chosen.length).toBe(4)
      expect(new Set(chosen.map(x=>x.id)).size).toBe(4)
      expect(chosen.some(x=>x.situation==='casual'||x.situation==='social')).toBe(true)
      expect(selectInterviewExchanges(RIFUJIN_EXCHANGES, situation, 'Should everyone play more video games?')).toEqual(chosen)
    }
    expect(selectInterviewExchanges(RIFUJIN_EXCHANGES,'casual','hello',100).length).toBeLessThanOrEqual(5)
    expect(selectInterviewExchanges(RIFUJIN_EXCHANGES,'casual','hello',0)).toEqual([])
  })

  it('shows real question context and successive response construction, without fabricating English quotations', () => {
    const prompt = interviewSpeechPrompt(RIFUJIN_EXCHANGES,'casual','I have been playing fighting games')
    expect(prompt).toContain('REAL QUESTION/ANSWER PAIRS')
    expect(prompt).toContain('INTERVIEWER ASKED (paraphrase)')
    expect(prompt).toContain('ACTUAL ANSWER CONSTRUCTION (successive moves)')
    expect(prompt).toContain('edited-written-interview')
    expect(prompt).toContain('not English speech')
    expect(prompt).toContain('SOURCE:')
    expect(prompt).not.toContain('He is patient and measured')
    expect(prompt.length).toBeLessThan(6500)
  })

  it('does not expose old personality annotations as active runtime sentence examples', () => {
    const prompt = guestReferenceContext('guest-rifujin-na-magonote', 'disagreement', 'Do you disagree with me about books?')
    expect(prompt).toContain('ACTUAL ANSWER CONSTRUCTION')
    expect(prompt).not.toContain('PUBLIC-EVIDENCE REFERENCE')
    expect(guestReferenceContext('guest-dan-harmon', 'casual', 'hi')).toBe('')
  })

  it('changes construction examples when conversation subject changes', () => {
    const books = selectInterviewExchanges(RIFUJIN_EXCHANGES,'creative','reading books')
    const gaming = selectInterviewExchanges(RIFUJIN_EXCHANGES,'creative','fighting games')
    expect(books.map(x=>x.id)).not.toEqual(gaming.map(x=>x.id))
  })
})
