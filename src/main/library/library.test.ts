import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LibraryChange } from '@shared/ipc'
import { manifestFileSchema, type OutlineFile } from '@shared/schema'
import { isId } from '@shared/ids'
import { readJsonFile, sha256 } from '../fs/jsonFile'
import { Library } from './library'
import { appConfig } from '../../../app.config'

let root: string
let changes: LibraryChange[]
let lib: Library

beforeEach(async () => {
  root = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'library-')), 'My Library')
  changes = []
  lib = await Library.open(root, { create: true, onChange: (c) => changes.push(c) })
})
afterEach(async () => {
  await fs.promises.rm(join(root, '..'), { recursive: true, force: true })
})

async function makeVolume() {
  const series = await lib.createSeries({ name: 'The Long Night', world: { mode: 'none' } })
  const volume = await lib.createVolume({ seriesId: series.id, name: 'Book One' })
  return { series, volume, ref: [series.id, volume.id] as const }
}

const readText = (...parts: string[]) => fs.promises.readFile(join(...parts), 'utf8')

describe('opening a library', () => {
  it('creates the folder layout in an empty folder', async () => {
    const names = (await fs.promises.readdir(root)).sort()
    expect(names).toEqual([appConfig.localDataFolder, 'library.json', 'series', 'worlds'].sort())
    expect(isId('library', lib.info.id)).toBe(true)
  })

  it('reopens an existing library with the same id', async () => {
    const again = await Library.open(root)
    expect(again.info.id).toBe(lib.info.id)
  })

  it('refuses a folder that already holds other files', async () => {
    const other = join(root, '..', 'Downloads')
    await fs.promises.mkdir(other)
    await fs.promises.writeFile(join(other, 'tax-return.pdf'), '...')
    await expect(Library.open(other, { create: true })).rejects.toMatchObject({
      code: 'not-a-library',
    })
    expect(await fs.promises.readdir(other)).toEqual(['tax-return.pdf'])
  })

  it('does not create a library unless asked', async () => {
    await expect(Library.open(join(root, '..', 'missing'))).rejects.toMatchObject({
      code: 'not-a-library',
    })
  })

  it('cleans up temp files left by a crash', async () => {
    const { ref } = await makeVolume()
    const stale = join(lib.paths.chaptersDir(...ref), '.x.json.0123456789ab.tmp')
    await fs.promises.writeFile(stale, '{"half":')
    await Library.open(root)
    expect(fs.existsSync(stale)).toBe(false)
  })
})

