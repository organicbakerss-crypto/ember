import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { joinBackward, deleteSelection } from '@tiptap/pm/commands'
import { ChapterSection, INTERNAL, ManuscriptDocument, guardPlugin, sectionIds } from './sections'

const schema = getSchema([
  StarterKit.configure({ document: false }),
  ManuscriptDocument,
  ChapterSection,
])
const doc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    {
      type: 'chapterSection',
      attrs: { chapterId: 'a', heading: 'Chapter 1' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One.' }] }],
    },
    {
      type: 'chapterSection',
      attrs: { chapterId: 'b', heading: 'Chapter 2' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two.' }] }],
    },
  ],
})
const state = (locked: string[] = []) =>
  EditorState.create({ doc, plugins: [guardPlugin(() => new Set(locked))] })
/** Position inside chapter b's first paragraph, at offset `k`. */
const inB = (s: EditorState, k: number) => s.doc.child(0).nodeSize + 2 + k

describe('the manuscript’s locked chapter boundaries', () => {
  it('typing inside a chapter is fine', () => {
    const s = state()
    const next = s.apply(s.tr.insertText('Hey ', inB(s, 0)))
    expect(next.doc.child(1).textContent).toBe('Hey Two.')
  })

  it('Backspace at a chapter’s start does not merge it into the one before', () => {
    let s = state()
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, inB(s, 0))))
    let result = s
    joinBackward(s, (tr) => (result = s.apply(tr)))
    expect(sectionIds(result.doc)).toEqual(['a', 'b'])
    expect(result.doc.child(0).textContent).toBe('One.')
  })

  it('deleting a selection that spans two chapters is refused', () => {
    let s = state()
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 3, inB(s, 2))))
    let result = s
    deleteSelection(s, (tr) => (result = s.apply(tr)))
    expect(sectionIds(result.doc)).toEqual(['a', 'b'])
    expect(result.doc.textContent).toBe('One.Two.')
  })

  it('a chapter being edited elsewhere can’t be changed here; others can', () => {
    const s = state(['b'])
    expect(s.apply(s.tr.insertText('x', inB(s, 0))).doc.child(1).textContent).toBe('Two.')
    expect(s.apply(s.tr.insertText('x', 2)).doc.child(0).textContent).toBe('xOne.')
    // The app itself may put in a version saved elsewhere.
    const internal = s.tr.insertText('x', inB(s, 0)).setMeta(INTERNAL, true)
    expect(s.apply(internal).doc.child(1).textContent).toBe('xTwo.')
  })
})
