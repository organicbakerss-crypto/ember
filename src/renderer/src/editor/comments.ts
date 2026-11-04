/**
 * Comments on the text: a note to self on a passage. Each is a mark on the
 * passage carrying its note, so it moves with the words, comes back with
 * undo, and is saved, synced and kept in history with the chapter. Exports
 * leave it out (they only know formatting marks).
 */
import { Mark, mergeAttributes } from '@tiptap/core'
import type { Mark as PMMark, Node as PMNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'

export interface CommentInfo {
  id: string
  note: string
  /** When it was made (ISO). */
  at: string
  /** The passage it's on (all of it, if it's in several pieces). */
  text: string
  from: number
  to: number
}

export const CommentMark = Mark.create({
  name: 'comment',
  // Typing at either end doesn't stretch the comment.
  inclusive: false,
  // Comments can overlap one another.
  excludes: '',
  addAttributes() {
    return {
      id: { default: null },
      note: { default: '' },
      at: { default: null },
    }
  },
  renderHTML({ HTMLAttributes, mark }) {
    return [
      'span',
      mergeAttributes(
        { class: 'comment-mark', 'data-comment': mark.attrs['id'] as string },
        { title: (mark.attrs['note'] as string) || 'Comment' },
        HTMLAttributes.class ? { class: HTMLAttributes.class as string } : {},
      ),
      0,
    ]
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-comment]',
        getAttrs: (el) => ({ id: (el as HTMLElement).dataset['comment'] ?? null }),
      },
    ]
  },
})

let made = 0
const newId = () => `cmt_${Date.now().toString(36)}${(++made).toString(36)}`

/** Every comment in the chapter, in reading order. */
export function listComments(doc: PMNode): CommentInfo[] {
  const byId = new Map<string, CommentInfo>()
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    for (const m of node.marks) {
      if (m.type.name !== 'comment') continue
      const id = String(m.attrs['id'])
      const end = pos + node.nodeSize
      const c = byId.get(id)
      if (c) {
        c.text += (pos > c.to ? ' … ' : '') + node.text
        c.to = end
      } else {
        byId.set(id, {
          id,
          note: String(m.attrs['note'] ?? ''),
          at: String(m.attrs['at'] ?? ''),
          text: node.text ?? '',
          from: pos,
          to: end,
        })
      }
    }
    return false
  })
  return [...byId.values()].sort((a, b) => a.from - b.from)
}

/** Puts a new comment on the selection; null when nothing is selected. */
export function addCommentTr(
  state: EditorState,
  note = '',
): { tr: Transaction; id: string } | null {
  const { from, to, empty } = state.selection
  if (empty || !state.doc.textBetween(from, to).trim()) return null
  const id = newId()
  const mark = state.schema.marks['comment']!.create({ id, note, at: new Date().toISOString() })
  return { tr: state.tr.addMark(from, to, mark), id }
}

/** Each piece of a comment (it may be split by formatting): its range and mark. */
function pieces(doc: PMNode, id: string): { from: number; to: number; mark: PMMark }[] {
  const out: { from: number; to: number; mark: PMMark }[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return true
    const m = node.marks.find((x) => x.type.name === 'comment' && x.attrs['id'] === id)
    if (m) out.push({ from: pos, to: pos + node.nodeSize, mark: m })
    return false
  })
  return out
}

/** Changes a comment's note. */
export function setNoteTr(state: EditorState, id: string, note: string): Transaction | null {
  const found = pieces(state.doc, id)
  if (!found.length) return null
  const tr = state.tr
  for (const p of found) {
    tr.removeMark(p.from, p.to, p.mark)
    tr.addMark(p.from, p.to, p.mark.type.create({ ...p.mark.attrs, note }))
  }
  return tr
}

/** Takes a comment off (the text stays as it is). */
export function removeCommentTr(state: EditorState, id: string): Transaction | null {
  const found = pieces(state.doc, id)
  if (!found.length) return null
  const tr = state.tr
  for (const p of found) tr.removeMark(p.from, p.to, p.mark)
  return tr
}
