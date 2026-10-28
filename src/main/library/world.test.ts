import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LibraryChange } from '@shared/ipc'
import type { ChapterSource, FactValue } from '@shared/schema'
import { newId } from '@shared/ids'
import { Library } from './library'

let root: string
let lib: Library
let changes: LibraryChange[]

beforeEach(async () => {
  root = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'world-')), 'lib')
  changes = []
  lib = await Library.open(root, { create: true, onChange: (c) => changes.push(c) })
})
afterEach(async () => {
  await fs.promises.rm(join(root, '..'), { recursive: true, force: true })
})

const para = (...texts: string[]) => ({
  type: 'doc' as const,
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})
const link = (to: string, from: FactValue['from'] = null): FactValue => ({
  id: newId('fact'),
  link: to,
  from,
})
const text = (value: string): FactValue => ({ id: newId('fact'), text: value, from: null })

async function world() {
  const w = await lib.createWorld({ name: 'Isles' })
  return w.id
}

/** A series using the world, with one volume and the given chapters. */
async function story(worldId: string, chapters: string[][]) {
  const series = await lib.createSeries({ name: 'Saga', world: { mode: 'existing', worldId } })
  const volume = await lib.createVolume({ seriesId: series.id, name: 'One' })
  const ids: string[] = []
  for (const [i, paragraphs] of chapters.entries()) {
    const c = await lib.createChapter({
      seriesId: series.id,
      volumeId: volume.id,
      title: `T${i + 1}`,
    })
    await lib.saveChapter(series.id, volume.id, c.id, { content: para(...paragraphs) })
    ids.push(c.id)
  }
  const source = (i: number): ChapterSource => ({
    seriesId: series.id,
    volumeId: volume.id,
    chapterId: ids[i]!,
    chapterTitle: `T${i + 1}`,
  })
  return { seriesId: series.id, volumeId: volume.id, chapterIds: ids, source }
}

