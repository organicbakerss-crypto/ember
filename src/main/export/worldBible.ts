/**
 * A world as a series bible: a title page and contents, then every entry
 * (grouped by Where / Who / When / How and kind) with its portrait, tags,
 * facts, relationships, page and pictures. Printed to PDF.
 */
import { docToBlocks, DEFAULT_EXPORT_STYLE } from '@shared/manuscript/blocks'
import { blocksToHtml, escapeHtml } from '@shared/manuscript/html'
import type { RelationshipFile, RelationshipType, Template, WorldEntryFile } from '@shared/schema'
import { LENSES } from '@shared/world/lenses'
import { effectiveTemplate, LENS_LABELS } from '@shared/world/templates'

export interface BibleInput {
  worldName: string
  entries: WorldEntryFile[]
  templates: Template[]
  relationships: RelationshipFile[]
  relationshipTypes: RelationshipType[]
  /** An image file's data URI (or null when it can't be read). */
  image: (file: string) => string | null
}

const slug = (id: string) => `e-${id}`

export function worldBibleHtml(input: BibleInput): string {
  const names = new Map(input.entries.map((e) => [e.id, e.name]))
  const templateOf = (e: WorldEntryFile) => effectiveTemplate(input.templates, e.template, e.facts)
  const lensOf = (e: WorldEntryFile) =>
    input.templates.find((t) => t.id === e.template)?.lens ?? 'how'
  const kindName = (e: WorldEntryFile) =>
    input.templates.find((t) => t.id === e.template)?.name ?? 'Note'
  const typeLabel = (id: string) => input.relationshipTypes.find((t) => t.id === id)?.label ?? id

  const groups = LENSES.map((lens) => ({
    lens,
    entries: input.entries
      .filter((e) => lensOf(e) === lens)
      .sort((a, b) => kindName(a).localeCompare(kindName(b)) || a.name.localeCompare(b.name)),
  })).filter((g) => g.entries.length)

  const entryHtml = (e: WorldEntryFile) => {
    const t = templateOf(e)
    const facts = t.fields
      .map((f) => {
        const values = (e.facts[f.id] ?? [])
          .map((v) => (v.link ? (names.get(v.link) ?? '') : (v.text ?? '')))
          .filter(Boolean)
        return values.length
          ? `<dt>${escapeHtml(f.label)}</dt><dd>${values.map(escapeHtml).join(', ')}</dd>`
          : ''
      })
      .join('')
    const ties = input.relationships
      .filter((r) => r.from === e.id || r.to === e.id)
      .map((r) => {
        const other = names.get(r.from === e.id ? r.to : r.from)
        if (!other) return ''
        const words = r.label || typeLabel(r.type)
        return `<li>${escapeHtml(other)} <span class="muted">(${escapeHtml(words)}${r.over ? ', over' : ''})</span></li>`
      })
      .filter(Boolean)
      .join('')
    const portrait = e.portrait && input.image(e.portrait.file)
    const body = blocksToHtml(docToBlocks(e.body), DEFAULT_EXPORT_STYLE)
    const pictures = e.gallery
      .map((p) => {
        const src = input.image(p.file)
        return src
          ? `<figure><img src="${src}" alt="">${p.caption ? `<figcaption>${escapeHtml(p.caption)}</figcaption>` : ''}</figure>`
          : ''
      })
      .join('')
    return `<section class="entry" id="${slug(e.id)}">
<header>${
      portrait
        ? `<img class="portrait" src="${portrait}" alt="" style="object-position: ${(e.portrait!.crop.x * 100).toFixed(0)}% ${(e.portrait!.crop.y * 100).toFixed(0)}%">`
        : ''
    }<div><h2>${escapeHtml(e.name)}</h2><p class="kind">${escapeHtml(kindName(e))}${
      e.aliases.length ? ` · also called ${e.aliases.map(escapeHtml).join(', ')}` : ''
    }</p>${e.tags.length ? `<p class="tags">${e.tags.map((t) => `#${escapeHtml(t)}`).join(' ')}</p>` : ''}</div></header>
${facts ? `<dl>${facts}</dl>` : ''}
${body.replace(/<p>&nbsp;<\/p>/g, '').trim() ? `<div class="body">${body}</div>` : ''}
${ties ? `<h3>Relationships</h3><ul>${ties}</ul>` : ''}
${pictures ? `<div class="pictures">${pictures}</div>` : ''}
</section>`
  }

  const contents = groups
    .map(
      (g) =>
        `<h3>${escapeHtml(LENS_LABELS[g.lens])}</h3><ol>${g.entries
          .map(
            (e) =>
              `<li><a href="#${slug(e.id)}">${escapeHtml(e.name)}</a> <span class="muted">${escapeHtml(kindName(e))}</span></li>`,
          )
          .join('')}</ol>`,
    )
    .join('')

  const sections = groups
    .map(
      (g) =>
        `<section class="lens"><h1>${escapeHtml(LENS_LABELS[g.lens])}</h1>${g.entries.map(entryHtml).join('\n')}</section>`,
    )
    .join('\n')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(input.worldName)}</title><style>
@page { size: A4; margin: 2cm; }
body { font-family: Georgia, 'Times New Roman', serif; line-height: 1.5; color: #222; }
.title-page { text-align: center; margin-top: 35%; page-break-after: always; }
.title-page h1 { font-size: 2.4em; font-weight: normal; margin-bottom: 0.3em; }
.contents { page-break-after: always; }
.contents ol { padding-left: 1.2em; }
.contents a { color: inherit; text-decoration: none; }
.lens { page-break-before: always; }
.lens > h1 { font-size: 1.8em; font-weight: normal; border-bottom: 1px solid #999; padding-bottom: 0.2em; }
.entry { margin: 1.6em 0 2.2em; page-break-inside: avoid; }
.entry header { display: flex; gap: 1em; align-items: center; }
.entry h2 { margin: 0; font-size: 1.4em; }
.portrait { width: 5.5em; height: 5.5em; object-fit: cover; border-radius: 6px; }
.kind, .tags, .muted { color: #666; font-size: 0.9em; margin: 0.1em 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.2em 1em; margin: 0.8em 0; }
dt { font-weight: bold; } dd { margin: 0; }
.body p { margin: 0 0 0.7em; }
h3 { font-size: 1.05em; margin: 1em 0 0.3em; }
.pictures { display: flex; flex-wrap: wrap; gap: 0.8em; }
.pictures figure { margin: 0; width: 45%; }
.pictures img { width: 100%; border-radius: 4px; }
figcaption { font-size: 0.85em; color: #555; }
</style></head><body>
<div class="title-page"><h1>${escapeHtml(input.worldName)}</h1><p>Series bible · ${input.entries.length} ${input.entries.length === 1 ? 'entry' : 'entries'}</p></div>
<div class="contents"><h1>Contents</h1>${contents}</div>
${sections}
</body></html>`
}
