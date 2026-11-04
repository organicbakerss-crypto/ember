import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AiSettings } from '@shared/settings'
import { Library } from '../library/library'
import type { LibraryHost } from '../libraryHost'
import { AutoWorld, type ChapterRef } from './autoWorld'

let dir: string
let lib: Library
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'auto-'))
  lib = await Library.open(join(dir, 'lib'), { create: true })
})
afterEach(() => fs.promises.rm(dir, { recursive: true, force: true }))

const doc = (t: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
})

async function setup(settings: Partial<AiSettings>) {
  const series = await lib.createSeries({ name: 'Saga', world: { mode: 'new', name: 'Isles' } })
  const volume = await lib.createVolume({ seriesId: series.id, name: 'One' })
  const ch = await lib.createChapter({ seriesId: series.id, volumeId: volume.id, title: 'A' })
  await lib.saveChapter(series.id, volume.id, ch.id, { content: doc('Mara ran.') })
  let now = 0
  const ran: ChapterRef[] = []
  const auto = new AutoWorld({
    settings: async () => ({ ...DEFAULT_AI_SETTINGS, enabled: true, autoWorld: true, ...settings }),
    host: { current: lib } as unknown as LibraryHost,
    run: async (ref) => void ran.push(ref),
    quietMs: 1000,
    now: () => now,
  })
  const ref = { seriesId: series.id, volumeId: volume.id, chapterId: ch.id }
  return { auto, ran, ref, later: (ms: number) => (now += ms) }
}

describe('keeping the world up to date by itself', () => {
  it('reads a changed chapter once it has been left alone a while, once', async () => {
    const { auto, ran, ref, later } = await setup({})
    auto.changed({ kind: 'chapter', ...ref })
    expect(await auto.tick()).toBe(false) // still being written
    later(500)
    auto.changed({ kind: 'chapter', ...ref }) // typed again: the wait starts over
    later(800)
    expect(await auto.tick()).toBe(false)
    later(300)
    expect(await auto.tick()).toBe(true)
    expect(ran).toEqual([ref])
    expect(await auto.tick()).toBe(false) // nothing left
  })

  it('does nothing when switched off, and skips a chapter already read as it is', async () => {
    const off = await setup({ autoWorld: false })
    off.auto.changed({ kind: 'chapter', ...off.ref })
    off.later(2000)
    expect(await off.auto.tick()).toBe(false)

    const on = await setup({})
    const [s] = await lib.storySummaries(on.ref.seriesId)
    await lib.saveSummary(on.ref.seriesId, on.ref.volumeId, on.ref.chapterId, 'S.', s!.textHash)
    on.auto.changed({ kind: 'chapter', ...on.ref })
    on.later(2000)
    expect(await on.auto.tick()).toBe(false)
    expect(on.ran).toEqual([])
  })
})