describe('entries', () => {
  it('creates an entry from a template with an empty page and no categories to set up', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, {
      name: ' Mara ',
      template: 'person',
      facts: { role: [text(' Smuggler ')], status: [text('   ')] },
    })
    expect(mara).toMatchObject({ name: 'Mara', template: 'person', quotes: [], portrait: null })
    expect(mara.facts).toEqual({ role: [{ id: expect.any(String), text: 'Smuggler', from: null }] })
    const view = await lib.world.view(worldId)
    expect(view.entries.map((e) => e.name)).toEqual(['Mara'])
    expect(view.templates.some((t) => t.id === 'person')).toBe(true)
  })

  it('saves only the fields given, keeps unknown fields, and never links an entry to itself', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    const path = join(lib.paths.worldDir(worldId), 'entries', `${mara.id}.json`)
    const raw = JSON.parse(await fs.promises.readFile(path, 'utf8'))
    await fs.promises.writeFile(path, JSON.stringify({ ...raw, futureField: { keep: true } }))
    await lib.world.saveEntry(worldId, mara.id, {
      body: para('Born at sea.'),
      facts: { location: [link(mara.id)] },
    })
    const saved = JSON.parse(await fs.promises.readFile(path, 'utf8'))
    expect(saved.futureField).toEqual({ keep: true })
    expect(saved.facts).toEqual({})
    expect((await lib.world.view(worldId)).entries[0]!.snippet).toBe('Born at sea.')
  })

  it('reports unreadable or old-format entries and leaves them untouched', async () => {
    const worldId = await world()
    await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    const dir = join(lib.paths.worldDir(worldId), 'entries')
    const broken = join(dir, 'ent_0000000000000000.json')
    const old = join(dir, 'ent_1111111111111111.json')
    await fs.promises.writeFile(broken, '{ broken')
    const oldEntry = JSON.stringify({ formatVersion: 1, id: 'ent_1111111111111111', sections: [] })
    await fs.promises.writeFile(old, oldEntry)
    const view = await lib.world.view(worldId)
    expect(view.entries.map((e) => e.name)).toEqual(['Mara'])
    expect(view.problems.map((p) => p.path)).toEqual([
      `worlds/${worldId}/entries/ent_0000000000000000.json`,
      `worlds/${worldId}/entries/ent_1111111111111111.json`,
    ])
    expect(await fs.promises.readFile(broken, 'utf8')).toBe('{ broken')
    expect(await fs.promises.readFile(old, 'utf8')).toBe(oldEntry)
  })

  it('records entries and portraits in the world manifest; images are stored once', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    const odo = await lib.world.createEntry(worldId, { name: 'Odo', template: 'person' })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const a = await lib.world.setPortrait(worldId, mara.id, png)
    const b = await lib.world.setPortrait(worldId, odo.id, png)
    expect(a.portrait?.file).toBe(b.portrait?.file)
    expect(a.portrait?.file).toMatch(/^[0-9a-f]{64}\.png$/)
    const images = await fs.promises.readdir(join(lib.paths.worldDir(worldId), 'images'))
    expect(images).toEqual([a.portrait!.file])
    const manifest = JSON.parse(
      await fs.promises.readFile(join(lib.paths.worldDir(worldId), 'manifest.json'), 'utf8'),
    )
    expect(manifest.files[`entries/${mara.id}.json`]).toBeDefined()
    expect(manifest.files[`images/${a.portrait!.file}`]).toBeDefined()
    await expect(
      lib.world.setPortrait(worldId, mara.id, new Uint8Array([1, 2, 3])),
    ).rejects.toMatchObject({ code: 'invalid-input' })
  })

  it('duplicates an entry with fresh fact ids', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, {
      name: 'Mara',
      template: 'person',
      facts: { role: [text('Smuggler')] },
    })
    const copy = await lib.world.duplicate(worldId, mara.id)
    expect(copy.name).toBe('Mara (copy)')
    expect(copy.facts['role']![0]!.text).toBe('Smuggler')
    expect(copy.facts['role']![0]!.id).not.toBe(mara.facts['role']![0]!.id)
  })
})

