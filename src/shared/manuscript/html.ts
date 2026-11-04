/**
 * HTML for exports: one chapter for Royal Road (paragraphs and simple
 * emphasis that paste cleanly into its editor), and whole books for EPUB
 * (XHTML) and PDF (printed from HTML).
 */
import {
  chapterHeading,
  runsText,
  type Block,
  type ExportStyle,
  type Manuscript,
  type ManuscriptChapter,
  type Run,
} from './blocks'

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A colour or font from the chapter file, safe to put in a style attribute. */
const safeStyle = (value: string) => value.replace(/[^#\w\s,'.-]/g, '')

interface HtmlOptions {
  /** Keep fonts and colours chosen in the toolbar (not for Royal Road). */
  styled: boolean
  /** XHTML (EPUB): self-closing empty elements. */
  xhtml?: boolean
}

function runsHtml(runs: Run[], o: HtmlOptions): string {
  return runs
    .map((r) => {
      if (r.lineBreak) return o.xhtml ? '<br/>' : '<br>'
      let t = escapeHtml(r.text)
      if (r.strike) t = `<s>${t}</s>`
      if (r.underline) t = `<u>${t}</u>`
      if (r.italic) t = `<em>${t}</em>`
      if (r.bold) t = `<strong>${t}</strong>`
      if (o.styled && (r.font || r.color)) {
        const css = [
          r.font ? `font-family: ${safeStyle(r.font)}` : '',
          r.color ? `color: ${safeStyle(r.color)}` : '',
        ]
          .filter(Boolean)
          .join('; ')
        t = `<span style="${css}">${t}</span>`
      }
      return t
    })
    .join('')
}

function blocksHtml(blocks: Block[], style: ExportStyle, o: HtmlOptions): string {
  return blocks
    .map((b) => {
      if (b.kind === 'paragraph') {
        // An empty paragraph keeps its space (a deliberate blank line).
        const inner = runsHtml(b.runs, o)
        return `<p>${inner || (o.xhtml ? '&#160;' : '&nbsp;')}</p>`
      }
      if (b.kind === 'heading') return `<h${b.level + 1}>${runsHtml(b.runs, o)}</h${b.level + 1}>`
      if (b.kind === 'break')
        return `<p class="scene-break" style="text-align: center">${escapeHtml(style.sceneBreak)}</p>`
      if (b.kind === 'quote') return `<blockquote>${blocksHtml(b.blocks, style, o)}</blockquote>`
      const tag = b.ordered ? 'ol' : 'ul'
      return `<${tag}>${b.items.map((item) => `<li>${blocksHtml(item, style, o)}</li>`).join('')}</${tag}>`
    })
    .join('\n')
}

/**
 * One chapter for pasting into Royal Road: the chapter's paragraphs and
 * emphasis only (its title goes in Royal Road's own title box).
 */
export function royalRoadHtml(chapter: ManuscriptChapter, style: ExportStyle): string {
  return blocksHtml(chapter.blocks, style, { styled: false })
}

/** The same chapter as plain text (what's pasted where HTML isn't taken). */
export function chapterPlainText(chapter: ManuscriptChapter, style: ExportStyle): string {
  const lines = (blocks: Block[]): string[] =>
    blocks.flatMap((b) => {
      if (b.kind === 'paragraph' || b.kind === 'heading') return [runsText(b.runs)]
      if (b.kind === 'break') return [style.sceneBreak]
      if (b.kind === 'quote') return lines(b.blocks)
      return b.items.flatMap((item, i) =>
        lines(item).map((l) => `${b.ordered ? `${i + 1}.` : '•'} ${l}`),
      )
    })
  return lines(chapter.blocks).join('\n\n')
}

/** A chapter's body (heading and text) for a book. */
export function chapterBodyHtml(
  chapter: ManuscriptChapter,
  style: ExportStyle,
  xhtml = false,
): string {
  return `<h1 class="chapter-title">${escapeHtml(chapterHeading(chapter, style))}</h1>\n${blocksHtml(
    chapter.blocks,
    style,
    { styled: true, xhtml },
  )}`
}

/** Rich text (an entry's page, say) as HTML, with its fonts and colours. */
export function blocksToHtml(blocks: Block[], style: ExportStyle): string {
  return blocksHtml(blocks, style, { styled: true })
}

/** The book's typography, shared by EPUB and PDF. */
export function bookCss(style: ExportStyle): string {
  const paragraphs =
    style.paragraphs === 'indented'
      ? 'p { margin: 0; text-indent: 1.5em; } h1 + p, .scene-break + p, p.scene-break { text-indent: 0; }'
      : 'p { margin: 0 0 0.9em; text-indent: 0; }'
  return `
body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.55; }
h1.chapter-title { font-size: 1.6em; font-weight: normal; text-align: center; margin: 2em 0 1.5em; }
h3 { font-size: 1.25em; } h4 { font-size: 1.1em; }
${paragraphs}
p.scene-break { text-align: center; margin: 1em 0; }
blockquote { margin: 0.8em 2em; font-style: italic; }
.title-page { text-align: center; margin-top: 30%; }
.title-page h1 { font-size: 2.2em; font-weight: normal; margin-bottom: 0.4em; }
.title-page .series { font-style: italic; margin-bottom: 2em; }
`
}

export type PaperSize = 'a4' | 'letter' | 'trade'

const PAGE_SIZES: Record<PaperSize, string> = {
  a4: 'A4',
  letter: 'letter',
  trade: '6in 9in',
}

/** A whole book as one HTML page for printing to PDF: a title page, then each chapter on a new page. */
export function bookHtmlForPrint(m: Manuscript, style: ExportStyle, paper: PaperSize): string {
  const chapters = m.chapters
    .map((c) => `<section class="chapter">${chapterBodyHtml(c, style)}</section>`)
    .join('\n')
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(m.title)}</title>
<style>
@page { size: ${PAGE_SIZES[paper]}; margin: ${paper === 'trade' ? '0.75in 0.7in' : '1in'}; }
${bookCss(style)}
body { margin: 0; font-size: ${paper === 'trade' ? '10.5pt' : '12pt'}; }
section.chapter { break-before: page; }
.title-page { break-after: page; }
</style></head>
<body>
<div class="title-page"><h1>${escapeHtml(m.title)}</h1>${
    m.series && m.series !== m.title ? `<p class="series">${escapeHtml(m.series)}</p>` : ''
  }${m.author.trim() ? `<p>${escapeHtml(m.author.trim())}</p>` : ''}</div>
${chapters}
</body></html>`
}
