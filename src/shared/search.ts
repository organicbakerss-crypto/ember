/**
 * Find and replace inside chapter text. Matching runs per text node (a run
 * of text with the same formatting), the same way in the main process (on
 * saved files) and in the editor, so a result can be found again on the page.
 */

export interface SearchOptions {
  matchCase: boolean
  wholeWord: boolean
}

export interface TextRange {
  start: number
  end: number
}

const LETTER = '[\\p{L}\\p{N}_]'

export function searchPattern(query: string, options: SearchOptions): RegExp | null {
  if (!query) return null
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = options.wholeWord ? `(?<!${LETTER})${escaped}(?!${LETTER})` : escaped
  return new RegExp(body, options.matchCase ? 'gu' : 'giu')
}

export function findInText(text: string, pattern: RegExp): TextRange[] {
  const ranges: TextRange[] = []
  pattern.lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) continue
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

interface JsonNode {
  type?: string
  text?: string
  content?: JsonNode[]
}

/** Text nodes of a document in reading order. */
export function textNodes(doc: unknown): JsonNode[] {
  const out: JsonNode[] = []
  const walk = (node: JsonNode) => {
    if (node.type === 'text' && typeof node.text === 'string') out.push(node)
    node.content?.forEach(walk)
  }
  walk(doc as JsonNode)
  return out
}

/**
 * Replaces every match in a document (a copy is returned). Formatting stays
 * with the text it belongs to; a node emptied by the replacement is removed.
 */
export function replaceInDoc<T>(
  doc: T,
  pattern: RegExp,
  replacement: string,
): { doc: T; count: number } {
  const copy = structuredClone(doc) as JsonNode
  let count = 0
  for (const node of textNodes(copy)) {
    const ranges = findInText(node.text!, pattern)
    if (!ranges.length) continue
    count += ranges.length
    let next = ''
    let last = 0
    for (const r of ranges) {
      next += node.text!.slice(last, r.start) + replacement
      last = r.end
    }
    node.text = next + node.text!.slice(last)
  }
  const prune = (node: JsonNode) => {
    if (!node.content) return
    node.content = node.content.filter((c) => !(c.type === 'text' && !c.text))
    node.content.forEach(prune)
  }
  prune(copy)
  return { doc: copy as T, count }
}