describe('merge and safe delete', () => {
  it('merges a duplicate: name becomes an alias, facts and links move over, it goes to the trash', async () => {
    const worldId = await world()
    const gull = await lib.world.createEntry(worldId, { name: 'Gullhaven', template: 'city' })
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    const dupe = await lib.world.createEntry(worldId, {
      name: 'Mara Voss',
      template: 'person',
      facts: { location: [link(gull.id)] },
    })
    await lib.world.saveEntry(worldId, dupe.id, { body: para('Owes money.') })
    const guild = await lib.world.createEntry(worldId, {
      name: 'Guild',
      template: 'faction',
      facts: { leader: [link(dupe.id)] },
    })
    const result = await lib.world.merge(worldId, mara.id, dupe.id)
    expect(result.kept.aliases).toEqual(['Mara Voss'])
    expect(result.kept.facts['location']![0]!.link).toBe(gull.id)
    expect(result.kept.mergedFrom).toEqual([dupe.id])
    expect(JSON.stringify(result.kept.body)).toContain('Owes money.')
    expect((await lib.world.readEntry(worldId, guild.id)).facts['leader']![0]!.link).toBe(mara.id)
    expect(result.before.map((e) => e.id).sort()).toEqual([mara.id, guild.id].sort())
    expect(result.trash.name).toBe('Mara Voss')
    await expect(lib.world.readEntry(worldId, dupe.id)).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('deletes to the trash, optionally removing links to it, and reports what changed', async () => {
    const worldId = await world()
    const gull = await lib.world.createEntry(worldId, { name: 'Gullhaven', template: 'city' })
    const mara = await lib.world.createEntry(worldId, {
      name: 'Mara',
      template: 'person',
      facts: { home: [link(gull.id)], status: [text('Alive')] },
    })
    await lib.world.pin(worldId, gull.id, true)
    const kept = await lib.world.deleteEntry(worldId, gull.id, false)
    expect(kept.before).toEqual([])
    expect((await lib.world.readEntry(worldId, mara.id)).facts['home']![0]!.link).toBe(gull.id)
    expect((await lib.getWorld(worldId)).pinned).toEqual([])
    await lib.restoreFromTrash(kept.trash.id)

    const removed = await lib.world.deleteEntry(worldId, gull.id, true)
    expect(removed.before.map((e) => e.id)).toEqual([mara.id])
    const after = await lib.world.readEntry(worldId, mara.id)
    expect(after.facts['home']).toBeUndefined()
    expect(after.facts['status']![0]!.text).toBe('Alive')
  })

  it('trashes and restores an entry, and will not restore into a trashed world', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    const trashed = await lib.moveToTrash({ kind: 'entry', worldId, entryId: mara.id })
    expect(trashed).toMatchObject({ kind: 'entry', name: 'Mara', from: 'Isles' })
    await lib.restoreFromTrash(trashed.id)
    expect((await lib.world.readEntry(worldId, mara.id)).name).toBe('Mara')
    const again = await lib.moveToTrash({ kind: 'entry', worldId, entryId: mara.id })
    await lib.moveToTrash({ kind: 'world', worldId })
    await expect(lib.restoreFromTrash(again.id)).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('the story', () => {
  it('indexes mentions, POV chapters and appearances with their sentences', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara Voss', template: 'person' })
    await lib.world.saveEntry(worldId, mara.id, { aliases: ['Mara'] })
    const odo = await lib.world.createEntry(worldId, { name: 'Odo', template: 'person' })
    const s = await story(worldId, [
      ['Mara Voss sailed. The sea was calm.', "Mara's boat. Mara-blue paint."],
      ['Nobody here. Marabou.'],
      ['Odo waited.'],
    ])
    await lib.saveChapter(s.seriesId, s.volumeId, s.chapterIds[1]!, { povEntryId: mara.id })
    const index = await lib.world.index(worldId)
    expect(index.chapters.map((c) => c.label)).toEqual(['Ch 1', 'Ch 2', 'Ch 3'])
    expect(index.mentions[mara.id]).toEqual({ chapters: [0], counts: [2], pov: [1] })
    expect(index.mentions[odo.id]).toEqual({ chapters: [2], counts: [1], pov: [] })

    const found = await lib.world.appearances(worldId, mara.id)
    expect(found.map((a) => [a.chapter.title, a.count, a.pov])).toEqual([
      ['T1', 2, false],
      ['T2', 0, true],
    ])
    expect(found[0]!.lines).toEqual(['Mara Voss sailed.', "Mara's boat."])
  })

  it('rebuilds the index when the manuscript or entries change', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    const s = await story(worldId, [['Nobody.']])
    expect((await lib.world.index(worldId)).mentions[mara.id]).toBeUndefined()
    await lib.saveChapter(s.seriesId, s.volumeId, s.chapterIds[0]!, { content: para('Mara.') })
    expect((await lib.world.index(worldId)).mentions[mara.id]?.chapters).toEqual([0])
    await lib.world.saveEntry(worldId, mara.id, { name: 'Odo' })
    expect((await lib.world.index(worldId)).mentions[mara.id]).toBeUndefined()
  })

  it('writes the world digest and entry text forms with ids', async () => {
    const worldId = await world()
    const gull = await lib.world.createEntry(worldId, { name: 'Gullhaven', template: 'city' })
    const mara = await lib.world.createEntry(worldId, {
      name: 'Mara',
      template: 'person',
      facts: { location: [link(gull.id)] },
    })
    await story(worldId, [['Mara reached Gullhaven.']])
    const digest = await lib.world.digest(worldId)
    expect(digest).toContain(`[${mara.id}] Mara | Person (Who) | where now: Gullhaven [${gull.id}]`)
    const text = await lib.world.entryText(worldId, gull.id)
    expect(text).toContain(`- Here now: Mara [${mara.id}]`)
    expect(text).toContain('Mentioned in: Ch 1 (1)')
  })
})

describe('capture and the inbox', () => {
  it('captures a quote into an entry field with a link back to the chapter', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    const s = await story(worldId, [['Her eyes were grey as rain.']])
    const saved = await lib.world.capture(
      worldId,
      mara.id,
      'appearance',
      ' Her eyes were grey as rain. ',
      s.source(0),
    )
    expect(saved.quotes).toEqual([
      expect.objectContaining({
        field: 'appearance',
        text: 'Her eyes were grey as rain.',
        source: s.source(0),
      }),
    ])
  })

  it('captures to the inbox, files items under entries, and dismisses them', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    const s = await story(worldId, [['x']])
    const a = await lib.world.inboxCapture(worldId, 'The tide turned.', s.source(0))
    const b = await lib.world.inboxCapture(worldId, 'Gulls everywhere.', s.source(0))
    expect((await lib.world.view(worldId)).inboxCount).toBe(2)
    const filed = await lib.world.inboxFile(worldId, a.id, mara.id, null)
    expect(filed.quotes[0]).toMatchObject({ field: null, text: 'The tide turned.' })
    await lib.world.inboxDismiss(worldId, b.id)
    expect((await lib.world.inbox(worldId, false)).captured).toEqual([])
    expect(changes).toContainEqual({ kind: 'inbox', worldId })
  })

  it('never overwrites a damaged inbox', async () => {
    const worldId = await world()
    const s = await story(worldId, [['x']])
    const path = join(lib.paths.worldDir(worldId), 'inbox.json')
    await fs.promises.writeFile(path, '{ damaged')
    expect((await lib.world.inbox(worldId, false)).captured).toEqual([])
    await expect(lib.world.inboxCapture(worldId, 'Hello.', s.source(0))).rejects.toMatchObject({
      code: 'corrupt',
    })
    expect(await fs.promises.readFile(path, 'utf8')).toBe('{ damaged')
  })

  it('suggests new names from the manuscript, minus known and rejected ones', async () => {
    const worldId = await world()
    await lib.world.createEntry(worldId, { name: 'Mara Voss', template: 'person' })
    await story(worldId, [
      ['Then Odo came. Mara saw Odo. She told Odo.', 'Voss and Mara left. Mara, Mara, Mara.'],
      ['They found Kestrel. Kestrel sank. The Kestrel was gone.'],
    ])
    const found = await lib.world.inbox(worldId, true)
    expect(found.names.map((n) => n.name)).toEqual(['Odo', 'Kestrel'])
    await lib.world.rejectNames(worldId, ['Kestrel'], true)
    expect((await lib.world.inbox(worldId, true)).names.map((n) => n.name)).toEqual(['Odo'])
    await lib.world.rejectNames(worldId, ['kestrel'], false)
    expect((await lib.world.inbox(worldId, true)).names).toHaveLength(2)
    expect((await lib.world.inbox(worldId, false)).names).toEqual([])
  })
})

describe('templates and pins', () => {
  it('saves customised and new templates in the world folder, and removes them', async () => {
    const worldId = await world()
    const ship = await lib.world.saveTemplate(worldId, {
      name: 'Ship',
      lens: 'where',
      fields: [{ label: 'Captain', kind: 'link', quick: true, multiple: false }],
    })
    expect(ship.id).toMatch(/^ship-/)
    expect(ship.fields[0]!.id).toMatch(/^fld_/)
    await lib.world.saveTemplate(worldId, {
      id: 'person',
      name: 'Character',
      lens: 'who',
      fields: [],
    })
    let view = await lib.world.view(worldId)
    expect(view.customTemplates.sort()).toEqual(['person', ship.id].sort())
    expect(view.templates.find((t) => t.id === 'person')?.name).toBe('Character')
    expect(fs.existsSync(join(lib.paths.worldDir(worldId), 'templates.json'))).toBe(true)

    await lib.world.deleteTemplate(worldId, 'person')
    view = await lib.world.view(worldId)
    expect(view.templates.find((t) => t.id === 'person')?.name).toBe('Person')
    await expect(lib.world.deleteTemplate(worldId, 'person')).rejects.toMatchObject({
      code: 'not-found',
    })
  })

  it('pins and unpins entries', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    expect((await lib.world.pin(worldId, mara.id, true)).pinned).toEqual([mara.id])
    expect((await lib.world.pin(worldId, mara.id, true)).pinned).toEqual([mara.id])
    expect((await lib.world.pin(worldId, mara.id, false)).pinned).toEqual([])
  })
})