describe('series, volumes and worlds', () => {
  it('creates a series linked to a new world', async () => {
    const series = await lib.createSeries({
      name: 'Saga',
      world: { mode: 'new', name: 'The Shattered Isles' },
    })
    const snap = await lib.snapshot()
    expect(snap.worlds).toHaveLength(1)
    expect(series.worldId).toBe(snap.worlds[0]!.id)
    expect(snap.series[0]!.worldId).toBe(series.worldId)
  })

  it('creates a series linked to an existing world, and can relink it', async () => {
    const world = await lib.createWorld({ name: 'Earth' })
    const series = await lib.createSeries({
      name: 'S',
      world: { mode: 'existing', worldId: world.id },
    })
    expect(series.worldId).toBe(world.id)
    const unlinked = await lib.setSeriesWorld(series.id, null)
    expect(unlinked.worldId).toBeNull()
  })

  it('refuses to link a world that does not exist', async () => {
    await expect(
      lib.createSeries({ name: 'S', world: { mode: 'existing', worldId: 'wld_0000000000000000' } }),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect((await lib.snapshot()).series).toHaveLength(0)
  })

  it('lists volumes in series order', async () => {
    const series = await lib.createSeries({ name: 'S', world: { mode: 'none' } })
    const one = await lib.createVolume({ seriesId: series.id, name: 'One' })
    const two = await lib.createVolume({ seriesId: series.id, name: 'Two' })
    const snap = await lib.snapshot()
    expect(snap.series[0]!.volumes.map((v) => v.id)).toEqual([one.id, two.id])
  })

  it('still lists a volume missing from the series order (crash between writes)', async () => {
    const { series, volume } = await makeVolume()
    const file = lib.paths.seriesFile(series.id)
    const raw = JSON.parse(await readText(file))
    raw.volumeOrder = []
    await fs.promises.writeFile(file, JSON.stringify(raw))
    expect((await lib.snapshot()).series[0]!.volumes.map((v) => v.id)).toEqual([volume.id])
  })

  it('creates a world with no preset categories', async () => {
    const world = await lib.createWorld({ name: 'W' })
    expect(world.categories).toEqual([])
    expect(fs.existsSync(join(lib.paths.worldDir(world.id), 'entries'))).toBe(true)
    expect(fs.existsSync(join(lib.paths.worldDir(world.id), 'timeline.json'))).toBe(true)
  })

  it('broadcasts changes', async () => {
    const { series, volume } = await makeVolume()
    expect(changes).toEqual([
      { kind: 'series', seriesId: series.id },
      { kind: 'volume', seriesId: series.id, volumeId: volume.id },
    ])
  })
})

describe('chapters and the outline', () => {
  it('creates chapters at the top level and inside arcs', async () => {
    const { ref } = await makeVolume()
    const prologue = await lib.createChapter({
      seriesId: ref[0],
      volumeId: ref[1],
      title: 'Prologue',
    })
    const view = await lib.createArc({ seriesId: ref[0], volumeId: ref[1], name: 'Arc 1' })
    const arcId = view.outline.items[1]!.id
    const ch1 = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'One', arcId })

    const { outline, chapters, problems } = await lib.getOutline(...ref)
    expect(problems).toEqual([])
    expect(outline.items).toEqual([
      { type: 'chapter', id: prologue.id },
      { type: 'arc', id: arcId, name: 'Arc 1', finished: false, chapterIds: [ch1.id] },
    ])
    expect(chapters[ch1.id]).toEqual({
      id: ch1.id,
      title: 'One',
      type: 'chapter',
      pov: null,
      povEntryId: null,
    })
  })

  it('saves chapter content and keeps createdAt', async () => {
    const { ref } = await makeVolume()
    const ch = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'One' })
    const content = {
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'It was a dark night.' }] }],
    }
    const saved = await lib.saveChapter(...ref, ch.id, { content })
    expect(saved.createdAt).toBe(ch.createdAt)
    expect((await lib.readChapter(...ref, ch.id)).content).toEqual(content)
  })

  it('refuses to save a chapter that was never created', async () => {
    const { ref } = await makeVolume()
    await expect(
      lib.saveChapter(...ref, 'chp_0000000000000000', { title: 'x' }),
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('keeps fields from newer versions of the app when saving', async () => {
    const { ref } = await makeVolume()
    const ch = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'One' })
    const path = join(lib.paths.chaptersDir(...ref), `${ch.id}.json`)
    await fs.promises.writeFile(path, JSON.stringify({ ...ch, futureField: { keep: true } }))
    const saved = await lib.saveChapter(...ref, ch.id, { title: 'Renamed' })
    expect(saved).toMatchObject({ title: 'Renamed', futureField: { keep: true } })
    expect(await lib.readChapter(...ref, ch.id)).toMatchObject({ futureField: { keep: true } })
  })

  it('only changes the fields in a patch', async () => {
    const { ref } = await makeVolume()
    const ch = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'One' })
    const content = { type: 'doc' as const, content: [{ type: 'paragraph' }] }
    await lib.saveChapter(...ref, ch.id, { content })
    // A later patch from somewhere else (e.g. the POV field) keeps the content.
    const saved = await lib.saveChapter(...ref, ch.id, { pov: 'Mara', title: undefined })
    expect(saved).toMatchObject({ title: 'One', pov: 'Mara', content })
  })

  it('reorders by touching only outline.json', async () => {
    const { ref } = await makeVolume()
    const a = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const b = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'B' })
    const volumeDir = lib.paths.volumeDir(...ref)
    const before = await snapshotFiles(volumeDir)

    const { outline } = await lib.getOutline(...ref)
    await lib.saveOutline(...ref, { ...outline, items: [...outline.items].reverse() })

    const after = await snapshotFiles(volumeDir)
    const changed = Object.keys(after).filter((k) => after[k] !== before[k])
    expect(changed.sort()).toEqual(['manifest.json', 'outline.json'])
    expect((await lib.getOutline(...ref)).outline.items.map((i) => i.id)).toEqual([b.id, a.id])
  })

  it('moves a chapter into an arc', async () => {
    const { ref } = await makeVolume()
    const a = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const { outline } = await lib.createArc({ seriesId: ref[0], volumeId: ref[1], name: 'Arc' })
    const arc = outline.items[1]!
    if (arc.type !== 'arc') throw new Error('expected arc')
    const next: OutlineFile = { ...outline, items: [{ ...arc, chapterIds: [a.id] }] }
    const view = await lib.saveOutline(...ref, next)
    expect(view.outline.items).toEqual([{ ...arc, chapterIds: [a.id] }])
  })

  it('refuses an outline that would drop a chapter', async () => {
    const { ref } = await makeVolume()
    await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const { outline } = await lib.getOutline(...ref)
    await expect(lib.saveOutline(...ref, { ...outline, items: [] })).rejects.toMatchObject({
      code: 'conflict',
    })
    expect((await lib.getOutline(...ref)).outline.items).toHaveLength(1)
  })

  it('refuses an outline that lists a chapter twice', async () => {
    const { ref } = await makeVolume()
    const a = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const { outline } = await lib.getOutline(...ref)
    const items: OutlineFile['items'] = [
      { type: 'chapter', id: a.id },
      { type: 'arc', id: 'arc_0000000000000000', name: 'X', finished: false, chapterIds: [a.id] },
    ]
    await expect(lib.saveOutline(...ref, { ...outline, items })).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('shows chapters that are missing from the outline instead of hiding them', async () => {
    const { ref } = await makeVolume()
    const a = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const outlinePath = join(lib.paths.volumeDir(...ref), 'outline.json')
    const raw = JSON.parse(await readText(outlinePath))
    raw.items = []
    await fs.promises.writeFile(outlinePath, JSON.stringify(raw))

    const view = await lib.getOutline(...ref)
    expect(view.outline.items).toEqual([{ type: 'chapter', id: a.id }])
    expect(view.problems).toHaveLength(1)
  })

  it('creating a chapter with the same title twice makes two chapters', async () => {
    const { ref } = await makeVolume()
    const a = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'Same' })
    const b = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'Same' })
    expect(a.id).not.toBe(b.id)
    expect(Object.keys((await lib.getOutline(...ref)).chapters)).toHaveLength(2)
  })

  it('serialises concurrent chapter creation without losing any', async () => {
    const { ref } = await makeVolume()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: `Ch ${i}` }),
      ),
    )
    const view = await lib.getOutline(...ref)
    expect(view.outline.items).toHaveLength(20)
    expect(view.problems).toEqual([])
  })
})

