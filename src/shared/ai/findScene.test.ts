import { describe, expect, it } from 'vitest'
import {
  findParagraphPrompt,
  paragraphProbe,
  parseChapterMatches,
  parseParagraph,
  pickChaptersPrompt,
} from './findScene'

describe('finding a scene by describing it', () => {
  it('lists the chapters with their summaries and passages', () => {
    const p = pickChaptersPrompt('Josh lies about the van', [
      { ref: 'C1', label: 'Chapter 1', title: 'Hired', summary: 'Josh starts.', passages: [] },
      { ref: 'C2', label: 'Chapter 2', title: '', summary: null, passages: ['The van was gone.'] },
    ])
    expect(p.user).toContain('[C1] Chapter 1 “Hired”: Josh starts.')
    expect(p.user).toContain('[C2] Chapter 2 “Untitled” (no summary yet)\n    – The van was gone.')
  })

  it('keeps only real chapters, once each, at most three', () => {
    const refs = new Set(['C1', 'C2', 'C3', 'C4'])
    const reply =
      'ok {"matches": [{"chapter": "[c2]", "why": "the lie"}, {"chapter": "C9"}, {"chapter": "C2"}, {"chapter": "C1"}, {"chapter": "C3"}, {"chapter": "C4"}]}'
    expect(parseChapterMatches(reply, refs).map((m) => m.ref)).toEqual(['C2', 'C1', 'C3'])
    expect(parseChapterMatches('nothing', refs)).toEqual([])
  })

  it('numbers paragraphs, caps the words, and reads the answer', () => {
    const many = Array.from({ length: 50 }, () => Array(200).fill('w').join(' '))
    const p = findParagraphPrompt('x', 'Chapter 1', many)
    expect(p.shown).toBe(30)
    expect(p.user).toContain('[30] ')
    expect(parseParagraph('{"paragraph": 3, "why": "here"}', p.shown)).toEqual({
      paragraph: 2,
      why: 'here',
    })
    expect(parseParagraph('{"paragraph": 31}', p.shown)).toBeNull()
    expect(parseParagraph('{"paragraph": null}', p.shown)).toBeNull()
  })

  it('probes with the first few words', () => {
    expect(paragraphProbe('  Josh   looked at the van and lied.')).toBe(
      'Josh looked at the van and',
    )
  })
})
