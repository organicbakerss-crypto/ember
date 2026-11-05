import { describe, expect, it } from 'vitest'
import { findPassages, pickSummaries, searchTerms, storyParts } from './lookup'

const chapters = [
  {
    label: 'Chapter 1',
    title: 'Rain',
    paragraphs: ['Mara walks to the harbour.', 'The rain falls.'],
    summary: 'Mara arrives at the harbour.',
  },
  {
    label: 'Chapter 2',
    title: 'Ash',
    paragraphs: ['Teo burns the letter.', 'Mara finds the ashes of the letter.'],
    summary: 'Teo hides the letter.',
  },
]

describe('lookup', () => {
  it('finds names and longer words, skipping common ones', () => {
    expect(searchTerms('What did Mara do with the letter?', ['Mara Voss', 'Mara'])).toEqual([
      'mara',
      'letter',
    ])
  })
  it('picks summaries and passages that touch the question, in story order', () => {
    expect(pickSummaries(chapters, ['letter'])).toEqual(['Chapter 2 “Ash”: Teo hides the letter.'])
    const passages = findPassages(chapters, ['mara', 'letter'], 2)
    expect(passages).toEqual([
      '(Chapter 1 “Rain”) Mara walks to the harbour.',
      '(Chapter 2 “Ash”) Mara finds the ashes of the letter.',
    ])
  })
  it('cuts the story into parts with chapter labels', () => {
    const parts = storyParts(chapters, 6)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0]).toContain('## Chapter 1 “Rain”')
    expect(parts.join('\n')).toContain('Teo burns the letter.')
  })
})
