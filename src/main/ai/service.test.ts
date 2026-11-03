import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AiSettings } from '@shared/settings'
import { Library } from '../library/library'
import type { LibraryHost } from '../libraryHost'
import { AiService } from './service'
import { startFakeOllama, type FakeOllama } from './testing/fakeOllama'

let dir: string
let lib: Library
let fake: FakeOllama | null = null
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'ai-'))
  lib = await Library.open(join(dir, 'lib'), { create: true })
})
afterEach(async () => {
  await fake?.close()
  fake = null
  await fs.promises.rm(dir, { recursive: true, force: true })
})

const doc = (...ps: string[]) => ({
  type: 'doc' as const,
  content: ps.map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
})

function service(settings: Partial<AiSettings>) {
  return new AiService({
    settings: async () => ({ ...DEFAULT_AI_SETTINGS, enabled: true, host: fake!.url, ...settings }),
    host: { current: lib } as unknown as LibraryHost,
  })
}

async function story() {
  const series = await lib.createSeries({ name: 'Saga', world: { mode: 'new', name: 'Isles' } })
  const volume = await lib.createVolume({ seriesId: series.id, name: 'One' })
  const ch = await lib.createChapter({ seriesId: series.id, volumeId: volume.id, title: 'Arrival' })
  await lib.saveChapter(series.id, volume.id, ch.id, {
    content: doc('Mara ran to the harbour.', 'Odo waited by the boats.'),
  })
  await lib.world.createEntry(series.worldId!, { name: 'Mara', template: 'person' })
  await lib.world.createEntry(series.worldId!, { name: 'Kestrel Bay', template: 'place' })
  return { seriesId: series.id, volumeId: volume.id, chapterId: ch.id, worldId: series.worldId! }
}

describe('the AI service', () => {
  it('reads only the scope, with the world entries named in it, and streams the answer', async () => {
    fake = await startFakeOllama(() => 'Three ideas:\n1. A storm\n2. A letter\n3. A stranger')
    const ref = await story()
    const tokens: string[] = []
    const r = await service({}).ask(
      {
        requestId: 'r1',
        mode: 'brainstorm',
        messages: [{ role: 'user', content: 'What could happen next?' }],
        scope: { kind: 'selection', ...ref, text: 'Mara ran to the harbour.' },
      },
      (t) => tokens.push(t),
    )
    expect(r.text).toContain('A stranger')
    expect(tokens.join('')).toBe(r.text)
    expect(tokens.length).toBeGreaterThan(1)
    const system = fake.requests[0]!.messages[0]!.content
    expect(system).toContain('the passage the writer selected')
    expect(system).toContain('Mara ran to the harbour.')
    expect(system).not.toContain('Odo waited')
    expect(system).toContain('Mara') // her entry
    expect(system).not.toContain('Kestrel Bay') // not named in the scope
    expect(fake.requests[0]!.model).toBe('llama3.2:3b')
  })

  it('“Ask the story” adds the world digest; the whole chapter is read when asked', async () => {
    fake = await startFakeOllama(() => 'Odo waited by the boats.')
    const ref = await story()
    await service({}).ask(
      {
        requestId: 'r2',
        mode: 'ask',
        messages: [{ role: 'user', content: 'Where is Odo?' }],
        scope: { kind: 'chapter', ...ref, text: '' },
      },
      () => {},
    )
    const system = fake.requests[0]!.messages[0]!.content
    expect(system).toContain('Odo waited by the boats.')
    expect(system).toContain('Kestrel Bay') // in the digest
    expect(system).toContain('only the text and world notes provided')
  })

  it('grammar: corrected paragraphs, world names kept, scene breaks skipped, bad replies retried', async () => {
    let call = 0
    fake = await startFakeOllama((req) => {
      call++
      const { paragraphs } = JSON.parse(req.messages[1]!.content) as { paragraphs: string[] }
      // The first (batched) reply loses a paragraph; single ones come back fixed.
      if (call === 1 && paragraphs.length > 1)
        return JSON.stringify({ paragraphs: [paragraphs[0]] })
      return JSON.stringify({ paragraphs: paragraphs.map((p) => p.replace('teh', 'the')) })
    })
    const ref = await story()
    const progress: number[] = []
    const r = await service({}).grammar(
      { requestId: 'g', paragraphs: ['teh cat.', '* * *', '', 'teh dog.'], worldId: ref.worldId },
      (done) => progress.push(done),
    )
    expect(r.paragraphs).toEqual(['the cat.', '* * *', '', 'the dog.'])
    expect(fake.requests[0]!.format).toBe('json')
    expect(fake.requests[0]!.messages[0]!.content).toContain('Mara')
    expect(progress.at(-1)).toBe(2)
  })

  it('explains what’s wrong: AI off, Ollama not running, model missing', async () => {
    fake = await startFakeOllama(() => '')
    const off = new AiService({
      settings: async () => DEFAULT_AI_SETTINGS,
      host: { current: lib } as unknown as LibraryHost,
    })
    const ask = {
      requestId: 'x',
      mode: 'chat' as const,
      messages: [{ role: 'user' as const, content: 'hi' }],
      scope: null,
    }
    await expect(off.ask(ask, () => {})).rejects.toThrow(/AI is off/)
    await expect(service({ host: 'http://127.0.0.1:1' }).ask(ask, () => {})).rejects.toThrow(
      /Is it running/,
    )
    await expect(service({ model: 'nope' }).ask(ask, () => {})).rejects.toThrow(/ollama pull nope/)
    const status = await service({}).status()
    expect(status).toMatchObject({ reachable: true, models: ['llama3.2:3b'], model: 'llama3.2:3b' })
  })

  it('stops a request when asked', async () => {
    fake = await startFakeOllama(() => 'x'.repeat(5000))
    const ai = service({})
    const asking = ai.ask(
      { requestId: 'stop', mode: 'chat', messages: [{ role: 'user', content: 'hi' }], scope: null },
      () => ai.cancel('stop'),
    )
    await expect(asking).rejects.toThrow(/Stopped/)
  })
})
