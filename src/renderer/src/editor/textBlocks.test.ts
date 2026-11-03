import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { Node } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import { chapterExtensions } from './extensions'
import { applyBlockChanges, textBlocks } from './textBlocks'
import { diffText } from '@shared/ai/diff'

const schema = getSchema(chapterExtensions())

describe('text blocks', () => {
  it('puts chosen fixes back, keeping bold and line breaks', () => {
    const doc = Node.fromJSON(schema, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'teh ' },
            { type: 'text', text: 'brave', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' cat' },
            { type: 'hardBreak' },
            { type: 'text', text: 'sat ,here' },
          ],
        },
        { type: 'sceneBreak' },
        { type: 'paragraph', content: [{ type: 'text', text: 'All fine.' }] },
      ],
    })
    const blocks = textBlocks(doc)
    expect(blocks.map((b) => b.text)).toEqual(['teh brave cat\nsat ,here', 'All fine.'])
    const fixed = 'The brave cat\nsat, here'
    const changes = diffText(blocks[0]!.text, fixed).map((c) => ({ block: 0, ...c, text: c.after }))
    const state = EditorState.create({ doc })
    const tr = state.tr
    expect(
      applyBlockChanges(
        tr,
        blocks.map((b) => b.text),
        changes,
      ),
    ).toBe(changes.length)
    const after = tr.doc
    expect(textBlocks(after).map((b) => b.text)).toEqual([fixed, 'All fine.'])
    // Bold survives on its word.
    const json = JSON.stringify(after.toJSON())
    expect(json).toContain('{"type":"text","marks":[{"type":"bold"}],"text":"brave"}')
  })

  it('leaves a block alone if it changed since', () => {
    const doc = Node.fromJSON(schema, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'teh end' }] }],
    })
    const tr = EditorState.create({ doc }).tr
    expect(
      applyBlockChanges(tr, ['something else'], [{ block: 0, start: 0, end: 3, text: 'the' }]),
    ).toBe(0)
  })
})
