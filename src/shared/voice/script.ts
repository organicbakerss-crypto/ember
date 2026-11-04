/**
 * A chapter as lines to be spoken: narration and dialogue apart, each with
 * who speaks it, and the text tidied for a voice (a line break inside a
 * paragraph is not a stop). Used for reading aloud and for the script given
 * to VoiceStudio's Audiobook page (`[voice:Name]` before every line, so it
 * reads the same whether a tag carries on or not).
 */

export interface Block {
  /** A paragraph's text, or null for a scene break. */
  text: string | null
}

export interface Segment {
  /** Which block (paragraph) it's from. */
  block: number
  kind: 'narration' | 'quote' | 'break'
  text: string
  /** For quotes: a key that stays the same while the line's words do. */
  key?: string
}

/** A saved chapter's blocks for speaking: paragraphs and headings, and scene breaks (null). */
export function docBlocks(doc: unknown): Block[] {
  interface N {
    type?: string
    text?: string
    content?: N[]
  }
  const out: Block[] = []
  const inline = (n: N): string =>
    n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : ''
  const walk = (n: N) => {
    if (n.type === 'sceneBreak') out.push({ text: null })
    else if (n.type === 'paragraph' || n.type === 'heading') {
      out.push({ text: (n.content ?? []).map(inline).join('') })
    } else n.content?.forEach(walk)
  }
  walk(doc as N)
  return out
}

/** Text tidied for a voice: line breaks and runs of spaces become one space. */
export function speakable(text: string): string {
  return text
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

const OPEN = '“"'
const CLOSE_FOR: Record<string, string> = { '“': '”', '"': '"' }

/** A quote's key: its first words, plain (so a fix to a speaker survives edits elsewhere). */
export const quoteKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)

/**
 * Splits paragraphs into narration and quoted speech. A quote left open at
 * the end of a paragraph carries on into the next (the usual way to write a
 * speech of several paragraphs).
 */
export function segments(blocks: Block[]): Segment[] {
  const out: Segment[] = []
  let open: string | null = null
  blocks.forEach((b, block) => {
    if (b.text === null) {
      open = null
      out.push({ block, kind: 'break', text: '' })
      return
    }
    const text = speakable(b.text)
    if (!text) return
    let at = 0
    let buf = ''
    const flush = (kind: 'narration' | 'quote') => {
      const t = buf.trim()
      if (t) out.push({ block, kind, text: t, ...(kind === 'quote' ? { key: quoteKey(t) } : {}) })
      buf = ''
    }
    // A paragraph that starts a new quote ends any carried-over one.
    if (open && OPEN.includes(text[0]!)) open = null
    while (at < text.length) {
      const ch = text[at]!
      if (!open && OPEN.includes(ch)) {
        flush('narration')
        open = CLOSE_FOR[ch]!
        buf = ch
      } else if (open && ch === open && buf.length > 0) {
        buf += ch
        // Closing punctuation right after the mark stays with the quote.
        flush('quote')
        open = null
      } else buf += ch
      at++
    }
    flush(open ? 'quote' : 'narration')
  })
  return out
}

/**
 * The script for VoiceStudio's Audiobook page: a `# heading` per chapter,
 * every line tagged with who speaks it, a pause at scene breaks.
 */
export function audiobookScript(
  chapters: { heading: string; lines: { voice: string; text: string; kind: Segment['kind'] }[] }[],
): string {
  const out: string[] = []
  for (const c of chapters) {
    if (out.length) out.push('')
    out.push(`# ${c.heading}`)
    for (const l of c.lines) {
      if (l.kind === 'break') out.push('[pause 1s]')
      else out.push(`[voice:${l.voice}] ${l.text}`)
    }
  }
  return `${out.join('\n')}\n`
}
