import { describe, expect, it } from 'vitest'
import { notesParts, pageNotesPrompt, parsePageNotes, plain } from './pageNotes'

describe('AI notes on a chapter', () => {
  it('splits a chapter into parts at paragraph ends', () => {
    const para = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
    expect(notesParts([para(500), para(500), para(500), '  '], 1200)).toHaveLength(2)
    expect(notesParts([para(2000)], 1200)).toHaveLength(1) // a long paragraph stays whole
    expect(notesParts([])).toEqual([])
  })

  it('keeps only notes quoting words that are really there', () => {
    const part = 'Sara’s eyes were green. She sat down. She sat down again.'
    const reply = `Here: {"notes": [
      {"quote": "Sara's eyes were green", "note": "Blue in chapter 2."},
      {"quote": "made up words", "note": "x"},
      {"quote": "She sat down again.", "note": "She already sat."},
      {"quote": "", "note": "no quote"}
    ]}`
    expect(parsePageNotes(reply, part)).toEqual([
      { quote: "Sara's eyes were green", note: 'Blue in chapter 2.' },
      { quote: 'She sat down again.', note: 'She already sat.' },
    ])
    expect(parsePageNotes('not json', part)).toEqual([])
    expect(parsePageNotes('{"notes": "x"}', part)).toEqual([])
  })

  it('plain() keeps positions', () => {
    const s = '“Hi,” she said — it’s late.'
    expect(plain(s)).toHaveLength(s.length)
  })

  it('puts the world and earlier chapters in front of the part', () => {
    const p = pageNotesPrompt({
      part: 'TEXT',
      partNumber: 1,
      parts: 2,
      chapterTitle: 'Ch',
      world: 'W',
      earlier: 'E',
    })
    expect(p.user.indexOf('W')).toBeLessThan(p.user.indexOf('TEXT'))
    expect(p.user).toContain('part 1 of 2')
    expect(p.system).toContain('"notes"')
  })
})
