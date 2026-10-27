import { describe, expect, it } from 'vitest'
import { countWords, docToText, docWordCount } from './text'

describe('word counts', () => {
  it('counts words', () => {
    expect(countWords('')).toBe(0)
    expect(countWords("It wasn't a well-lit room — 3 doors.")).toBe(7)
  })

  it('keeps words in separate blocks apart', () => {
    const doc = {
      type: 'doc' as const,
      content: [
        { type: 'heading', content: [{ type: 'text', text: 'One' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Two ' },
            { type: 'text', text: 'three', marks: [{ type: 'bold' }] },
            { type: 'hardBreak' },
            { type: 'text', text: 'four' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'five' }] },
      ],
    }
    expect(docToText(doc)).toBe('One\nTwo three\nfour\nfive\n')
    expect(docWordCount(doc)).toBe(5)
  })

  it('handles an empty document', () => {
    expect(docWordCount({ type: 'doc' })).toBe(0)
  })
})
