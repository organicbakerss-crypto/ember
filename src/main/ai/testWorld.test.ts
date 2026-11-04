/**
 * The test world, read chapter by chapter. Normally with a scripted model (to
 * check the pipeline end to end); with `npm run ai:eval`, with your real
 * Ollama, printing how well it did (AI_EVAL_HOST, AI_EVAL_MODEL to choose).
 */
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS } from '@shared/settings'
import { Library } from '../library/library'
import type { LibraryHost } from '../libraryHost'
import { AiService } from './service'
import { startFakeOllama, type FakeOllama } from './testing/fakeOllama'
import { makeTestWorld, score, TEST_CHAPTERS } from './testing/testWorld'

let dir: string
let lib: Library
let fake: FakeOllama | null = null
beforeEach(async () => {
  dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'ai-eval-'))
  lib = await Library.open(join(dir, 'lib'), { create: true })
})
afterEach(async () => {
  await fake?.close()
  fake = null
  await fs.promises.rm(dir, { recursive: true, force: true })
})

const plain = { canEncrypt: () => false, encrypt: (t: string) => t, decrypt: (t: string) => t }

async function run(host: string, model: string, idleMs?: number) {
  const ai = new AiService({
    settings: async () => ({ ...DEFAULT_AI_SETTINGS, enabled: true, host, model }),
    host: { current: lib } as unknown as LibraryHost,
    chatgpt: { file: join(dir, 'chatgpt.json'), secrets: plain },
    ...(idleMs ? { idleMs } : {}),
  })
  const at = await makeTestWorld(lib)
  const report = []
  for (const [i, chapterId] of at.chapters.entries()) {
    await ai.updateWorld(
      { requestId: `eval-${i}`, seriesId: at.seriesId, volumeId: at.volumeId, chapterId },
      () => {},
    )
    const view = await lib.world.view(at.worldId)
    const names = new Map(view.entries.map((e) => [e.id, e.name]))
    const items = (await lib.world.inbox(at.worldId, false)).captured.filter(
      (x) => x.source.chapterId === chapterId,
    )
    report.push({
      chapter: TEST_CHAPTERS[i]!.title,
      ...score(items, TEST_CHAPTERS[i]!.expect, names),
    })
  }
  const summaries = await lib.storySummaries(at.seriesId)
  return { report, summaries: summaries.map((s) => s.summary) }
}

/** What a model that reads perfectly would answer, per chapter. */
const PERFECT: Record<string, object> = {
  'The Harbour': {
    summary: 'Mara reaches Port Kell; Odo warns her Captain Brannoch of the Iron Guild wants her.',
    new: [
      {
        name: 'Captain Brannoch',
        kind: 'person',
        about: 'Iron Guild captain in a grey coat.',
        quote: '',
      },
    ],
    facts: [
      {
        entry: 'Mara',
        field: 'Where now',
        value: 'Port Kell',
        quote: 'Mara sailed into Port Kell at dawn, the hold full of salt.',
      },
    ],
    relationships: [{ from: 'Mara', to: 'Odo', type: 'friends', words: '', quote: '' }],
  },
  'Green Eyes': {
    summary: 'Odo joins the Iron Guild; Mara leaves Port Kell alone.',
    facts: [{ entry: 'Odo', field: 'Member of', value: 'Iron Guild', quote: '' }],
    continuity: [
      {
        entry: 'Mara',
        problem: 'Mara’s eyes are green here but grey in her notes.',
        quote: 'Mara watched him from the doorway, her green eyes narrow.',
      },
    ],
  },
  'The Captain': {
    summary: 'The Captain catches Mara at the ford.',
    questions: [{ question: 'Is “the Captain” Captain Brannoch?', quote: '' }],
  },
}

describe('the test world', () => {
  it('a model that reads it perfectly finds everything, and nothing else', async () => {
    fake = await startFakeOllama((req) => {
      const user = req.messages[1]!.content
      const title = Object.keys(PERFECT).find((t) => user.includes(`The chapter “${t}”`))!
      return JSON.stringify(PERFECT[title])
    })
    const { report, summaries } = await run(fake.url, 'llama3.2:3b')
    for (const r of report) {
      expect(r.missed, r.chapter).toEqual([])
      expect(r.extra, r.chapter).toEqual([])
    }
    expect(summaries.every(Boolean)).toBe(true)
  })

  it.runIf(process.env['AI_EVAL'])(
    'with your Ollama: how well it does',
    async () => {
      const host = process.env['AI_EVAL_HOST'] || 'http://127.0.0.1:11434'
      const model = process.env['AI_EVAL_MODEL'] || ''
      const { report, summaries } = await run(host, model, 600_000)
      const total = report.reduce((n, r) => n + r.found.length + r.missed.length, 0)
      const found = report.reduce((n, r) => n + r.found.length, 0)
      const lines = [`Model: ${model || '(the first installed)'} — found ${found} of ${total}`]
      for (const [i, r] of report.entries()) {
        lines.push(`\n${r.chapter}`, `  summary: ${summaries[i] ?? '(none)'}`)
        for (const f of r.found) lines.push(`  ✓ ${f}`)
        for (const m of r.missed) lines.push(`  ✗ missed: ${m}`)
        for (const x of r.extra) lines.push(`  + also: ${x}`)
      }
      console.log(lines.join('\n'))
    },
    30 * 60_000,
  )
})
