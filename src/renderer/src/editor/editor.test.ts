import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { Node } from '@tiptap/pm/model'
import { chapterExtensions } from './extensions'
import { docWords, findScenes } from './scenes'

const schema = getSchema(chapterExtensions())
const para = (text: string, marks?: { type: string }[]) => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
})

describe('chapter schema', () => {
  it('accepts the content the editor writes', () => {
    const doc = Node.fromJSON(schema, {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Part' }] },
        para('Bold', [{ type: 'bold' }]),
        { type: 'sceneBreak' },
        { type: 'blockquote', content: [para('A letter.')] },
      ],
    })
    expect(() => doc.check()).not.toThrow()
  })

  it('accepts plain paragraphs written by earlier versions', () => {
    const doc = Node.fromJSON(schema, {
      type: 'doc',
      content: [para('One'), { type: 'paragraph' }],
    })
    expect(() => doc.check()).not.toThrow()
  })

  it('rejects unknown node types instead of silently dropping them', () => {
    expect(() =>
      Node.fromJSON(schema, { type: 'doc', content: [{ type: 'mysteryBlock' }] }),
    ).toThrow()
  })
})

describe('scenes and word counts', () => {
  it('splits a chapter at scene breaks, labelled by their first words', () => {
    const doc = Node.fromJSON(schema, {
      type: 'doc',
      content: [
        para('The storm came in from the west and nobody slept.'),
        { type: 'sceneBreak' },
        { type: 'paragraph' },
        para('Morning.'),
      ],
    })
    const scenes = findScenes(doc)
    expect(scenes.map((s) => s.label)).toEqual(['The storm came in from the…', 'Morning.'])
    expect(scenes[0]!.pos).toBe(0)
    expect(doc.nodeAt(scenes[1]!.pos)?.type.name).toBe('sceneBreak')
    expect(docWords(doc)).toBe(11)
  })
})
