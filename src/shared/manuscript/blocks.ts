/**
 * A chapter's rich text as simple blocks and runs, the common shape every
 * export format is built from (Markdown, HTML for Royal Road, EPUB and PDF,
 * Word). View-only things (Rhythm, Echo, linked names) are never in the
 * file, so they never reach an export.
 */
import type { RichTextDoc } from '../schema'

export interface Run {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** A font chosen in the toolbar (kept in Word, EPUB and PDF; dropped in plain formats). */
  font?: string
  color?: string
  /** A line break inside the paragraph (Shift+Enter). */
  lineBreak?: boolean
}

export type Block =
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'heading'; level: 2 | 3; runs: Run[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'list'; ordered: boolean; items: Block[][] }
  /** A scene break. */
  | { kind: 'break' }
  /** A picture: its file in the book's images folder, and a description. */
  | { kind: 'image'; file: string; alt: string }

interface Node {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  marks?: { type?: string; attrs?: Record<string, unknown> }[]
  content?: Node[]
}

function runsOf(nodes: Node[] | undefined): Run[] {
  const runs: Run[] = []
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') {
      runs.push({ text: '', lineBreak: true })
      continue
    }
    if (n.type !== 'text' || !n.text) continue
    const run: Run = { text: n.text }
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') run.bold = true
      else if (m.type === 'italic') run.italic = true
      else if (m.type === 'underline') run.underline = true
      else if (m.type === 'strike') run.strike = true
      else if (m.type === 'textStyle') {
        if (typeof m.attrs?.['fontFamily'] === 'string') run.font = m.attrs['fontFamily']
        if (typeof m.attrs?.['color'] === 'string') run.color = m.attrs['color']
      }
    }
    runs.push(run)
  }
  return runs
}

function blocksOf(nodes: Node[] | undefined): Block[] {
  const out: Block[] = []
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'paragraph':
        out.push({ kind: 'paragraph', runs: runsOf(n.content) })
        break
      case 'heading':
        out.push({
          kind: 'heading',
          level: n.attrs?.['level'] === 3 ? 3 : 2,
          runs: runsOf(n.content),
        })
        break
      case 'blockquote':
        out.push({ kind: 'quote', blocks: blocksOf(n.content) })
        break
      case 'bulletList':
      case 'orderedList':
        out.push({
          kind: 'list',
          ordered: n.type === 'orderedList',
          items: (n.content ?? []).map((item) => blocksOf(item.content)),
        })
        break
      case 'sceneBreak':
        out.push({ kind: 'break' })
        break
      case 'chapterImage':
        if (typeof n.attrs?.['file'] === 'string')
          out.push({
            kind: 'image',
            file: n.attrs['file'],
            alt: typeof n.attrs['alt'] === 'string' ? n.attrs['alt'] : '',
          })
        break
      default:
        // Anything else that holds text is kept as paragraphs, so no words are dropped.
        if (n.content?.length) out.push(...blocksOf(n.content))
    }
  }
  return out
}

/** A chapter's text as blocks. Empty trailing paragraphs are left out. */
export function docToBlocks(doc: RichTextDoc): Block[] {
  const blocks = blocksOf((doc as Node).content)
  while (blocks.length) {
    const last = blocks[blocks.length - 1]!
    if (last.kind === 'paragraph' && !last.runs.some((r) => r.text.trim())) blocks.pop()
    else break
  }
  return blocks
}

/** The picture files some blocks use (in quotes and lists too). */
export function blockImages(blocks: Block[]): string[] {
  return blocks.flatMap((b) =>
    b.kind === 'image'
      ? [b.file]
      : b.kind === 'quote'
        ? blockImages(b.blocks)
        : b.kind === 'list'
          ? b.items.flatMap(blockImages)
          : [],
  )
}

/** The plain text of some runs. */
export function runsText(runs: Run[]): string {
  return runs.map((r) => (r.lineBreak ? '\n' : r.text)).join('')
}

/* ---------- a whole manuscript ---------- */

export interface ManuscriptChapter {
  title: string
  type: 'chapter' | 'interlude'
  /** Numbered chapters count from 1 in the volume; interludes are not numbered. */
  number: number | null
  blocks: Block[]
}

export interface Manuscript {
  /** The volume's name (the book's title). */
  title: string
  series: string
  author: string
  chapters: ManuscriptChapter[]
  /** The pictures the chapters use, by file (exports that embed them). */
  images?: Record<string, { mime: string; data: Uint8Array }>
}

export interface ExportStyle {
  /** How chapter headings read: "Chapter 1: Arrival", "Chapter 1", or "Arrival". */
  headings: 'both' | 'number' | 'title'
  /** What marks a scene break, e.g. "* * *". */
  sceneBreak: string
  /** Book-style indented paragraphs, or web-style spaced paragraphs. */
  paragraphs: 'spaced' | 'indented'
}

export const DEFAULT_EXPORT_STYLE: ExportStyle = {
  headings: 'both',
  sceneBreak: '* * *',
  paragraphs: 'spaced',
}

/** A chapter's heading for export: "Chapter 1: Arrival", "Interlude: The Tide", … */
export function chapterHeading(chapter: ManuscriptChapter, style: ExportStyle): string {
  const label =
    chapter.type === 'interlude' ? 'Interlude' : `Chapter ${chapter.number ?? ''}`.trim()
  const title = chapter.title.trim()
  if (style.headings === 'title') return title || label
  if (style.headings === 'number' || !title) return label
  return `${label}: ${title}`
}

/** Numbers chapters in reading order (interludes are skipped). */
export function numberChapters<C extends { type: 'chapter' | 'interlude' }>(
  chapters: C[],
): (C & { number: number | null })[] {
  let n = 0
  return chapters.map((c) => ({ ...c, number: c.type === 'interlude' ? null : ++n }))
}
