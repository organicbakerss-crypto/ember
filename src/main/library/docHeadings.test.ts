import { describe, expect, it } from 'vitest'
import { docHeadings } from './library'

describe('docHeadings', () => {
  it('lists heading texts in order, skipping empty ones', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Mara' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'She ran.' }] },
        { type: 'heading', content: [] },
        { type: 'heading', content: [{ type: 'text', text: 'Teo interlude' }] },
      ],
    }
    expect(docHeadings(doc)).toEqual(['Mara', 'Teo interlude'])
  })
})
