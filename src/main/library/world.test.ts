import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LibraryChange } from '@shared/ipc'
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

async function world() {
  const w = await lib.createWorld({ name: 'Isles' })
  const withCategory = await lib.createCategory(w.id, {
    name: 'Characters',
    sections: ['Overview', 'Past life', ' ', 'Present life'],
  })
  return { worldId: w.id, characters: withCategory.categories[0]! }
}

describe('categories', () => {
  it('creates a category with a section template, skipping blank sections', async () => {
    const { characters } = await world()
    expect(characters.name).toBe('Characters')
    expect(characters.sections.map((s) => s.name)).toEqual([
      'Overview',
      'Past life',
      'Present life',
    ])
  })

  it('renames a category and edits its template, keeping existing section ids', async () => {
    const { worldId, characters } = await world()
    const [overview] = characters.sections
    const updated = await lib.updateCategory(worldId, characters.id, {
      name: 'People',
      sections: [{ id: overview!.id, name: 'Summary' }, { name: 'Voice' }],
    })
    const cat = updated.categories[0]!
    expect(cat.name).toBe('People')
    expect(cat.sections[0]).toEqual({ id: overview!.id, name: 'Summary' })
    expect(cat.sections[1]!.name).toBe('Voice')
  })

  it('deleting a category keeps its entries, uncategorised', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: 'Mara', categoryId: characters.id })
    const after = await lib.deleteCategory(worldId, characters.id)
    expect(after.categories).toEqual([])
    expect((await lib.readEntry(worldId, mara.id)).categoryId).toBeNull()
  })
})

describe('entries', () => {
  it('starts a new entry with its category sections', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: ' Mara Voss ', categoryId: characters.id })
    expect(mara.name).toBe('Mara Voss')
    expect(mara.sections.map((s) => s.title)).toEqual(['Overview', 'Past life', 'Present life'])
    const loose = await lib.createEntry(worldId, { name: 'Odd thing', categoryId: null })
    expect(loose.sections.map((s) => s.title)).toEqual(['Notes'])
  })

  it('saves only the changed fields, tidying aliases and related links', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: 'Mara', categoryId: characters.id })
    const ren = await lib.createEntry(worldId, { name: 'Ren', categoryId: characters.id })
    await lib.saveEntry(worldId, mara.id, {
      sections: mara.sections.map((s, i) =>
        i === 0 ? { ...s, content: para('A harbour pilot.') } : s,
      ),
    })
    const saved = await lib.saveEntry(worldId, mara.id, {
      aliases: [' the Captain ', 'the Captain', ''],
      related: [ren.id, ren.id, mara.id],
    })
    expect(saved.aliases).toEqual(['the Captain'])
    expect(saved.related).toEqual([ren.id])
    expect(saved.sections[0]!.content).toEqual(para('A harbour pilot.'))
    expect(changes.at(-1)).toEqual({ kind: 'entry', worldId, entryId: mara.id })
  })

  it('lists entries with a snippet, skipping a damaged entry file without touching it', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: 'Mara', categoryId: characters.id })
    await lib.saveEntry(worldId, mara.id, {
      sections: mara.sections.map((s, i) =>
        i === 1 ? { ...s, content: para('Born at sea.') } : s,
      ),
    })
    const bad = join(lib.paths.worldDir(worldId), 'entries', 'ent_0000000000000000.json')
    await fs.promises.writeFile(bad, '{ broken')
    const view = await lib.getWorldView(worldId)
    expect(view.entries.map((e) => [e.name, e.snippet])).toEqual([['Mara', 'Born at sea.']])
    expect(await fs.promises.readFile(bad, 'utf8')).toBe('{ broken')
  })

  it('refuses a category that does not exist', async () => {
    const { worldId } = await world()
    await expect(
      lib.createEntry(worldId, { name: 'X', categoryId: 'cat_0000000000000000' }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('records entries in the world manifest', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: 'Mara', categoryId: characters.id })
    const manifest = JSON.parse(
      await fs.promises.readFile(join(lib.paths.worldDir(worldId), 'manifest.json'), 'utf8'),
    )
    expect(manifest.files[`entries/${mara.id}.json`]).toBeDefined()
  })
})

describe('appearances', () => {
  it('lists the chapters where an entry or its aliases appear, in every series using the world', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: 'Mara Voss', categoryId: characters.id })
    await lib.saveEntry(worldId, mara.id, { aliases: ['Mara'] })
    const series = await lib.createSeries({ name: 'Saga', world: { mode: 'existing', worldId } })
    const other = await lib.createSeries({ name: 'Unlinked', world: { mode: 'none' } })
    for (const s of [series, other]) {
      const v = await lib.createVolume({ seriesId: s.id, name: 'One' })
      const a = await lib.createChapter({ seriesId: s.id, volumeId: v.id, title: 'A' })
      const b = await lib.createChapter({ seriesId: s.id, volumeId: v.id, title: 'B' })
      await lib.saveChapter(s.id, v.id, a.id, {
        content: para('Mara Voss sailed.', "Mara's boat."),
      })
      await lib.saveChapter(s.id, v.id, b.id, { content: para('Nobody here. Marabou.') })
    }
    const found = await lib.entryAppearances(worldId, mara.id)
    expect(found.map((f) => [f.seriesName, f.chapterTitle, f.count])).toEqual([['Saga', 'A', 2]])
  })
})

describe('entry trash', () => {
  it('trashes and restores an entry, uncategorised if its category is gone', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: 'Mara', categoryId: characters.id })
    const trashed = await lib.moveToTrash({ kind: 'entry', worldId, entryId: mara.id })
    expect(trashed).toMatchObject({ kind: 'entry', name: 'Mara', from: 'Isles' })
    expect((await lib.getWorldView(worldId)).entries).toEqual([])
    const manifest = JSON.parse(
      await fs.promises.readFile(join(lib.paths.worldDir(worldId), 'manifest.json'), 'utf8'),
    )
    expect(manifest.files[`entries/${mara.id}.json`]).toBeUndefined()

    await lib.deleteCategory(worldId, characters.id)
    await lib.restoreFromTrash(trashed.id)
    const back = await lib.readEntry(worldId, mara.id)
    expect(back).toMatchObject({ name: 'Mara', categoryId: null })
  })

  it('will not restore an entry into a world that is in the trash', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: 'Mara', categoryId: characters.id })
    const entry = await lib.moveToTrash({ kind: 'entry', worldId, entryId: mara.id })
    await lib.moveToTrash({ kind: 'world', worldId })
    await expect(lib.restoreFromTrash(entry.id)).rejects.toMatchObject({ code: 'not-found' })
  })
})

describe('names for analysis', () => {
  it('reports the words of entry names and aliases for a series world', async () => {
    const { worldId, characters } = await world()
    const mara = await lib.createEntry(worldId, { name: 'Mara Voss', categoryId: characters.id })
    await lib.saveEntry(worldId, mara.id, { aliases: ['the Captain'] })
    const series = await lib.createSeries({ name: 'Saga', world: { mode: 'existing', worldId } })
    expect((await lib.volumeNames(series.id)).sort()).toEqual(['captain', 'mara', 'the', 'voss'])
  })
})