describe('names for analysis', () => {
  it('reports the words of entry names and aliases for a series world', async () => {
    const worldId = await world()
    const mara = await lib.world.createEntry(worldId, { name: 'Mara Voss', template: 'person' })
    await lib.world.saveEntry(worldId, mara.id, { aliases: ['the Captain'] })
    const series = await lib.createSeries({ name: 'Saga', world: { mode: 'existing', worldId } })
    expect((await lib.volumeNames(series.id)).sort()).toEqual(['captain', 'mara', 'the', 'voss'])
  })
})

describe('links on pages', () => {
  it('counts @ links and typed names on a page as links, never to itself', async () => {
    const worldId = await world()
    const gull = await lib.world.createEntry(worldId, { name: 'Gullhaven', template: 'city' })
    const odo = await lib.world.createEntry(worldId, { name: 'Odo', template: 'person' })
    const mara = await lib.world.createEntry(worldId, { name: 'Mara', template: 'person' })
    await lib.world.saveEntry(worldId, mara.id, {
      body: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Mara, sister of ' },
              {
                type: 'text',
                text: 'the boy',
                marks: [{ type: 'worldLink', attrs: { entryId: odo.id } }],
              },
              { type: 'text', text: ', lives in Gullhaven.' },
            ],
          },
        ],
      },
    })
    const view = await lib.world.view(worldId)
    expect(view.entries.find((e) => e.id === mara.id)!.links.sort()).toEqual(
      [odo.id, gull.id].sort(),
    )
  })
})

