import { describe, expect, it } from 'vitest'
import type { FactValue } from '../schema'
import { currentValue, inTimeOrder, valuesAt } from './facts'
import { catchNames } from './nameCatcher'
import { chapterLabels, presence, type StoryChapter } from './story'
import { effectiveTemplate, worldTemplates, BUILT_IN_TEMPLATES } from './templates'
import { entryText, worldDigest, type DigestEntry } from './digest'

const chapter = (id: string, label = id): StoryChapter => ({
  id,
  seriesId: 'ser',
  volumeId: 'vol',
  label,
  title: '',
  volumeName: 'One',
})
const positions = new Map([
  ['c1', 0],
  ['c2', 1],
  ['c3', 2],
])
const v = (id: string, text: string, from: FactValue['from'] = null): FactValue => ({
  id,
  text,
  from,
})
const ch = (chapterId: string) => ({ kind: 'chapter' as const, chapterId })

describe('facts over time', () => {
  const history = [v('a', 'Gullhaven'), v('c', 'Saltmere', ch('c3')), v('b', 'At sea', ch('c2'))]

  it('shows the value in effect at a moment', () => {
    expect(currentValue(history, 0, positions)?.text).toBe('Gullhaven')
    expect(currentValue(history, 1, positions)?.text).toBe('At sea')
    expect(currentValue(history, 2, positions)?.text).toBe('Saltmere')
    expect(currentValue(history, null, positions)?.text).toBe('Saltmere')
  })

  it('treats event anchors and unknown chapters as already true', () => {
    const vals = [v('a', 'Alive'), v('b', 'Dead', { kind: 'event', entryId: 'ent_x' })]
    expect(currentValue(vals, 0, positions)?.text).toBe('Dead')
    expect(currentValue([v('a', 'X', ch('gone'))], 0, positions)?.text).toBe('X')
  })

  it('lists several values for multiple fields, and orders history by time', () => {
    const members = [v('a', 'Guild'), v('b', 'Navy', ch('c2'))]
    expect(valuesAt({ multiple: true }, members, 0, positions).map((x) => x.text)).toEqual([
      'Guild',
    ])
    expect(valuesAt({ multiple: true }, members, null, positions)).toHaveLength(2)
    expect(inTimeOrder(history, positions).map((x) => x.text)).toEqual([
      'Gullhaven',
      'At sea',
      'Saltmere',
    ])
  })
})

describe('templates', () => {
  it('lets a world replace a built-in template and add its own', () => {
    const custom = [
      { id: 'person', name: 'Character', lens: 'who' as const, fields: [] },
      { id: 'ship', name: 'Ship', lens: 'where' as const, fields: [] },
    ]
    const all = worldTemplates(custom)
    expect(all.find((t) => t.id === 'person')?.name).toBe('Character')
    expect(all.some((t) => t.id === 'ship')).toBe(true)
    expect(all.length).toBe(BUILT_IN_TEMPLATES.length + 1)
  })

  it('keeps facts that the template does not list, so changing type hides nothing', () => {
    const t = effectiveTemplate(BUILT_IN_TEMPLATES, 'city', {
      role: [v('a', 'Port')],
      odd: [v('b', 'x')],
    })
    expect(t.fields.map((f) => f.id)).toContain('role')
    expect(t.fields.find((f) => f.id === 'odd')?.label).toBe('odd')
    expect(effectiveTemplate(BUILT_IN_TEMPLATES, 'nope').name).toBe('Note')
  })
})

describe('presence', () => {
  const chapters = Array.from({ length: 15 }, (_, i) => chapter(`c${i}`))
  const mentions = (...at: number[]) => ({ chapters: at, counts: at.map(() => 1), pov: [] })

  it('groups by certain data only', () => {
    expect(presence({}, undefined, { chapters }, 10)).toBe('waiting')
    expect(presence({}, mentions(1, 2), { chapters }, 10)).toBe('quiet')
    expect(presence({}, mentions(1, 6), { chapters }, 10)).toBe('story')
    expect(presence({ status: [v('s', 'Dead')] }, mentions(14), { chapters }, 10)).toBe('left')
    expect(presence({}, { chapters: [], counts: [], pov: [13] }, { chapters }, 10)).toBe('story')
  })

  it('numbers chapters but not interludes', () => {
    expect(chapterLabels(['chapter', 'interlude', 'chapter'])).toEqual([
      'Ch 1',
      'Interlude',
      'Ch 2',
    ])
  })
})

describe('name catcher', () => {
  const chapters = [
    {
      id: 'c1',
      paragraphs: [
        'Odo waited by the gate. Then Mara saw Odo again. Later, she told Odo everything.',
        'Suddenly the bell rang. Suddenly it stopped. Suddenly, silence.',
      ],
    },
    { id: 'c2', paragraphs: ['The Kestrel docked. They boarded the Kestrel at dawn.'] },
    { id: 'c3', paragraphs: ['Rose and Rose and Rose. A rose, a rose, a rose, a rose.'] },
    {
      id: 'c4',
      paragraphs: ['Odo-ish thoughts. The Kestrel sank. Gullhaven, Gullhaven, Gullhaven.'],
    },
  ]

  it('suggests repeated capitalised words that appear mid-sentence', () => {
    const found = catchNames(chapters, ['Mara'], [])
    expect(found.map((s) => s.name)).toEqual(['Odo', 'Kestrel', 'Gullhaven'])
    expect(found[0]).toMatchObject({ chapterId: 'c1', quote: 'Then Mara saw Odo again.' })
  })

  it('skips sentence starts, known names, common words and rejected names', () => {
    const found = catchNames(chapters, [], ['odo', 'kestrel'])
    // Mara appears once, Suddenly only starts sentences, Rose is mostly lower case.
    expect(found.map((s) => s.name)).toEqual(['Gullhaven'])
  })
})

describe('text forms', () => {
  const entries: DigestEntry[] = [
    {
      id: 'ent_mara',
      name: 'Mara',
      aliases: ['the Captain'],
      template: 'person',
      facts: { role: [v('r', 'Smuggler')], location: [{ id: 'l', link: 'ent_gull', from: null }] },
      snippet: 'A smuggler with debts.',
    },
    { id: 'ent_gull', name: 'Gullhaven', aliases: [], template: 'city', facts: {}, snippet: '' },
  ]

  it('digests every entry on one line with ids', () => {
    const digest = worldDigest('Isles', entries, BUILT_IN_TEMPLATES, positions)
    expect(digest).toContain(
      '[ent_mara] Mara | aka the Captain | Person (Who) | Smuggler | where now: Gullhaven [ent_gull]',
    )
    expect(digest).toContain('[ent_gull] Gullhaven | City (Where)')
  })

  it('writes an entry as text with facts, page and links', () => {
    const text = entryText({
      entry: { ...entries[1]!, quotes: [] },
      body: ['A harbour town.'],
      templates: BUILT_IN_TEMPLATES,
      entries,
      chapters: [chapter('c1', 'Ch 1')],
      mentions: { chapters: [0], counts: [3], pov: [] },
    })
    expect(text).toContain('# Gullhaven')
    expect(text).toContain('A harbour town.')
    expect(text).toContain('- Here now: Mara [ent_mara]')
    expect(text).toContain('Mentioned in: Ch 1 (3)')
  })
})
