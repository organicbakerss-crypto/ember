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
