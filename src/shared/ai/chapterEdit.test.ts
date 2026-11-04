import { describe, expect, it } from 'vitest'
import { assemble, docToMarkdown, editedDoc, mdNode } from './chapterEdit'

const doc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Part one' }] },
    {
      type: 'paragraph',
      attrs: { textAlign: 'left' },
      content: [
        { type: 'text', text: 'Mara ' },
        { type: 'text', text: 'ran', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' to teh ' },
        { type: 'text', text: 'harbour', marks: [{ type: 'italic' }] },
        { type: 'text', text: '.' },
      ],
    },
    { type: 'sceneBreak' },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Odo waited',
          marks: [{ type: 'textStyle', attrs: { fontFamily: 'Georgia' } }],
        },
        { type: 'hardBreak' },
        { type: 'text', text: 'by the boats.' },
      ],
    },
  ],
}

describe('chapter edits through Markdown', () => {
  it('writes the chapter as Markdown the AI can edit', () => {
    expect(docToMarkdown(doc)).toBe(
      '## Part one\n\nMara **ran** to teh *harbour*.\n\n* * *\n\nOdo waited\nby the boats.',
    )
  })

  it('keeps unchanged blocks exactly, rebuilds changed ones, adds new ones', () => {
    const reply =
      '```markdown\n## Part one\n\nMara **ran** to the *harbour*.\n\n* * *\n\nOdo waited\nby the boats.\n\nA new paragraph with **bold**.\n```'
    const r = editedDoc(doc, reply)
    expect(
      r.pairs.map((p) =>
        p.same ? 'same' : p.old === null ? 'added' : p.new === null ? 'removed' : 'changed',
      ),
    ).toEqual(['same', 'changed', 'same', 'same', 'added'])
    // Unchanged: the original node, font and all.
    expect(r.doc.content[3]).toBe(doc.content[3])
    expect(r.doc.content[0]).toBe(doc.content[0])
    // Changed: rebuilt from Markdown, with its bold and italic.
    expect(r.doc.content[1]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Mara ' },
        { type: 'text', text: 'ran', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' to the ' },
        { type: 'text', text: 'harbour', marks: [{ type: 'italic' }] },
        { type: 'text', text: '.' },
      ],
    })
    expect(r.doc.content[4]!.content![1]).toEqual({
      type: 'text',
      text: 'bold',
      marks: [{ type: 'bold' }],
    })

    // Undo just the change to paragraph 2: the original comes back, the added one stays.
    const undone = r.pairs.map((_, k) => k === 1)
    const back = assemble(r.pairs, r.oldBlocks, r.newBlocks, undone)
    expect(back.content[1]).toBe(doc.content[1])
    expect(back.content).toHaveLength(5)
    // Undo all: the old chapter.
    expect(
      assemble(
        r.pairs,
        r.oldBlocks,
        r.newBlocks,
        r.pairs.map(() => true),
      ).content,
    ).toEqual(doc.content)
  })

  it('reads headings, quotes, lists and scene breaks', () => {
    expect(mdNode('### Small').type).toBe('heading')
    expect(mdNode('> said once\n> said twice').type).toBe('blockquote')
    expect(mdNode('- a\n- b').content).toHaveLength(2)
    expect(mdNode('1. a\n2. b').type).toBe('orderedList')
    expect(mdNode('***').type).toBe('sceneBreak')
    expect(mdNode('plain <u>under</u> text').content![1]).toEqual({
      type: 'text',
      text: 'under',
      marks: [{ type: 'underline' }],
    })
  })
})
