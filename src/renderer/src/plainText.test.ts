import { describe, expect, it } from 'vitest'
import { docToPlainText, isPlainDoc, plainTextToDoc } from './plainText'

describe('plain text bridge', () => {
  it('round-trips text, including blank lines', () => {
    const text = 'First line.\n\nThird line, after a gap.\n'
    expect(docToPlainText(plainTextToDoc(text))).toBe(text)
  })

  it('treats an empty document as plain', () => {
    expect(isPlainDoc({ type: 'doc', content: [] })).toBe(true)
    expect(isPlainDoc(plainTextToDoc('hello\nworld'))).toBe(true)
  })

  it('refuses formatted documents so formatting is never stripped', () => {
    const bold = {
      type: 'doc' as const,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi', marks: [{ type: 'bold' }] }] },
      ],
    }
    const heading = { type: 'doc' as const, content: [{ type: 'heading', content: [] }] }
    const aligned = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', attrs: { textAlign: 'center' } }],
    }
    expect(isPlainDoc(bold)).toBe(false)
    expect(isPlainDoc(heading)).toBe(false)
    expect(isPlainDoc(aligned)).toBe(false)
  })
})
