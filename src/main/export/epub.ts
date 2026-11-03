/**
 * EPUB 3 export (with an EPUB 2 table of contents for older readers): a
 * zip with the `mimetype` first and uncompressed, a title page, and one
 * XHTML file per chapter.
 */
import { randomUUID } from 'node:crypto'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { chapterHeading, type ExportStyle, type Manuscript } from '@shared/manuscript/blocks'
import { bookCss, chapterBodyHtml, escapeHtml } from '@shared/manuscript/html'

const xhtml = (title: string, body: string) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="utf-8"/><title>${escapeHtml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>`

export function manuscriptEpub(
  m: Manuscript,
  style: ExportStyle,
  now = new Date(),
  id = `urn:uuid:${randomUUID()}`,
): Uint8Array {
  const chapters = m.chapters.map((c, i) => ({
    file: `chapter-${String(i + 1).padStart(3, '0')}.xhtml`,
    heading: chapterHeading(c, style),
    html: xhtml(chapterHeading(c, style), chapterBodyHtml(c, style, true)),
  }))
  const modified = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const author = m.author.trim()

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">${escapeHtml(id)}</dc:identifier>
<dc:title>${escapeHtml(m.title)}</dc:title>
<dc:language>en</dc:language>
${author ? `<dc:creator>${escapeHtml(author)}</dc:creator>` : ''}
<meta property="dcterms:modified">${modified}</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${chapters.map((c, i) => `<item id="c${i + 1}" href="${c.file}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine toc="ncx">
<itemref idref="title"/>
${chapters.map((_, i) => `<itemref idref="c${i + 1}"/>`).join('\n')}
</spine>
</package>`

  const nav = xhtml(
    'Contents',
    `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>
${chapters.map((c) => `<li><a href="${c.file}">${escapeHtml(c.heading)}</a></li>`).join('\n')}
</ol></nav>`,
  )
  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeHtml(id)}"/></head>
<docTitle><text>${escapeHtml(m.title)}</text></docTitle>
<navMap>
${chapters
  .map(
    (c, i) =>
      `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeHtml(c.heading)}</text></navLabel><content src="${c.file}"/></navPoint>`,
  )
  .join('\n')}
</navMap>
</ncx>`
  const title = xhtml(
    m.title,
    `<div class="title-page"><h1>${escapeHtml(m.title)}</h1>${
      m.series && m.series !== m.title ? `<p class="series">${escapeHtml(m.series)}</p>` : ''
    }${author ? `<p>${escapeHtml(author)}</p>` : ''}</div>`,
  )

  const files: Zippable = {
    // Must come first, uncompressed, for readers to recognise the file.
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/toc.ncx': strToU8(ncx),
    'OEBPS/style.css': strToU8(bookCss(style)),
    'OEBPS/title.xhtml': strToU8(title),
  }
  for (const c of chapters) files[`OEBPS/${c.file}`] = strToU8(c.html)
  return zipSync(files, { level: 6 })
}
