import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { chapterExtensions } from './extensions'
import {
  addCommentTr,
  aiNotesTr,
  clearAiNotes,
  listComments,
  removeCommentTr,
  setNoteTr,
} from './comments'

const make = (text = 'Mara walked to the harbour. The wind was cold.') =>
  new Editor({
    extensions: chapterExtensions(),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  })

const select = (e: Editor, from: number, to: number) =>
  e.view.dispatch(e.state.tr.setSelection(TextSelection.create(e.state.doc, from, to)))

describe('comments', () => {
  it('needs a selection; adds a comment that lists with its passage', () => {
    const e = make()
    expect(addCommentTr(e.state)).toBeNull()
    select(e, 1, 5)
    const made = addCommentTr(e.state, 'Is she Mara or Mary?')!
    e.view.dispatch(made.tr)
    expect(listComments(e.state.doc)).toMatchObject([
      { id: made.id, note: 'Is she Mara or Mary?', text: 'Mara', from: 1, to: 5 },
    ])
  })

  it('keeps one comment across formatting inside it, and edits or removes all of it', () => {
    const e = make()
    select(e, 1, 12)
    const { tr, id } = addCommentTr(e.state, 'first')!
    e.view.dispatch(tr)
    select(e, 6, 9) // bold "wal" inside the comment: it's now in pieces
    e.commands.toggleBold()
    expect(listComments(e.state.doc)).toHaveLength(1)
    e.view.dispatch(setNoteTr(e.state, id, 'second')!)
    expect(listComments(e.state.doc)[0]!.note).toBe('second')
    expect(listComments(e.state.doc)[0]!.text).toBe('Mara walked')
    e.view.dispatch(removeCommentTr(e.state, id)!)
    expect(listComments(e.state.doc)).toEqual([])
    expect(e.state.doc.textContent).toBe('Mara walked to the harbour. The wind was cold.')
  })

  it('lets comments overlap, and typing at the edge stays outside', () => {
    const e = make()
    select(e, 1, 12)
    e.view.dispatch(addCommentTr(e.state, 'a')!.tr)
    select(e, 6, 20)
    e.view.dispatch(addCommentTr(e.state, 'b')!.tr)
    expect(listComments(e.state.doc).map((c) => c.note)).toEqual(['a', 'b'])
    // Type right after the end of the first comment's passage.
    select(e, 12, 12)
    e.view.dispatch(e.state.tr.insertText('X'))
    const a = listComments(e.state.doc).find((c) => c.note === 'a')!
    expect(a.text).toBe('Mara walked')
  })

  it('survives a save and reload as JSON', () => {
    const e = make()
    select(e, 1, 5)
    const { tr, id } = addCommentTr(e.state, 'note')!
    e.view.dispatch(tr)
    const again = new Editor({ extensions: chapterExtensions(), content: e.getJSON() })
    expect(listComments(again.state.doc)).toMatchObject([{ id, note: 'note', text: 'Mara' }])
  })
})

describe('AI notes', () => {
  it('go on the words they quote (curly quotes or not), across formatting, without changing the text', () => {
    const e = make('“Fine,” Mara said. She sat down. She sat down.')
    select(e, 2, 6) // italic inside the quote: the words are in pieces
    e.commands.toggleItalic()
    const { tr, placed } = aiNotesTr(e.state, [
      { quote: '"Fine," Mara said.', note: 'Who is she talking to?' },
      { quote: 'She sat down.', note: 'first' },
      { quote: 'She sat down.', note: 'She sat down twice.' },
      { quote: 'not in the text', note: 'skipped' },
    ])
    e.view.dispatch(tr)
    expect(placed).toBe(3)
    const listed = listComments(e.state.doc)
    expect(listed.map((c) => [c.text, c.by])).toEqual([
      ['“Fine,” Mara said.', 'ai'],
      ['She sat down.', 'ai'],
      ['She sat down.', 'ai'],
    ])
    expect(listed[1]!.from).toBeLessThan(listed[2]!.from)
    expect(e.state.doc.textContent).toBe('“Fine,” Mara said. She sat down. She sat down.')
  })

  it('a new read replaces the AI notes and leaves the writer’s own comments', () => {
    const e = make()
    select(e, 1, 5)
    e.view.dispatch(addCommentTr(e.state, 'mine')!.tr)
    e.view.dispatch(aiNotesTr(e.state, [{ quote: 'The wind', note: 'old' }]).tr)
    e.view.dispatch(aiNotesTr(e.state, [{ quote: 'harbour', note: 'new' }]).tr)
    expect(listComments(e.state.doc).map((c) => c.note)).toEqual(['mine', 'new'])
    e.view.dispatch(clearAiNotes(e.state))
    expect(listComments(e.state.doc).map((c) => c.note)).toEqual(['mine'])
  })
})
