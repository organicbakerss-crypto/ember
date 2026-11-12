import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library } from './library'

let root: string
let lib: Library

beforeEach(async () => {
  root = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'search-')), 'lib')
  lib = await Library.open(root, { create: true })
})
afterEach(async () => {
  await fs.promises.rm(join(root, '..'), { recursive: true, force: true })
})

const para = (...texts: string[]) => ({
  type: 'doc' as const,
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})
const opts = { matchCase: false, wholeWord: true }

async function volume() {
  const series = await lib.createSeries({ name: 'S', world: { mode: 'none' } })
  const vol = await lib.createVolume({ seriesId: series.id, name: 'V' })
  const ref = [series.id, vol.id] as const
  const add = async (title: string, ...texts: string[]) => {
    const ch = await lib.createChapter({ seriesId: series.id, volumeId: vol.id, title })
    await lib.saveChapter(...ref, ch.id, { content: para(...texts) })
    return ch
  }
  return { ref, add }
}

describe('find and replace across a volume', () => {
  it('finds matches in reading order with context', async () => {
    const { ref, add } = await volume()
    const one = await add('One', 'Mara ran.', 'Nobody saw Mara.')
    await add('Two', 'Quiet.')
    const three = await add('Three', 'Maranatha is not a match; mara is.')
    const result = await lib.searchVolume(...ref, 'mara', opts)
    expect(result.total).toBe(3)
    expect(result.chapters.map((c) => c.title)).toEqual(['One', 'Three'])
    expect(result.hits[1]).toMatchObject({
      chapterId: one.id,
      node: 1,
      before: 'Nobody saw ',
      match: 'Mara',
      after: '.',
    })
    expect(result.hits[2]!.chapterId).toBe(three.id)
  })

  it('replaces everywhere and keeps each changed chapter in its history', async () => {
    const { ref, add } = await volume()
    const one = await add('One', 'Mara ran.')
    const two = await add('Two', 'Nothing here.')
    const done = await lib.replaceAllInVolume(...ref, 'mara', 'Lena', opts)
    expect(done).toEqual({ chapters: 1, replacements: 1 })
    expect(JSON.stringify((await lib.readChapter(...ref, one.id)).content)).toContain('Lena ran.')

    const [before] = await lib.listSnapshots(...ref, one.id)
    expect(before!.reason).toBe('before-replace')
    await lib.restoreSnapshot(...ref, one.id, before!.id)
    expect(JSON.stringify((await lib.readChapter(...ref, one.id)).content)).toContain('Mara ran.')
    expect(await lib.listSnapshots(...ref, two.id)).toHaveLength(1) // only its first-save snapshot
  })

  it('skips unreadable chapters without touching them', async () => {
    const { ref, add } = await volume()
    const bad = await add('Bad', 'Mara')
    const path = join(lib.paths.chaptersDir(...ref), `${bad.id}.json`)
    await fs.promises.writeFile(path, '{ broken')
    await add('Good', 'Mara')
    expect((await lib.searchVolume(...ref, 'mara', opts)).total).toBe(1)
    expect(await lib.replaceAllInVolume(...ref, 'mara', 'x', opts)).toEqual({
      chapters: 1,
      replacements: 1,
    })
    expect(await fs.promises.readFile(path, 'utf8')).toBe('{ broken')
  })
})

describe('find and replace across a whole story', () => {
  it('searches every volume in order, and replaces in all of them', async () => {
    const series = await lib.createSeries({ name: 'S', world: { mode: 'none' } })
    const v1 = await lib.createVolume({ seriesId: series.id, name: 'Book One' })
    const v2 = await lib.createVolume({ seriesId: series.id, name: 'Book Two' })
    const add = async (volumeId: string, title: string, text: string) => {
      const ch = await lib.createChapter({ seriesId: series.id, volumeId, title })
      await lib.saveChapter(series.id, volumeId, ch.id, { content: para(text) })
      return ch
    }
    await add(v1.id, 'One', 'Mara ran.')
    const two = await add(v2.id, 'Two', 'Mara came back.')
    const found = await lib.searchStory(series.id, 'mara', opts)
    expect(found.total).toBe(2)
    expect(found.chapters.map((c) => [c.title, c.volumeName])).toEqual([
      ['One', 'Book One'],
      ['Two', 'Book Two'],
    ])
    expect(found.hits[1]).toMatchObject({ volumeId: v2.id, chapterId: two.id })
    // One volume only still means only that one.
    expect((await lib.searchVolume(series.id, v2.id, 'mara', opts)).total).toBe(1)

    expect(await lib.replaceAllInStory(series.id, 'mara', 'Lena', opts)).toEqual({
      chapters: 2,
      replacements: 2,
    })
    expect((await lib.searchStory(series.id, 'lena', opts)).total).toBe(2)
    // Each changed chapter kept its old text in history.
    expect(
      (await lib.listSnapshots(series.id, v2.id, two.id)).some(
        (s) => s.reason === 'before-replace',
      ),
    ).toBe(true)
  })
})

describe('find keeps chapter text in memory', () => {
  it('sees every change: saves here, edits from outside, damaged and deleted files', async () => {
    const series = await lib.createSeries({ name: 'S', world: { mode: 'none' } })
    const v = await lib.createVolume({ seriesId: series.id, name: 'Book' })
    const ch = await lib.createChapter({ seriesId: series.id, volumeId: v.id, title: 'One' })
    await lib.saveChapter(series.id, v.id, ch.id, { content: para('Mara ran.') })
    const count = async (q: string) => (await lib.searchVolume(series.id, v.id, q, opts)).total
    expect(await count('mara')).toBe(1)

    await lib.saveChapter(series.id, v.id, ch.id, { content: para('Lena ran.') })
    expect(await count('mara')).toBe(0)
    expect(await count('lena')).toBe(1)

    // Changed by another program (or sync) with the same length.
    const file = join(lib.paths.chaptersDir(series.id, v.id), `${ch.id}.json`)
    const raw = await fs.promises.readFile(file, 'utf8')
    await fs.promises.writeFile(file, raw.replace('Lena', 'Tova').replace('"One"', '"Uno"'))
    expect(await count('tova')).toBe(1)
    expect((await lib.getOutline(series.id, v.id)).chapters[ch.id]!.title).toBe('Uno')
    expect(await count('lena')).toBe(0)

    // Damaged: skipped, never a stale answer; the file is left alone.
    await fs.promises.writeFile(file, '{ broken')
    expect(await count('tova')).toBe(0)
    const outline = await lib.getOutline(series.id, v.id)
    expect(outline.chapters[ch.id]!.title).toBe('(unreadable chapter)')
    expect(outline.problems.length).toBeGreaterThan(0)
    expect(await fs.promises.readFile(file, 'utf8')).toBe('{ broken')

    await fs.promises.writeFile(file, raw)
    expect(await count('lena')).toBe(1)
    await fs.promises.rm(file)
    expect(await count('lena')).toBe(0)
  })
})
