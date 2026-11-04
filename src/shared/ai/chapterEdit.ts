/**
 * A chapter as Markdown for the AI to edit, and the edited Markdown back as a
 * chapter. One top-level block (paragraph, heading, scene break, quote, list)
 * per Markdown block. A block the AI gave back unchanged keeps its original
 * node exactly (fonts, colours and all); only changed or new blocks are
 * rebuilt from the Markdown.
 */
import { isSceneBreakLine } from '../manuscript/importSplit'

export interface DocNode {
  type: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  content?: DocNode[]
}

/* ---------- chapter → Markdown ---------- */

function inlineMd(nodes: DocNode[] | undefined): string {
  let out = ''
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      out += '\n'
      continue
    }
    if (n.type !== 'text' || !n.text) continue
    let t = n.text
    const has = (m: string) => n.marks?.some((x) => x.type === m)
    // Spaces stay outside the marks, as Markdown needs.
    const lead = /^\s*/.exec(t)![0]
    const trail = /\s*$/.exec(t)![0]
    let core = t.slice(lead.length, t.length - trail.length)
    if (core) {
      if (has('underline')) core = `<u>${core}</u>`
      if (has('strike')) core = `~~${core}~~`
      if (has('italic')) core = `*${core}*`
      if (has('bold')) core = `**${core}**`
    }
    t = lead + core + trail
    out += t
  }
  return out
}

/** One top-level node as Markdown. */
export function blockMd(node: DocNode): string {
  switch (node.type) {
    case 'paragraph':
      return inlineMd(node.content)
    case 'heading':
      return `${node.attrs?.['level'] === 3 ? '###' : '##'} ${inlineMd(node.content)}`
    case 'sceneBreak':
      return '* * *'
    case 'blockquote':
      return (node.content ?? [])
        .map((p) => blockMd(p))
        .join('\n\n')
        .split('\n')
        .map((l) => `> ${l}`.trimEnd())
        .join('\n')
    case 'bulletList':
    case 'orderedList':
      return (node.content ?? [])
        .map((item, i) => {
          const text = (item.content ?? []).map((p) => blockMd(p)).join(' ')
          return `${node.type === 'orderedList' ? `${i + 1}.` : '-'} ${text}`
        })
        .join('\n')
    default:
      return (node.content ?? []).map((c) => blockMd(c)).join('\n')
  }
}

export function docBlocks(doc: { content?: DocNode[] }): { md: string; node: DocNode }[] {
  return (doc.content ?? []).map((node) => ({ md: blockMd(node), node }))
}

export function docToMarkdown(doc: { content?: DocNode[] }): string {
  return docBlocks(doc)
    .map((b) => b.md)
    .join('\n\n')
}

/* ---------- Markdown → chapter ---------- */

type Mark = { type: string }

/** Inline Markdown (bold, italic, strike, underline) as text nodes with marks. */
export function inlineNodes(text: string, marks: Mark[] = []): DocNode[] {
  const out: DocNode[] = []
  const re =
    /(\*\*[^*]+?\*\*|__[^_]+?__|~~[^~]+?~~|<u>[\s\S]+?<\/u>|\*[^*\s][^*]*?\*|_[^_\s][^_]*?_|\n)/g
  let at = 0
  const push = (s: string, m: Mark[]) => {
    if (!s) return
    out.push(m.length ? { type: 'text', text: s, marks: m } : { type: 'text', text: s })
  }
  for (const match of text.matchAll(re)) {
    push(text.slice(at, match.index), marks)
    const tok = match[0]
    if (tok === '\n') out.push({ type: 'hardBreak' })
    else if (tok.startsWith('**') || tok.startsWith('__'))
      out.push(...inlineNodes(tok.slice(2, -2), [...marks, { type: 'bold' }]))
    else if (tok.startsWith('~~'))
      out.push(...inlineNodes(tok.slice(2, -2), [...marks, { type: 'strike' }]))
    else if (tok.startsWith('<u>'))
      out.push(...inlineNodes(tok.slice(3, -4), [...marks, { type: 'underline' }]))
    else out.push(...inlineNodes(tok.slice(1, -1), [...marks, { type: 'italic' }]))
    at = match.index + tok.length
  }
  push(text.slice(at), marks)
  return out
}

