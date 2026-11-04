import { describe, expect, it } from 'vitest'
import type { EntrySummary } from '@shared/ipc'
import { BUILT_IN_TEMPLATES } from '@shared/world/templates'
import { BUILT_IN_RELATIONSHIP_TYPES } from '@shared/world/relationships'
import {
  chapterParts,
  checkFindings,
  parseFindings,
  type RawFindings,
  type WorldFacts,
} from './worldUpdate'

const entry = (id: string, name: string, template: string, extra: Partial<EntrySummary> = {}) =>
  ({
    id,
    name,
    aliases: [],
    template,
    facts: {},
    snippet: '',
    portrait: null,
    mergedFrom: [],
    links: [],
    when: null,
    updatedAt: '',
    ...extra,
  }) as EntrySummary

const MARA = 'ent_aaaaaaaaaaaaaaaa'
const ODO = 'ent_bbbbbbbbbbbbbbbb'
const PORT = 'ent_cccccccccccccccc'
const world = (extra: Partial<WorldFacts> = {}): WorldFacts => ({
  entries: [
    entry(MARA, 'Mara', 'person', { aliases: ['the Captain'] }),
    entry(ODO, 'Odo', 'person', {
      facts: { role: [{ id: 'fct_aaaaaaaaaaaaaaaa', text: 'Fisherman', from: null }] },
    }),
    entry(PORT, 'Port Kell', 'city'),
  ],
  templates: [...BUILT_IN_TEMPLATES],
  relationshipTypes: [...BUILT_IN_RELATIONSHIP_TYPES],
  relationships: [],
  answered: [],
  ...extra,
})
const CHAPTER =
  'Mara sailed into Port Kell at dawn. Odo, the fisherman, was waiting. “You’re late,” said Odo. Vela watched from the tower. Mara’s eyes were green.'

const empty = (): RawFindings => ({
  summary: '',
  new: [],
  facts: [],
  relationships: [],
  continuity: [],
  questions: [],
})

describe('reading the AI’s findings', () => {
  it('reads JSON with chatter or a code fence around it, and fills in what’s missing', () => {
    const r = parseFindings(
      'Sure!\n```json\n{"summary":"Mara arrives.","facts":[{"entry":"Mara"}]}\n```',
    )
    expect(r?.summary).toBe('Mara arrives.')
    expect(r?.facts).toEqual([{ entry: 'Mara', field: '', value: '', quote: '' }])
    expect(r?.new).toEqual([])
    expect(parseFindings('no json here')).toBeNull()
    expect(parseFindings('{broken')).toBeNull()
  })

  it('resolves names, fields and types, and keeps only quotes that are in the chapter', () => {
    const raw = empty()
    raw.facts = [
      {
        entry: 'mara',
        field: 'Where now',
        value: 'Port Kell',
        quote: 'Mara sailed into Port Kell at dawn.',
      },
      { entry: 'Odo', field: 'role', value: 'fisherman', quote: '' }, // already says so
      { entry: 'Nobody', field: 'Role', value: 'x', quote: '' },
      { entry: 'Odo', field: 'Favourite colour', value: 'blue', quote: '' },
      { entry: 'Odo', field: 'Where now', value: 'Atlantis', quote: '' }, // not an entry
    ]
    raw.relationships = [
      { from: 'the Captain', to: 'Odo', type: 'friends', words: '', quote: 'made up' },
      { from: 'Mara', to: 'Mara', type: 'friends', words: '', quote: '' },
      { from: 'Mara', to: 'Odo', type: 'nemesis', words: '', quote: '' },
    ]
    const found = checkFindings([raw], CHAPTER, world())
    expect(found.map((f) => f.text)).toEqual([
      'Mara: Where now → Port Kell',
      'Mara and Odo: Friends / allies',
    ])
    expect(found[0]).toMatchObject({
      kind: 'suggestion',
      entryId: MARA,
      quote: 'Mara sailed into Port Kell at dawn.',
      suggestion: { type: 'fact', entryId: MARA, field: 'location', link: PORT },
    })
    expect(found[1]!.quote).toBeNull()
  })

  it('suggests new things only when they are new and really in the chapter', () => {
    const raw = empty()
    raw.new = [
      {
        name: 'Vela',
        kind: 'person',
        about: 'Watches from the tower.',
        quote: 'Vela watched from the tower.',
      },
      { name: 'Mara', kind: 'person', about: '', quote: '' },
      { name: 'Zed', kind: 'person', about: '', quote: '' },
      { name: 'The Tower', kind: 'building', about: '', quote: '' },
    ]
    const found = checkFindings([raw, raw], CHAPTER, world())
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      text: 'New person: Vela — Watches from the tower.',
      suggestion: { type: 'new', name: 'Vela', template: 'person' },
    })
  })

  it('needs a quote for continuity, and doesn’t ask again what was answered', () => {
    const raw = empty()
    raw.continuity = [
      { entry: 'Mara', problem: 'Her eyes were grey before.', quote: 'Mara’s eyes were green.' },
      { entry: 'Odo', problem: 'Unfounded.', quote: '' },
    ]
    raw.questions = [
      { question: 'Is Vela new?', quote: '' },
      { question: 'Is the tower in Port Kell?', quote: '' },
    ]
    const found = checkFindings([raw], CHAPTER, world({ answered: ['is vela new?'] }))
    expect(found.map((f) => [f.kind, f.text, f.entryId])).toEqual([
      ['continuity', 'Her eyes were grey before.', MARA],
      ['question', 'Is the tower in Port Kell?', null],
    ])
  })

  it('skips relationships the world already has', () => {
    const raw = empty()
    raw.relationships = [{ from: 'Odo', to: 'Mara', type: 'met', words: '', quote: '' }]
    const rel = { type: 'met', from: MARA, to: ODO } as WorldFacts['relationships'][number]
    expect(checkFindings([raw], CHAPTER, world({ relationships: [rel] }))).toEqual([])
  })

  it('splits a long chapter into parts by words', () => {
    const p = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
    expect(chapterParts([p(600), p(600), p(600)], 1500)).toHaveLength(2)
    expect(chapterParts([p(3000)], 1500)).toHaveLength(1)
    expect(chapterParts(['', p(10)], 1500)).toHaveLength(1)
  })
})