describe('damaged files', () => {
  it('reports a corrupt series file without touching it', async () => {
    const { series } = await makeVolume()
    const file = lib.paths.seriesFile(series.id)
    await fs.promises.writeFile(file, '{ not json')
    const snap = await lib.snapshot()
    expect(snap.series).toEqual([])
    expect(snap.problems).toEqual([
      {
        path: `series/${series.id}/series.json`,
        message: expect.stringContaining('Not valid JSON'),
      },
    ])
    expect(await readText(file)).toBe('{ not json')
  })

  it('still lists a corrupt chapter in the outline', async () => {
    const { ref } = await makeVolume()
    const ch = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const path = join(lib.paths.chaptersDir(...ref), `${ch.id}.json`)
    await fs.promises.writeFile(path, '{"type": "oops"}')
    const view = await lib.getOutline(...ref)
    expect(view.outline.items).toEqual([{ type: 'chapter', id: ch.id }])
    expect(view.chapters[ch.id]!.title).toBe('(unreadable chapter)')
    expect(view.problems).toHaveLength(1)
    await expect(lib.readChapter(...ref, ch.id)).rejects.toMatchObject({ code: 'corrupt' })
  })
})

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6])

describe('covers', () => {
  it('stores a volume cover inside the volume folder and records it in the manifest', async () => {
    const { series, volume, ref } = await makeVolume()
    const target = { kind: 'volume' as const, seriesId: series.id, volumeId: volume.id }
    const info = await lib.setCover(target, PNG)

    const dir = lib.paths.volumeDir(...ref)
    const file = join(dir, 'cover.png')
    expect(await lib.getCoverFile(target)).toBe(file)
    expect(new Uint8Array(await fs.promises.readFile(file))).toEqual(PNG)
    const manifest = await readJsonFile(join(dir, 'manifest.json'), manifestFileSchema)
    expect(manifest.files['cover.png']?.hash).toBe(sha256(PNG))

    const snap = await lib.snapshot()
    expect(snap.series[0]!.volumes[0]!.cover).toEqual(info)
    expect(changes.at(-1)).toEqual({ kind: 'volume', seriesId: series.id, volumeId: volume.id })
  })

  it('replaces a cover of a different type and moves the old one to the trash', async () => {
    const { series } = await makeVolume()
    const target = { kind: 'series' as const, seriesId: series.id }
    await lib.setCover(target, PNG)
    await lib.setCover(target, JPEG)

    const names = await fs.promises.readdir(lib.paths.seriesDir(series.id))
    expect(names.filter((n) => n.startsWith('cover'))).toEqual(['cover.jpg'])
    const trash = await fs.promises.readdir(join(lib.paths.localDir, 'trash', 'covers'))
    expect(trash).toHaveLength(1)
    expect(trash[0]).toMatch(/cover\.png$/)
  })

  it('removes a cover and its manifest entry', async () => {
    const world = await lib.createWorld({ name: 'W' })
    const target = { kind: 'world' as const, worldId: world.id }
    await lib.setCover(target, PNG)
    await lib.removeCover(target)
    expect(await lib.getCoverFile(target)).toBeNull()
    const dir = lib.paths.worldDir(world.id)
    const manifest = await readJsonFile(join(dir, 'manifest.json'), manifestFileSchema)
    expect(manifest.files['cover.png']).toBeUndefined()
    expect((await lib.snapshot()).worlds[0]!.cover).toBeNull()
  })

  it('refuses files that are not images', async () => {
    const { series } = await makeVolume()
    const target = { kind: 'series' as const, seriesId: series.id }
    await expect(lib.setCover(target, new TextEncoder().encode('<svg>'))).rejects.toMatchObject({
      code: 'invalid-input',
    })
  })

  it('refuses covers for items that do not exist', async () => {
    await expect(
      lib.setCover({ kind: 'series', seriesId: 'ser_0000000000000000' }, PNG),
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(fs.existsSync(lib.paths.seriesDir('ser_0000000000000000'))).toBe(false)
  })
})

describe('word counts', () => {
  it('totals the words in a volume', async () => {
    const { ref } = await makeVolume()
    const a = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const b = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'B' })
    const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    await lib.saveChapter(...ref, a.id, { content: { type: 'doc', content: [para('one two')] } })
    await lib.saveChapter(...ref, b.id, { content: { type: 'doc', content: [para('three')] } })
    expect((await lib.snapshot()).series[0]!.volumes[0]!.wordCount).toBe(3)
  })

  it('reports per-chapter counts and keeps the session start for the whole run', async () => {
    const { ref } = await makeVolume()
    const a = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
    await lib.saveChapter(...ref, a.id, { content: { type: 'doc', content: [para('one two')] } })

    const first = await lib.volumeStats(...ref)
    expect(first).toEqual({ chapterWords: { [a.id]: 2 }, sessionStartWords: 2 })
    await lib.saveChapter(...ref, a.id, {
      content: { type: 'doc', content: [para('one two three four')] },
    })
    const second = await lib.volumeStats(...ref)
    expect(second).toEqual({ chapterWords: { [a.id]: 4 }, sessionStartWords: 2 })
  })
})

