/** Word counting shared by the main process (volume totals) and the editor. */
import type { RichTextDoc } from './schema'

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0
}

interface DocNode {
  type?: string
  text?: string
  content?: DocNode[]
}

/** Plain text of a TipTap document, with block boundaries kept as line breaks. */
export function docToText(doc: RichTextDoc): string {
  const textOf = (node: DocNode): string => {
    if (node.type === 'text') return node.text ?? ''
    if (node.type === 'hardBreak') return '\n'
    return (node.content ?? [])
      .map((child) =>
        child.type === 'text' || child.type === 'hardBreak' ? textOf(child) : `${textOf(child)}\n`,
      )
      .join('')
  }
  return textOf(doc as DocNode)
}

export function docWordCount(doc: RichTextDoc): number {
  return countWords(docToText(doc))
}