const para = (text: string): DocNode => {
  const content = inlineNodes(text)
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

/** One Markdown block as a node. */
export function mdNode(md: string): DocNode {
  const text = md.trim()
  if (isSceneBreakLine(text)) return { type: 'sceneBreak' }
  const h = /^(#{1,6})\s+([\s\S]*)$/.exec(text)
  if (h) {
    const content = inlineNodes(h[2]!.trim())
    return {
      type: 'heading',
      attrs: { level: h[1]!.length >= 3 ? 3 : 2 },
      ...(content.length ? { content } : {}),
    }
  }
  const lines = text.split('\n')
  if (lines.every((l) => /^\s*>/.test(l))) {
    const inner = lines.map((l) => l.replace(/^\s*>\s?/, '')).join('\n')
    return { type: 'blockquote', content: splitBlocks(inner).map((b) => para(b)) }
  }
  if (lines.every((l) => /^\s*[-*•+]\s+/.test(l))) {
    return {
      type: 'bulletList',
      content: lines.map((l) => ({
        type: 'listItem',
        content: [para(l.replace(/^\s*[-*•+]\s+/, ''))],
      })),
    }
  }
  if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
    return {
      type: 'orderedList',
      content: lines.map((l) => ({
        type: 'listItem',
        content: [para(l.replace(/^\s*\d+[.)]\s+/, ''))],
      })),
    }
  }
  return para(text)
}

/** Markdown split into blocks (separated by blank lines). */
export function splitBlocks(md: string): string[] {
  return md
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((b) => b.replace(/^\n+|\n+$/g, ''))
    .filter((b) => b.trim())
}

/** What the AI sent back, without a code fence or a line of chatter around it. */
export function cleanReply(reply: string): string {
  let t = reply.trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t)
  if (fence) t = fence[1]!
  return t
}

/* ---------- old and new, side by side ---------- */

export interface Pair {
  /** Index into the old blocks, or null (added). */
  old: number | null
  /** Index into the new blocks, or null (removed). */
  new: number | null
  same: boolean
}

/**
 * Lines up old and new blocks: identical blocks anchor the alignment, and in
 * between, blocks pair up in order (changed); any left over were added or
 * removed.
 */
export function alignBlocks(oldMd: string[], newMd: string[]): Pair[] {
  const n = oldMd.length
  const m = newMd.length
  const key = (s: string) => s.trim()
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        key(oldMd[i]!) === key(newMd[j]!)
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const pairs: Pair[] = []
  let i = 0
  let j = 0
  let gapOld: number[] = []
  let gapNew: number[] = []
  const flushGap = () => {
    const k = Math.max(gapOld.length, gapNew.length)
    for (let x = 0; x < k; x++)
      pairs.push({ old: gapOld[x] ?? null, new: gapNew[x] ?? null, same: false })
    gapOld = []
    gapNew = []
  }
  while (i < n || j < m) {
    if (i < n && j < m && key(oldMd[i]!) === key(newMd[j]!)) {
      flushGap()
      pairs.push({ old: i++, new: j++, same: true })
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) gapNew.push(j++)
    else gapOld.push(i++)
  }
  flushGap()
  return pairs
}

/** The new chapter from the AI's Markdown: unchanged blocks keep their original nodes. */
export function editedDoc(
  old: { content?: DocNode[] },
  reply: string,
): {
  doc: { type: 'doc'; content: DocNode[] }
  oldBlocks: { md: string; node: DocNode }[]
  newBlocks: { md: string; node: DocNode }[]
  pairs: Pair[]
} {
  const oldBlocks = docBlocks(old)
  const mds = splitBlocks(cleanReply(reply))
  const pairs = alignBlocks(
    oldBlocks.map((b) => b.md),
    mds,
  )
  const newBlocks = mds.map((md) => ({ md, node: mdNode(md) }))
  for (const p of pairs) {
    if (p.same && p.old !== null && p.new !== null) newBlocks[p.new]!.node = oldBlocks[p.old]!.node
  }
  return {
    doc: { type: 'doc', content: newBlocks.map((b) => b.node) },
    oldBlocks,
    newBlocks,
    pairs,
  }
}

/** The chapter with some changes undone (`undone[k]` for pair k). */
export function assemble(
  pairs: Pair[],
  oldBlocks: { node: DocNode }[],
  newBlocks: { node: DocNode }[],
  undone: boolean[],
): { type: 'doc'; content: DocNode[] } {
  const content: DocNode[] = []
  pairs.forEach((p, k) => {
    const useOld = undone[k] && !p.same
    if (useOld) {
      if (p.old !== null) content.push(oldBlocks[p.old]!.node)
    } else if (p.new !== null) content.push(newBlocks[p.new]!.node)
  })
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}