describe('volume settings', () => {
  it('updates goals and name', async () => {
    const { ref } = await makeVolume()
    const goals = { projectWords: 90000, sessionWords: 1000 }
    const updated = await lib.updateVolume(...ref, { goals })
    expect(updated).toMatchObject({ name: 'Book One', goals })
    expect((await lib.getVolume(...ref)).goals).toEqual(goals)
    expect((await lib.updateVolume(...ref, { name: ' Book 1 ' })).name).toBe('Book 1')
  })
})

describe('manifests', () => {
  it('records the hash of every file written in a volume', async () => {
    const { ref } = await makeVolume()
    const ch = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const dir = lib.paths.volumeDir(...ref)
    const manifest = await readJsonFile(join(dir, 'manifest.json'), manifestFileSchema)
    const chapterRel = `chapters/${ch.id}.json`
    expect(Object.keys(manifest.files).sort()).toEqual([chapterRel, 'outline.json', 'volume.json'])
    expect(manifest.files[chapterRel]!.hash).toBe(sha256(await readText(dir, chapterRel)))
  })

  it('rebuilds a damaged manifest from the files', async () => {
    const { ref } = await makeVolume()
    const dir = lib.paths.volumeDir(...ref)
    await fs.promises.writeFile(join(dir, 'manifest.json'), 'garbage')
    const ch = await lib.createChapter({ seriesId: ref[0], volumeId: ref[1], title: 'A' })
    const manifest = await readJsonFile(join(dir, 'manifest.json'), manifestFileSchema)
    expect(manifest.unitId).toBe(ref[1])
    expect(manifest.files[`chapters/${ch.id}.json`]).toBeDefined()
    expect(manifest.files['volume.json']).toBeDefined()
  })
})

async function snapshotFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const entry of await fs.promises.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    out[full.slice(dir.length + 1)] = await fs.promises.readFile(full, 'utf8')
  }
  return out
}
