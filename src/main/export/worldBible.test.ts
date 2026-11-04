import { describe, expect, it } from 'vitest'
import type { WorldEntryFile } from '@shared/schema'
import { BUILT_IN_TEMPLATES } from '@shared/world/templates'
import { worldBibleHtml } from './worldBible'

const entry = (id: string, name: string, template: string, extra: Partial<WorldEntryFile> = {}) =>
  ({
    formatVersion: 1,
    id,
    worldId: 'wld_0000000000000001',
    template,
    name,
    aliases: [],
    facts: {},
    body: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `About ${name} <b>` }] }],
    },
    quotes: [],
    portrait: null,
    tags: [],
    gallery: [],
    mergedFrom: [],
    when: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  }) as WorldEntryFile

describe('world bible', () => {
  it('groups entries by lens with contents, facts, links by name, tags and pictures', () => {
    const mara = entry('ent_000000000000mara', 'Mara', 'person', {
      tags: ['noble houses'],
      aliases: ['the Fox'],
      gallery: [{ file: `${'a'.repeat(64)}.png`, caption: 'Winter coat' }],
    })
    const salt = entry('ent_000000000000salt', 'Saltmere', 'place')
    const lore = entry('ent_000000000000lore', 'History of the Isles', 'page')
    const html = worldBibleHtml({
      worldName: 'Isles',
      entries: [lore, mara, salt],
      templates: [...BUILT_IN_TEMPLATES],
      relationships: [
        {
          formatVersion: 1,
          id: 'rel_0000000000000001',
          worldId: 'wld_0000000000000001',
          from: mara.id,
          to: salt.id,
          type: 'other',
          label: 'lives in',
          kin: null,
          over: false,
          start: null,
          end: null,
        } as never,
      ],
      relationshipTypes: [],
      image: (file) => `data:image/png;base64,${file.slice(0, 4)}`,
    })
    // Where before Who before How.
    expect(html.indexOf('<h1>Where</h1>')).toBeLessThan(html.indexOf('<h1>Who</h1>'))
    expect(html.indexOf('<h1>Who</h1>')).toBeLessThan(html.indexOf('<h1>How</h1>'))
    expect(html).toContain('href="#e-ent_000000000000mara"')
    expect(html).toContain('#noble houses')
    expect(html).toContain('also called the Fox')
    expect(html).toContain('Winter coat')
    expect(html).toContain('Saltmere <span class="muted">(lives in)')
    expect(html).toContain('About Mara &lt;b&gt;') // text is escaped
    expect(html).toContain('History of the Isles')
  })
})
