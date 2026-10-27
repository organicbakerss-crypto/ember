/**
 * Bridges the temporary plain-text editor and TipTap JSON. Replaced by the
 * real TipTap editor in the Writing core milestone.
 */
import type { RichTextDoc } from '@shared/schema'

interface TextNode {
  type: 'text'
  text: string
  marks?: unknown[]
}
interface ParagraphNode {
  type: 'paragraph'
  content?: TextNode[]
}

/**
 * True only for documents made of unformatted paragraphs. Anything richer is
 * shown read-only so the plain editor can never strip formatting.
 */
export function isPlainDoc(doc: RichTextDoc): boolean {
  return (doc.content ?? []).every((node) => {
    const p = node as Partial<ParagraphNode> & Record<string, unknown>
    if (p.type !== 'paragraph' || Object.keys(p).some((k) => k !== 'type' && k !== 'content')) {
      return false
    }
    return (p.content ?? []).every((child) => {
      const t = child as Partial<TextNode> & Record<string, unknown>
      return t.type === 'text' && Object.keys(t).every((k) => k === 'type' || k === 'text')
    })
  })
}

export function docToPlainText(doc: RichTextDoc): string {
  return (doc.content ?? [])
    .map((node) => ((node as ParagraphNode).content ?? []).map((t) => t.text).join(''))
    .join('\n')
}

export function plainTextToDoc(text: string): RichTextDoc {
  if (text === '') return { type: 'doc', content: [] }
  return {
    type: 'doc',
    content: text
      .split('\n')
      .map((line) =>
        line === ''
          ? { type: 'paragraph' }
          : { type: 'paragraph', content: [{ type: 'text', text: line }] },
      ),
  }
}
