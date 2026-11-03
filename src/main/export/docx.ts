/** Word (.docx) export: a title page, then each chapter on a new page, styled for reading or editing. */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
  type IRunOptions,
} from 'docx'
import {
  chapterHeading,
  type Block,
  type ExportStyle,
  type Manuscript,
  type Run,
} from '@shared/manuscript/blocks'

const INDENT = 360 // first-line indent, in twentieths of a point (a quarter inch)

function runOptions(r: Run): IRunOptions {
  if (r.lineBreak) return { text: '', break: 1 }
  return {
    text: r.text,
    bold: r.bold,
    italics: r.italic,
    underline: r.underline ? {} : undefined,
    strike: r.strike,
    font: r.font?.split(',')[0]?.replace(/['"]/g, '').trim() || undefined,
    color: r.color && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color.slice(1) : undefined,
  }
}

export async function manuscriptDocx(m: Manuscript, style: ExportStyle): Promise<Uint8Array> {
  let lists = 0
  const body = (blocks: Block[], quote = false): Paragraph[] =>
    blocks.flatMap((b): Paragraph[] => {
      if (b.kind === 'paragraph') {
        return [
          new Paragraph({
            children: b.runs.map(
              (r) => new TextRun({ ...runOptions(r), italics: quote || r.italic }),
            ),
            indent: quote
              ? { left: 720, right: 720 }
              : style.paragraphs === 'indented'
                ? { firstLine: INDENT }
                : undefined,
            spacing: { after: style.paragraphs === 'indented' ? 0 : 160, line: 300 },
          }),
        ]
      }
      if (b.kind === 'heading') {
        return [
          new Paragraph({
            heading: b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
            children: b.runs.map((r) => new TextRun(runOptions(r))),
          }),
        ]
      }
      if (b.kind === 'break') {
        return [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 200, after: 200 },
            children: [new TextRun(style.sceneBreak)],
          }),
        ]
      }
      if (b.kind === 'quote') return body(b.blocks, true)
      const instance = ++lists
      return b.items.flatMap((item) =>
        body(item).map((p, i) =>
          // The first paragraph of each item carries the bullet or number.
          i === 0
            ? new Paragraph({
                children:
                  item[0]?.kind === 'paragraph'
                    ? item[0].runs.map((r) => new TextRun(runOptions(r)))
                    : [],
                ...(b.ordered
                  ? { numbering: { reference: 'numbered', level: 0, instance } }
                  : { bullet: { level: 0 } }),
              })
            : p,
        ),
      )
    })

  const title: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 3600, after: 400 },
      children: [new TextRun({ text: m.title, size: 52 })],
    }),
    ...(m.series && m.series !== m.title
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: m.series, italics: true })],
          }),
        ]
      : []),
    ...(m.author.trim()
      ? [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 400 },
            children: [new TextRun(m.author.trim())],
          }),
        ]
      : []),
  ]

  const chapters = m.chapters.flatMap((c) => [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      alignment: AlignmentType.CENTER,
      pageBreakBefore: true,
      spacing: { before: 1200, after: 600 },
      children: [new TextRun(chapterHeading(c, style))],
    }),
    ...body(c.blocks),
  ])

  const doc = new Document({
    title: m.title,
    creator: m.author.trim() || undefined,
    styles: {
      default: { document: { run: { font: 'Georgia', size: 24 } } },
    },
    numbering: {
      config: [
        {
          reference: 'numbered',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START },
          ],
        },
      ],
    },
    sections: [{ children: [...title, ...chapters] }],
  })
  return new Uint8Array(await Packer.toBuffer(doc))
}
