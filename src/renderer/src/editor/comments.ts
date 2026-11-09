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
  /** 'ai' for a note the AI left (shown only while the AI is on); null: the writer's own. */
  by: string | null
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
      by: { default: null },
    }
  },
  renderHTML({ HTMLAttributes, mark }) {
    return [
      'span',
      mergeAttributes(
        {
          class: mark.attrs['by'] === 'ai' ? 'comment-mark ai-note' : 'comment-mark',
          'data-comment': mark.attrs['id'] as string,
        },
        // AI notes have no tooltip: they show in the Comments panel only while the AI is on.
        mark.attrs['by'] === 'ai' ? {} : { title: (mark.attrs['note'] as string) || 'Comment' },
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
          by: typeof m.attrs['by'] === 'string' ? (m.attrs['by'] as string) : null,
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

/** Each text block's text, with the document position of every character in it. */
function blocksWithPositions(doc: PMNode): { text: string; at: number[] }[] {
  const out: { text: string; at: number[] }[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    const at: number[] = []
    node.forEach((child, offset) => {
      if (!child.isText) return
      const start = pos + 1 + offset
      for (let i = 0; i < child.text!.length; i++) at.push(start + i)
      text += child.text
    })
    out.push({ text, at })
    return false
  })
  return out
}

/** Straight quotes and plain spaces, one character for one. */
function plain(text: string): string {
  return text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[–—]/g, '-')
}

/**
 * Puts AI notes on the words they quote (one step), taking off the AI's
 * earlier notes first; the writer's own comments are left alone. Notes whose
 * words can't be found are skipped. Returns the transaction and how many were placed.
 */
export function aiNotesTr(
  state: EditorState,
  notes: readonly { quote: string; note: string }[],
): { tr: Transaction; placed: number } {
  const tr = clearAiNotes(state, state.tr)
  const blocks = blocksWithPositions(tr.doc).map((b) => ({
    ...b,
    plain: plain(b.text).toLowerCase(),
  }))
  const used = new Set<string>()
  let placed = 0
  const now = new Date().toISOString()
  for (const n of notes) {
    const quote = plain(n.quote.trim()).toLowerCase()
    if (!quote) continue
    for (const [bi, b] of blocks.entries()) {
      let from = b.plain.indexOf(quote)
      // The same words noted twice go on the next place they appear.
      while (from >= 0 && used.has(`${bi}:${from}`)) from = b.plain.indexOf(quote, from + 1)
      if (from < 0) continue
      used.add(`${bi}:${from}`)
      const start = b.at[from]!
      const end = b.at[from + quote.length - 1]! + 1
      tr.addMark(
        start,
        end,
        state.schema.marks['comment']!.create({ id: newId(), note: n.note, at: now, by: 'ai' }),
      )
      placed++
      break
    }
  }
  return { tr, placed }
}

/** Takes the AI's notes off (into the given transaction, or a new one). */
export function clearAiNotes(state: EditorState, tr: Transaction = state.tr): Transaction {
  tr.doc.descendants((node, pos) => {
    if (!node.isText) return true
    for (const m of node.marks) {
      if (m.type.name === 'comment' && m.attrs['by'] === 'ai')
        tr.removeMark(pos, pos + node.nodeSize, m)
    }
    return false
  })
  return tr
}