describe('maps', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])
  const box = (x: number, w: number): [number, number][] => [
    [x, 0],
    [x + w, 0],
    [x + w, 400],
    [x, 400],
  ]

  it('stores the image once, saves regions as outlines, and works out what is nearby', async () => {
    const worldId = await world()
    const north = await lib.world.createEntry(worldId, { name: 'Northmark', template: 'kingdom' })
    const south = await lib.world.createEntry(worldId, { name: 'Southreach', template: 'kingdom' })
    const map = await lib.world.createMap(worldId, {
      name: 'The Isles',
      placeId: null,
      image: { data: PNG, width: 1000, height: 400 },
    })
    const again = await lib.world.createMap(worldId, {
      name: 'Copy',
      placeId: null,
      image: { data: PNG, width: 1000, height: 400 },
    })
    expect(again.image!.file).toBe(map.image!.file)
    expect(await fs.promises.readdir(join(lib.paths.worldDir(worldId), 'images'))).toEqual([
      map.image!.file,
    ])
    await lib.world.saveMap(worldId, map.id, {
      regions: [
        { id: newId('region'), rings: [box(0, 300)], placeId: north.id },
        { id: newId('region'), rings: [box(305, 300)], placeId: south.id },
        { id: newId('region'), rings: [box(800, 100)], placeId: null },
      ],
    })
    const view = await lib.world.view(worldId)
    expect(view.maps.map((m) => m.name)).toEqual(['The Isles', 'Copy'])
    expect(view.nearby[north.id]).toEqual([south.id])
    expect(await lib.world.entryText(worldId, north.id)).toContain(
      `## Nearby\n- Southreach [${south.id}]`,
    )
    expect(await lib.world.digest(worldId)).toContain('borders: Southreach')
  })

  it('starts a travel sketch when there is no image; roads make places nearby', async () => {
    const worldId = await world()
    const a = await lib.world.createEntry(worldId, { name: 'A', template: 'city' })
    const b = await lib.world.createEntry(worldId, { name: 'B', template: 'city' })
    const sketch = await lib.world.createMap(worldId, {
      name: 'Sketch',
      placeId: null,
      image: null,
    })
    expect(sketch.sketch).toEqual({ nodes: [], roads: [] })
    await lib.world.saveMap(worldId, sketch.id, {
      sketch: {
        nodes: [
          { placeId: a.id, x: 0.2, y: 0.2 },
          { placeId: b.id, x: 0.8, y: 0.5 },
        ],
        roads: [{ from: a.id, to: b.id }],
      },
    })
    expect((await lib.world.view(worldId)).nearby[b.id]).toEqual([a.id])
  })

  it('moves a map to the trash and back; a damaged map file is reported and kept', async () => {
    const worldId = await world()
    const map = await lib.world.createMap(worldId, {
      name: 'The Isles',
      placeId: null,
      image: { data: PNG, width: 10, height: 10 },
    })
    const trashed = await lib.moveToTrash({ kind: 'map', worldId, mapId: map.id })
    expect(trashed).toMatchObject({ kind: 'map', name: 'The Isles' })
    expect((await lib.world.view(worldId)).maps).toEqual([])
    // The image stays: it is stored once and may be used elsewhere.
    expect(fs.existsSync(lib.world.imagePath(worldId, map.image!.file))).toBe(true)
    await lib.restoreFromTrash(trashed.id)
    expect((await lib.world.view(worldId)).maps.map((m) => m.id)).toEqual([map.id])

    const bad = join(lib.paths.worldDir(worldId), 'maps', 'map_0000000000000000.json')
    await fs.promises.writeFile(bad, '{ nope')
    const view = await lib.world.view(worldId)
    expect(view.problems.map((p) => p.path)).toEqual([
      `worlds/${worldId}/maps/map_0000000000000000.json`,
    ])
    expect(await fs.promises.readFile(bad, 'utf8')).toBe('{ nope')
  })
})

