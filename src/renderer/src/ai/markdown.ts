/**
 * The few bits of Markdown AI answers use: headings, lists, quotes, code,
 * bold, italics. Parsed into plain data and drawn as React elements, never
 * as raw HTML, so an answer can't inject anything into the page.
 */
export type Inline =
  | { t: 'text'; s: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'code'; s: string }

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][]; start?: number }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'pre'; s: string }
  | { t: 'hr' }

export function inline(text: string): Inline[] {
  const out: Inline[] = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g
  let at = 0
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ t: 'text', s: text.slice(at, m.index) })
    const tok = m[0]
    if (tok.startsWith('`')) out.push({ t: 'code', s: tok.slice(1, -1) })
    else if (tok.startsWith('**') || tok.startsWith('__'))
      out.push({ t: 'b', c: inline(tok.slice(2, -2)) })
    else out.push({ t: 'i', c: inline(tok.slice(1, -1)) })
    at = m.index + tok.length
  }
  if (at < text.length) out.push({ t: 'text', s: text.slice(at) })
  return out
}

export function parse(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: inline(para.join(' ')) })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^\s*```/.test(line)) {
      flush()
      const code: string[] = []
      while (++i < lines.length && !/^\s*```/.test(lines[i]!)) code.push(lines[i]!)
      blocks.push({ t: 'pre', s: code.join('\n') })
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ t: 'h', level: h[1]!.length, c: inline(h[2]!) })
      continue
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      flush()
      blocks.push({ t: 'hr' })
      continue
    }
    if (/^\s*>/.test(line)) {
      flush()
      const quoted: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!))
        quoted.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      i--
      blocks.push({ t: 'quote', blocks: parse(quoted.join('\n')) })
      continue
    }
    const ul = /^\s*[-*•+]\s+(.*)$/.exec(line)
    const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flush()
      const kind = ul ? 'ul' : 'ol'
      const items: Inline[][] = []
      const start = ol ? Number(ol[1]) : undefined
      while (i < lines.length) {
        const l = lines[i]!
        const m = kind === 'ul' ? /^\s*[-*•+]\s+(.*)$/.exec(l) : /^\s*\d+[.)]\s+(.*)$/.exec(l)
        if (m) items.push(inline(m[1]!))
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          // A wrapped line of the item above.
          items[items.length - 1]!.push({ t: 'text', s: ` ${l.trim()}` })
        } else break
        i++
      }
      i--
      blocks.push(kind === 'ol' ? { t: 'ol', items, start } : { t: 'ul', items })
      continue
    }
    para.push(line.trim())
  }
  flush()
  return blocks
}
