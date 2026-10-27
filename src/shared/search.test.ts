import { describe, expect, it } from 'vitest'
import { findInText, replaceInDoc, searchPattern, textNodes } from './search'

const opts = (o: Partial<{ matchCase: boolean; wholeWord: boolean }> = {}) => ({
  matchCase: false,
  wholeWord: false,
  ...o,
})

describe('search', () => {
  it('finds text, ignoring case unless asked', () => {
    expect(findInText('Mara saw mara.', searchPattern('mara', opts())!)).toHaveLength(2)
    expect(findInText('Mara saw mara.', searchPattern('mara', opts({ matchCase: true }))!)).toEqual(
      [{ start: 9, end: 13 }],
    )
  })

  it('matches whole words only when asked, including accented letters', () => {
    const p = searchPattern('cat', opts({ wholeWord: true }))!
    expect(findInText('cat, cats, bobcat, cat.', p)).toHaveLength(2)
    expect(findInText('écat cat', searchPattern('cat', opts({ wholeWord: true }))!)).toHaveLength(1)
  })

  it('treats the query as plain text, not a pattern', () => {
    expect(findInText('a.b axb (x)', searchPattern('a.b', opts())!)).toHaveLength(1)
    expect(findInText('(x)', searchPattern('(x)', opts())!)).toHaveLength(1)
    expect(searchPattern('', opts())).toBeNull()
  })

  it('replaces across text nodes, keeping formatting and dropping emptied nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Mara ' },
            { type: 'text', text: 'Mara', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' and mara.' },
          ],
        },
      ],
    }
    const { doc: out, count } = replaceInDoc(doc, searchPattern('mara', opts())!, 'Lena')
    expect(count).toBe(3)
    expect(textNodes(out).map((n) => n.text)).toEqual(['Lena ', 'Lena', ' and Lena.'])
    expect(out.content[0]!.content[1]).toMatchObject({ marks: [{ type: 'bold' }] })
    expect(textNodes(doc)[0]!.text).toBe('Mara ') // the original is untouched

    const { doc: emptied } = replaceInDoc(doc, searchPattern('mara', opts())!, '')
    expect(textNodes(emptied).map((n) => n.text)).toEqual([' ', ' and .'])
  })
})
