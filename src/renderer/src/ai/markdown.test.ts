import { describe, expect, it } from 'vitest'
import { parse } from './markdown'

describe('AI answer formatting', () => {
  it('reads headings, lists, bold, quotes and code', () => {
    const blocks = parse(
      '## Ideas\n\nThree **bold** options:\n\n1. A *storm*\n2. A `letter`\n\n- one\n- two\n\n> quoted line\n\n```\ncode here\n```',
    )
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'ol', 'ul', 'quote', 'pre'])
    expect(blocks[1]).toEqual({
      t: 'p',
      c: [
        { t: 'text', s: 'Three ' },
        { t: 'b', c: [{ t: 'text', s: 'bold' }] },
        { t: 'text', s: ' options:' },
      ],
    })
    expect(blocks[2]).toMatchObject({
      t: 'ol',
      start: 1,
      items: [[{ t: 'text', s: 'A ' }, { t: 'i' }], expect.anything()],
    })
    expect(blocks[5]).toEqual({ t: 'pre', s: 'code here' })
  })

  it('treats anything else as plain text (no HTML)', () => {
    expect(parse('<img src=x onerror=alert(1)>')).toEqual([
      { t: 'p', c: [{ t: 'text', s: '<img src=x onerror=alert(1)>' }] },
    ])
  })
})