describe('pins', () => {
  it('saves pins in the map file, makes close pins nearby, and lists them in the text form', async () => {
    const worldId = await world()
    const gull = await lib.world.createEntry(worldId, { name: 'Gullhaven', template: 'city' })
    const salt = await lib.world.createEntry(worldId, { name: 'Saltmere', template: 'city' })
    const map = await lib.world.createMap(worldId, {
      name: 'Isles map',
      placeId: null,
      image: { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5]), width: 1000, height: 500 },
    })
    expect(map.pins).toEqual([])
    await lib.world.saveMap(worldId, map.id, {
      pins: [
        { id: newId('pin'), placeId: gull.id, x: 100, y: 100 },
        { id: newId('pin'), placeId: salt.id, x: 120, y: 110 },
      ],
    })
    const view = await lib.world.view(worldId)
    expect(view.maps[0]!.pins).toHaveLength(2)
    expect(view.nearby[gull.id]).toEqual([salt.id])
    expect(await lib.world.entryText(worldId, gull.id)).toContain('Pinned on: Isles map')
  })

  it('reads map files saved before pins existed', async () => {
    const worldId = await world()
    const map = await lib.world.createMap(worldId, { name: 'Old', placeId: null, image: null })
    const path = join(lib.paths.worldDir(worldId), 'maps', `${map.id}.json`)
    const raw = JSON.parse(await fs.promises.readFile(path, 'utf8'))
    delete raw.pins
    await fs.promises.writeFile(path, JSON.stringify(raw))
    expect((await lib.world.readMap(worldId, map.id)).pins).toEqual([])
  })
})
