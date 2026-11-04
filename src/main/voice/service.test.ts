import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from '@shared/settings'
import { Library } from '../library/library'
import type { LibraryHost } from '../libraryHost'
import { VoiceService } from './service'
import { startFakeStudio, type FakeStudio } from './testing/fakeStudio'

let dir: string
let lib: Library
let fake: FakeStudio
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'voice-'))
  lib = await Library.open(join(dir, 'lib'), { create: true })
  fake = await startFakeStudio()
})
afterEach(async () => {
  await fake.close()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

const service = (settings: Partial<VoiceSettings> = {}) =>
  new VoiceService({
    settings: async () => ({
      ...DEFAULT_VOICE_SETTINGS,
      enabled: true,
      studioUrl: fake.url,
      ...settings,
    }),
    host: { current: lib } as unknown as LibraryHost,
  })

describe('VoiceStudio', () => {
  it('finds it and lists its voices; not used when switched off', async () => {
    expect(await service().status()).toMatchObject({
      studio: true,
      voices: [
        { id: 'p1', name: 'Calm narrator' },
        { id: 'p2', name: 'Ashley voice' },
      ],
    })
    expect((await service({ useStudio: false }).status()).studio).toBe(false)
    expect((await service({ studioUrl: 'http://127.0.0.1:1' }).status()).studio).toBe(false)
  })

  it('makes speech in the chosen voice, and keeps it so it’s made once', async () => {
    const v = service({ quality: 'fast', rate: 1.2 })
    const wav = await v.speak({ text: 'Ew. Grape.', voice: 'Ashley voice' })
    expect(Buffer.from(wav.slice(0, 4)).toString()).toBe('RIFF')
    expect(fake.spoken).toEqual([
      { text: 'Ew. Grape.', language: 'en', profile_id: 'p2', speed: 1.2, steps: 8, format: 'wav' },
    ])
    await v.speak({ text: '“Ew. Grape.”', voice: 'Ashley voice' }) // the same, once cleaned
    expect(fake.spoken).toHaveLength(1)
    await v.speak({ text: 'Ew. Grape.', voice: 'Ashley voice', fresh: true }) // Redo
    expect(fake.spoken).toHaveLength(2)
    fake.spoken.pop()
    // An unknown voice name uses VoiceStudio's default.
    await v.speak({ text: 'Hello.', voice: 'Nobody' })
    expect(fake.spoken[1]).not.toHaveProperty('profile_id')
  })

  it('transcribes, tidying quotes and the world’s names', async () => {
    fake.heard = 'Then Bran Ock said quote, hello, end quote.'
    expect(await service().transcribe(new Uint8Array([1, 2, 3]), 'audio/webm', ['Brannoch'])).toBe(
      'Then Brannoch said “hello”.',
    )
  })
})
