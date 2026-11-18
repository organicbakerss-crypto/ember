import { describe, expect, it } from 'vitest'
import type { EntrySummary } from '@shared/ipc'
import { BUILT_IN_TEMPLATES } from '@shared/world/templates'
import { BUILT_IN_RELATIONSHIP_TYPES } from '@shared/world/relationships'
import {
  chapterParts,
  checkFindings,
  findingsMessages,
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

  it('reads between the lines: a past connection is suggested and waits for the writer', () => {
    const reply = JSON.stringify({
      relationships: [
        { from: 'Mara', to: 'Odo', type: 'met', words: 'met years ago', how: 'implied', quote: '' },
        { from: 'Odo', to: 'Mara', type: 'friends', words: '', how: 'odd', quote: '' },
      ],
    })
    const raw = parseFindings(reply)!
    expect(raw.relationships.map((r) => r.how)).toEqual(['implied', 'shown'])
    const found = checkFindings([raw], CHAPTER, world())
    expect(found[0]).toMatchObject({
      text: 'Mara and Odo: Met (met years ago) · read between the lines',
      implied: true,
    })
    expect(found[1]!.implied).toBeUndefined()
  })

  it('tells the AI to read past connections, and to ask when it isn’t sure', () => {
    const system = findingsMessages({
      chapterTitle: 'A',
      text: 'x',
      part: 1,
      parts: 1,
      notes: [],
      otherNames: [],
      relationshipTypes: [...BUILT_IN_RELATIONSHIP_TYPES],
      answers: [],
    })[0]!.content
    expect(system).toContain("They don't need to meet on the page")
    expect(system).toContain('ask the writer in questions instead')
  })

  it('finds other names (who uses them) and identities, always for the writer to accept', () => {
    const raw = parseFindings(
      JSON.stringify({
        names: [
          { entry: 'Mara', name: 'Mum', usedBy: 'Odo', kind: 'nickname', quote: '' },
          { entry: 'Mara', name: 'Mara', usedBy: '', kind: 'alias', quote: '' }, // already her name
          { entry: 'Mara', name: 'Ghost', usedBy: 'Nobody', kind: 'secret', quote: '' }, // unknown user
        ],
        identities: [
          { a: 'Odo', b: 'Mara', kind: 'same', quote: '' },
          { a: 'Odo', b: 'Odo', kind: 'becomes', quote: '' },
          { a: 'Odo', b: 'Mara', kind: 'cousin', quote: '' },
        ],
      }),
    )!
    const found = checkFindings([raw], CHAPTER, world())
    expect(found.map((f) => f.text)).toEqual([
      'Mara is also called “Mum” (by Odo)',
      'Odo and Mara are the same person',
    ])
    expect(found.every((f) => f.implied)).toBe(true)
    expect(found[0]!.suggestion).toEqual({
      type: 'name',
      entryId: MARA,
      name: 'Mum',
      usedBy: [ODO],
      kind: 'nickname',
    })
    expect(found[1]!.suggestion).toEqual({
      type: 'identity',
      kind: 'same',
      entryId: ODO,
      other: MARA,
    })
  })

  it('tells the AI who narrates, so "my dad" is the narrator’s', () => {
    const user = findingsMessages({
      chapterTitle: 'A',
      text: 'x',
      part: 1,
      parts: 1,
      notes: [],
      otherNames: [],
      relationshipTypes: [...BUILT_IN_RELATIONSHIP_TYPES],
      answers: [],
      narrator: 'Josh',
    })[1]!.content
    expect(user).toContain('The chapter is told by Josh')
  })

  it('splits a long chapter into parts by words', () => {
    const p = (n: number) => Array.from({ length: n }, () => 'word').join(' ')
    expect(chapterParts([p(600), p(600), p(600)], 1500)).toHaveLength(2)
    expect(chapterParts([p(3000)], 1500)).toHaveLength(1)
    expect(chapterParts(['', p(10)], 1500)).toHaveLength(1)
  })
})
