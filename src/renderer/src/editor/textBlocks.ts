/**
 * The chapter as plain text blocks (paragraphs, headings), for AI fixes, and
 * a way to put chosen changes back without disturbing the rest: each block's
 * text lines up one-to-one with its positions in the document (a line break
 * is "\n", any other inline object one placeholder), so an offset in the
 * text is an offset in the block.
 */
import type { Node as PMNode } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'

export const OBJECT = '￼'

export interface TextBlock {
  /** Position of the block node in the document. */
  pos: number
  text: string
}

export function textBlocks(doc: PMNode): TextBlock[] {
  const out: TextBlock[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    node.forEach((child) => {
      text += child.isText ? child.text! : child.type.name === 'hardBreak' ? '\n' : OBJECT
    })
    out.push({ pos, text })
    return false
  })
  return out
}

export interface BlockChange {
  block: number
  start: number
  end: number
  text: string
}

/**
 * Applies changes to the blocks they were worked out from. A block whose
 * text has changed since is left alone, and so is a change that would cut
 * through a line break or an inline object. Returns how many were applied.
 */
export function applyBlockChanges(
  tr: Transaction,
  expected: string[],
  changes: BlockChange[],
): number {
  const blocks = textBlocks(tr.doc)
  let applied = 0
  // From the end backwards, so earlier positions stay valid.
  const ordered = [...changes].sort((a, b) => b.block - a.block || b.start - a.start)
  for (const c of ordered) {
    const block = blocks[c.block]
    if (!block || block.text !== expected[c.block]) continue
    const before = block.text.slice(c.start, c.end)
    if (before.includes(OBJECT) || before.includes('\n') || c.text.includes(OBJECT)) continue
    const from = block.pos + 1 + c.start
    const to = block.pos + 1 + c.end
    if (c.text) tr.insertText(c.text, from, to)
    else tr.delete(from, to)
    applied++
  }
  return applied
}
