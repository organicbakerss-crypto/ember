/**
 * A small test world for "Update the world": a few entries, three chapters,
 * and what reading each chapter should find. Used to measure how well a
 * model does (`npm run ai:eval` with Ollama) and, with a scripted model, to
 * check the pipeline end to end. Not shipped.
 */
import type { InboxItem } from '@shared/schema'
import type { Library } from '../../library/library'

export interface Expected {
  /** What it is, for the report. */
  what: string
  matches: (item: InboxItem, names: Map<string, string>) => boolean
}

const para = (...ps: string[]) => ({
  type: 'doc' as const,
  content: ps.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
})

const fact =
  (entry: string, field: string, value: RegExp): Expected['matches'] =>
  (item, names) =>
    item.suggestion?.type === 'fact' &&
    names.get(item.suggestion.entryId) === entry &&
    item.suggestion.field === field &&
    (value.test(item.suggestion.text ?? '') ||
      value.test(names.get(item.suggestion.link ?? '') ?? ''))

export const TEST_CHAPTERS: { title: string; text: string[]; expect: Expected[] }[] = [
  {
    title: 'The Harbour',
    text: [
      'Mara sailed into Port Kell at dawn, the hold full of salt.',
      'Odo was waiting on the quay, as he had every morning since the war. “You’re late,” he said, and took her rope.',
      'Behind him stood a tall man in a grey coat. “Captain Brannoch,” Odo muttered. “Iron Guild. He wants a word.”',
      'Mara and Odo had been friends since they were children; she trusted him more than anyone in the city.',
    ],
    expect: [
      {
        what: 'new person: Brannoch',
        matches: (i) => i.suggestion?.type === 'new' && /brannoch/i.test(i.suggestion.name),
      },
      { what: 'Mara: Where now → Port Kell', matches: fact('Mara', 'location', /port kell/i) },
      {
        what: 'Mara and Odo: friends',
        matches: (i, names) =>
          i.suggestion?.type === 'relationship' &&
          i.suggestion.relType === 'friends' &&
          [names.get(i.suggestion.from), names.get(i.suggestion.to)].sort().join() === 'Mara,Odo',
      },
    ],
  },
  {
    title: 'Green Eyes',
    text: [
      'That night Odo signed the Iron Guild’s ledger. He was one of them now.',
      'Mara watched him from the doorway, her green eyes narrow. She said nothing.',
      'In the morning she took the north road out of Port Kell, alone.',
    ],
    expect: [
      { what: 'Odo: Member of → Iron Guild', matches: fact('Odo', 'memberOf', /iron guild/i) },
      {
        what: 'continuity: Mara’s eyes (grey in her notes)',
        matches: (i) => i.kind === 'continuity' && /eye/i.test(`${i.text} ${i.quote ?? ''}`),
      },
    ],
  },
  {
    title: 'The Captain',
    text: [
      'Three days on, the Captain caught up with her at the ford.',
      '“You left without paying the Guild,” the Captain said. Mara reached for her knife.',
    ],
    expect: [
      {
        what: 'question: who is “the Captain”?',
        matches: (i) => i.kind === 'question' && /captain/i.test(i.text),
      },
    ],
  },
]

/** Makes the test world and its story in a library; returns where everything is. */
export async function makeTestWorld(lib: Library) {
  const series = await lib.createSeries({ name: 'Salt', world: { mode: 'new', name: 'The Coast' } })
  const worldId = series.worldId!
  const volume = await lib.createVolume({ seriesId: series.id, name: 'One' })
  const chapters: string[] = []
  for (const c of TEST_CHAPTERS) {
    const ch = await lib.createChapter({ seriesId: series.id, volumeId: volume.id, title: c.title })
    await lib.saveChapter(series.id, volume.id, ch.id, { content: para(...c.text) })
    chapters.push(ch.id)
  }
  const w = lib.world
  const now = { id: 'fct_aaaaaaaaaaaaaaaa', from: null }
  await w.createEntry(worldId, {
    name: 'Mara',
    template: 'person',
    facts: {
      role: [{ ...now, id: 'fct_aaaaaaaaaaaaaaa1', text: 'Salt trader' }],
      appearance: [{ ...now, id: 'fct_aaaaaaaaaaaaaaa2', text: 'Grey eyes, a scar on her chin' }],
    },
  })
  await w.createEntry(worldId, {
    name: 'Odo',
    template: 'person',
    facts: { role: [{ ...now, id: 'fct_aaaaaaaaaaaaaaa3', text: 'Fisherman' }] },
  })
  await w.createEntry(worldId, { name: 'Port Kell', template: 'city' })
  await w.createEntry(worldId, { name: 'Iron Guild', template: 'faction' })
  return { seriesId: series.id, volumeId: volume.id, worldId, chapters }
}

/** How a run did: expected things found, and anything else it suggested. */
export function score(
  items: InboxItem[],
  expected: Expected[],
  names: Map<string, string>,
): { found: string[]; missed: string[]; extra: string[] } {
  const used = new Set<InboxItem>()
  const found: string[] = []
  const missed: string[] = []
  for (const e of expected) {
    const hit = items.find((i) => !used.has(i) && e.matches(i, names))
    if (hit) {
      used.add(hit)
      found.push(e.what)
    } else missed.push(e.what)
  }
  return { found, missed, extra: items.filter((i) => !used.has(i)).map((i) => i.text) }
}
