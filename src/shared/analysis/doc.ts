/** Paragraph texts of a saved chapter (TipTap JSON), for analysis. Scene breaks are skipped. */
interface JsonNode {
  type?: string
  text?: string
  content?: JsonNode[]
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading'])

export function docParagraphs(doc: unknown): string[] {
  const out: string[] = []
  const inline = (node: JsonNode): string =>
    node.type === 'text' ? (node.text ?? '') : node.type === 'hardBreak' ? '\n' : ''
  const walk = (node: JsonNode) => {
    if (node.type && TEXT_BLOCKS.has(node.type)) {
      out.push((node.content ?? []).map(inline).join(''))
      return
    }
    node.content?.forEach(walk)
  }
  walk(doc as JsonNode)
  return out
}
