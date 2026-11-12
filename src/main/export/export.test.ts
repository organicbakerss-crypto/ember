import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { DEFAULT_EXPORT_STYLE, type Manuscript } from '@shared/manuscript/blocks'
import { manuscriptDocx } from './docx'
import { manuscriptEpub } from './epub'

const m: Manuscript = {
  title: 'One & Only',
  series: 'Saga',
  author: 'G. Writer',
  chapters: [
    {
      title: 'Arrival',
      type: 'chapter',
      number: 1,
      blocks: [
        {
          kind: 'paragraph',
          runs: [{ text: 'Mara ' }, { text: 'ran', bold: true }, { text: '.' }],
        },
        { kind: 'break' },
        {
          kind: 'list',
          ordered: true,
          items: [[{ kind: 'paragraph', runs: [{ text: 'first' }] }]],
        },
      ],
    },
    {
      title: '',
      type: 'interlude',
      number: null,
      blocks: [{ kind: 'paragraph', runs: [{ text: 'Rain.' }] }],
    },
  ],
}

describe('Word export', () => {
  it('is a .docx with every chapter heading and word in it', async () => {
    const files = unzipSync(await manuscriptDocx(m, DEFAULT_EXPORT_STYLE))
    expect(Object.keys(files)).toContain('word/document.xml')
    const xml = strFromU8(files['word/document.xml']!)
    for (const t of [
      'One &amp; Only',
      'G. Writer',
      'Chapter 1: Arrival',
      'Mara ',
      'ran',
      '* * *',
      'first',
      'Interlude',
      'Rain.',
    ])
      expect(xml).toContain(t)
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('w:pageBreakBefore')
  })
})

describe('EPUB export', () => {
  it('is a valid EPUB layout: mimetype first and stored, a package, a table of contents, one file per chapter', () => {
    const bytes = manuscriptEpub(
      m,
      DEFAULT_EXPORT_STYLE,
      new Date('2026-11-01T10:00:00Z'),
      'urn:uuid:test',
    )
    // The first entry's name starts at byte 30 of the zip, uncompressed (method 0 at byte 8).
    expect(strFromU8(bytes.slice(30, 38))).toBe('mimetype')
    expect(bytes[8]).toBe(0)
    const files = unzipSync(bytes)
    expect(strFromU8(files['mimetype']!)).toBe('application/epub+zip')
    const opf = strFromU8(files['OEBPS/content.opf']!)
    expect(opf).toContain('<dc:title>One &amp; Only</dc:title>')
    expect(opf).toContain('<dc:creator>G. Writer</dc:creator>')
    expect(opf).toContain('2026-11-01T10:00:00Z')
    expect(Object.keys(files).filter((f) => /chapter-\d+\.xhtml$/.test(f))).toHaveLength(2)
    const nav = strFromU8(files['OEBPS/nav.xhtml']!)
    expect(nav).toContain('Chapter 1: Arrival')
    expect(nav).toContain('Interlude')
    const ch1 = strFromU8(files['OEBPS/chapter-001.xhtml']!)
    expect(ch1).toContain('<p>Mara <strong>ran</strong>.</p>')
    expect(ch1).toContain('<ol><li><p>first</p></li></ol>')
  })
})

describe('pictures in exports', () => {
  const file = 'b'.repeat(64) + '.png'
  // A 1×1 PNG.
  const png = Uint8Array.from(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )
  const withPic: Manuscript = {
    ...m,
    chapters: [
      {
        title: 'Maps',
        type: 'chapter',
        number: 1,
        blocks: [
          { kind: 'paragraph', runs: [{ text: 'See:' }] },
          { kind: 'image', file, alt: 'The coast' },
        ],
      },
    ],
    images: { [file]: { mime: 'image/png', data: png } },
  }

  it('puts the picture in the EPUB and its package', () => {
    const files = unzipSync(manuscriptEpub(withPic, DEFAULT_EXPORT_STYLE, new Date(), 'urn:x'))
    expect(files[`OEBPS/images/${file}`]).toEqual(png)
    expect(strFromU8(files['OEBPS/content.opf']!)).toContain(`href="images/${file}"`)
    expect(strFromU8(files['OEBPS/chapter-001.xhtml']!)).toContain(
      `<img src="images/${file}" alt="The coast"/>`,
    )
  })

  it('puts the picture in the Word file', async () => {
    const files = unzipSync(await manuscriptDocx(withPic, DEFAULT_EXPORT_STYLE))
    expect(Object.keys(files).some((f) => f.startsWith('word/media/'))).toBe(true)
  })

  it('shows the description when the picture is missing', () => {
    const files = unzipSync(
      manuscriptEpub({ ...withPic, images: {} }, DEFAULT_EXPORT_STYLE, new Date(), 'urn:x'),
    )
    expect(strFromU8(files['OEBPS/chapter-001.xhtml']!)).toContain('The coast')
  })
})
