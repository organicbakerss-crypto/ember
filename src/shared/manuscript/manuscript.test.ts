import { describe, expect, it } from 'vitest'
import type { RichTextDoc } from '../schema'
import {
  blockImages,
  chapterHeading,
  DEFAULT_EXPORT_STYLE,
  docToBlocks,
  numberChapters,
  type Manuscript,
} from './blocks'
import { bookHtmlForPrint, chapterBodyHtml, chapterPlainText, royalRoadHtml } from './html'
import { chapterMarkdown, manuscriptMarkdown } from './markdown'

const text = (t: string, ...marks: (string | { type: string; attrs: object })[]) => ({
  type: 'text',
  text: t,
  marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)),
})
const doc = (...content: object[]) => ({ type: 'doc', content }) as RichTextDoc

const sample = doc(
  {
    type: 'paragraph',
    content: [
      text('Mara '),
      text('ran', 'bold'),
      text(' to the '),
      text('harbour', 'italic'),
      text('.'),
    ],
  },
  { type: 'sceneBreak' },
  {
    type: 'paragraph',
    content: [
      text('A *star*', { type: 'textStyle', attrs: { color: '#c0392b', fontFamily: 'Georgia' } }),
      { type: 'hardBreak' },
      text('next <line>'),
    ],
  },
  { type: 'blockquote', content: [{ type: 'paragraph', content: [text('A letter.')] }] },
  {
    type: 'bulletList',
    content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('one')] }] }],
  },
  { type: 'paragraph' },
)

describe('the manuscript model', () => {
  it('turns a chapter into blocks and runs, keeping every word', () => {
    const blocks = docToBlocks(sample)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'break', 'paragraph', 'quote', 'list'])
    const first = blocks[0]!
    expect(
      first.kind === 'paragraph' && first.runs.map((r) => [r.text, !!r.bold, !!r.italic]),
    ).toEqual([
      ['Mara ', false, false],
      ['ran', true, false],
      [' to the ', false, false],
      ['harbour', false, true],
      ['.', false, false],
    ])
    const third = blocks[2]!
    expect(third.kind === 'paragraph' && third.runs[0]).toMatchObject({
      color: '#c0392b',
      font: 'Georgia',
    })
  })

  it('numbers chapters, skipping interludes, and heads them as asked', () => {
    const [a, b, c] = numberChapters([
      { title: 'Arrival', type: 'chapter' as const, blocks: [] },
      { title: '', type: 'interlude' as const, blocks: [] },
      { title: 'Storm', type: 'chapter' as const, blocks: [] },
    ])
    expect([a!.number, b!.number, c!.number]).toEqual([1, null, 2])
    expect(chapterHeading(a!, DEFAULT_EXPORT_STYLE)).toBe('Chapter 1: Arrival')
    expect(chapterHeading(b!, DEFAULT_EXPORT_STYLE)).toBe('Interlude')
    expect(chapterHeading(c!, { ...DEFAULT_EXPORT_STYLE, headings: 'number' })).toBe('Chapter 2')
    expect(chapterHeading(c!, { ...DEFAULT_EXPORT_STYLE, headings: 'title' })).toBe('Storm')
  })

  const chapter = {
    title: 'Arrival',
    type: 'chapter' as const,
    number: 1,
    blocks: docToBlocks(sample),
  }

  it('writes Markdown with emphasis, escapes and scene breaks', () => {
    const md = chapterMarkdown(chapter, DEFAULT_EXPORT_STYLE)
    expect(md).toContain('# Chapter 1: Arrival')
    expect(md).toContain('Mara **ran** to the _harbour_.')
    expect(md).toContain('\\* \\* \\*')
    expect(md).toContain('A \\*star\\*  \nnext \\<line\\>')
    expect(md).toContain('> _A letter._'.replace('_A letter._', 'A letter.'))
    expect(md).toContain('- one')
    const m: Manuscript = { title: 'One', series: 'Saga', author: 'G. Writer', chapters: [chapter] }
    expect(manuscriptMarkdown(m, DEFAULT_EXPORT_STYLE)).toMatch(
      /^# One\n\n_by G\. Writer_\n\n## Chapter 1: Arrival/,
    )
  })

  it('copies for Royal Road: paragraphs and emphasis only, no fonts or colours', () => {
    const html = royalRoadHtml(chapter, DEFAULT_EXPORT_STYLE)
    expect(html).toContain('<p>Mara <strong>ran</strong> to the <em>harbour</em>.</p>')
    expect(html).toContain('<p class="scene-break" style="text-align: center">* * *</p>')
    expect(html).toContain('A *star*<br>next &lt;line&gt;')
    expect(html).not.toMatch(/font-family|color:/)
    expect(chapterPlainText(chapter, DEFAULT_EXPORT_STYLE)).toContain(
      'Mara ran to the harbour.\n\n* * *',
    )
  })

  it('prints a book: title page, each chapter on a new page, the chosen paper', () => {
    const m: Manuscript = { title: 'One', series: 'Saga', author: '', chapters: [chapter] }
    const html = bookHtmlForPrint(m, { ...DEFAULT_EXPORT_STYLE, paragraphs: 'indented' }, 'trade')
    expect(html).toContain('size: 6in 9in')
    expect(html).toContain('<h1 class="chapter-title">Chapter 1: Arrival</h1>')
    expect(html).toContain('text-indent: 1.5em')
    expect(html).toContain('font-family: Georgia')
  })
})

describe('pictures in the manuscript model', () => {
  it('reads a picture node as an image block and lists the pictures', () => {
    const file = 'c'.repeat(64) + '.jpg'
    const blocks = docToBlocks({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] },
        { type: 'chapterImage', attrs: { file, alt: 'A gate' } },
        { type: 'chapterImage', attrs: { file: null, alt: '' } },
      ],
    })
    expect(blocks[1]).toEqual({ kind: 'image', file, alt: 'A gate' })
    expect(blocks).toHaveLength(2)
    expect(blockImages(blocks)).toEqual([file])
  })

  it('shows a placeholder in Markdown and the picture in HTML', () => {
    const file = 'c'.repeat(64) + '.jpg'
    const ch = {
      title: 'A',
      type: 'chapter' as const,
      number: 1,
      blocks: [{ kind: 'image' as const, file, alt: 'A gate' }],
    }
    expect(chapterBodyHtml(ch, DEFAULT_EXPORT_STYLE, false, (f) => `x/${f}`)).toContain(
      `<img src="x/${file}" alt="A gate">`,
    )
    expect(chapterBodyHtml(ch, DEFAULT_EXPORT_STYLE)).toContain('[Picture: A gate]')
  })
})
