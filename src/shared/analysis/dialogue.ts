/**
 * Which parts of a paragraph are dialogue (inside quotation marks). Handles
 * curly and straight double quotes, «guillemets», and ‘single’ quotes used as
 * dialogue. An unclosed quote runs to the end of the paragraph, the usual
 * way to write speech that continues into the next paragraph.
 */
import type { Range } from './sentences'

export function dialogueRanges(text: string): Range[] {
  const ranges: Range[] = []
  let open: { at: number; close: string } | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (open) {
      const closes = c === open.close && (open.close !== '’' || !/[\p{L}]/u.test(text[i + 1] ?? ''))
      if (closes) {
        ranges.push({ start: open.at, end: i + 1 })
        open = null
      }
      continue
    }
    if (c === '“') open = { at: i, close: '”' }
    else if (c === '«') open = { at: i, close: '»' }
    else if (c === '"') open = { at: i, close: '"' }
    else if (c === '‘' && !/[\p{L}]/u.test(text[i - 1] ?? '')) open = { at: i, close: '’' }
  }
  if (open) ranges.push({ start: open.at, end: text.length })
  return ranges
}
