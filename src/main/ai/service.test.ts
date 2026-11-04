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
    chatgpt: { file: join(dir, 'chatgpt.json'), secrets: plain },
  })
}

const plain = { canEncrypt: () => false, encrypt: (t: string) => t, decrypt: (t: string) => t }

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

  it('edit chapter: sends the chapter, the instruction, names and the conversation; returns the edit', async () => {
    fake = await startFakeOllama((req) => {
      const user = req.messages[1]!.content
      return user.slice(user.indexOf('“Arrival”:') + 12).replace(/teh/g, 'the')
    })
    const ref = await story()
    const tokens: string[] = []
    const r = await service({}).editChapter(
      {
        requestId: 'e',
        seriesId: ref.seriesId,
        instruction: 'Fix the spelling',
        chapterTitle: 'Arrival',
        chapter: 'Mara ran to teh harbour.\n\n* * *\n\nOdo waited.',
        messages: [{ role: 'user', content: 'Here is a scene I wrote: The bell rang.' }],
      },
      (t) => tokens.push(t),
    )
    expect(r.text).toBe('Mara ran to the harbour.\n\n* * *\n\nOdo waited.')
    expect(tokens.join('')).toBe(r.text)
    const [system, user] = fake.requests[0]!.messages
    expect(system!.content).toContain('Mara') // world names
    expect(system!.content).toContain('whole edited chapter')
    expect(user!.content).toContain('What to do: Fix the spelling')
    expect(user!.content).toContain('Writer: Here is a scene I wrote: The bell rang.')
  })

  it('explains what’s wrong: AI off, Ollama not running, model missing', async () => {
    fake = await startFakeOllama(() => '')
    const off = new AiService({
      settings: async () => DEFAULT_AI_SETTINGS,
      host: { current: lib } as unknown as LibraryHost,
      chatgpt: { file: join(dir, 'chatgpt.json'), secrets: plain },
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

  it('gives up when the AI goes quiet, and says so', async () => {
    const { createServer } = await import('node:http')
    const silent = createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ models: [{ name: 'm' }] }))
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      // Starts answering, then nothing.
      res.write(JSON.stringify({ message: { content: 'Hm' } }) + '\n')
    })
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r))
    const port = (silent.address() as { port: number }).port
    const ai = new AiService({
      settings: async () => ({
        ...DEFAULT_AI_SETTINGS,
        enabled: true,
        host: `http://127.0.0.1:${port}`,
      }),
      host: { current: lib } as unknown as LibraryHost,
      chatgpt: { file: join(dir, 'chatgpt.json'), secrets: plain },
      idleMs: 300,
    })
    await expect(
      ai.ask(
        { requestId: 'q', mode: 'chat', messages: [{ role: 'user', content: 'hi' }], scope: null },
        () => {},
      ),
    ).rejects.toThrow(/stopped answering/)
    silent.closeAllConnections()
    await new Promise<void>((r) => silent.close(() => r()))
  })

  it('updates the world from a chapter: summary kept, findings checked and sent to the inbox', async () => {
    const ref = await story()
    const odo = await lib.world.createEntry(ref.worldId, { name: 'Odo', template: 'person' })
    const findings = {
      summary: 'Mara runs to the harbour where Odo waits.',
      new: [{ name: 'Vela', kind: 'person', about: 'A stranger.', quote: '' }],
      facts: [
        {
          entry: 'Odo',
          field: 'Role',
          value: 'Boatman',
          quote: 'Odo waited by the boats.',
        },
      ],
      relationships: [{ from: 'Mara', to: 'Odo', type: 'friends', words: '', quote: '' }],
      continuity: [],
      questions: [{ question: 'Who is Vela?', quote: '' }],
    }
    fake = await startFakeOllama(() => JSON.stringify(findings))
    // Vela is in the chapter too.
    await lib.saveChapter(ref.seriesId, ref.volumeId, ref.chapterId, {
      content: doc('Mara ran to the harbour.', 'Odo waited by the boats.', 'Vela watched.'),
    })
    const progress: string[] = []
    const ai = service({ worldChanges: 'suggest' })
    const r = await ai.updateWorld({ requestId: 'u1', ...ref }, (t) => progress.push(t))
    expect(r).toMatchObject({ suggestions: 3, continuity: 0, questions: 1 })
    expect(progress[0]).toBe('Reading the chapter…')
    expect(fake.requests[0]!.format).toBe('json')
    const prompt = fake.requests[0]!.messages[1]!.content
    expect(prompt).toContain('Fields: Role, Status, Where now (a name)')
    expect(prompt).toContain('Other names already in the world: Kestrel Bay.')

    // The summary is kept with the chapter, and current.
    const [summary] = await lib.storySummaries(ref.seriesId)
    expect(summary).toMatchObject({ summary: findings.summary, current: true })

    // Accepting a fact: the entry gets it from this chapter on, with the line as a quote.
    const inbox = (await lib.world.inbox(ref.worldId, false)).captured
    const fact = inbox.find((i) => i.suggestion?.type === 'fact')!
    await lib.world.inboxAccept(ref.worldId, fact.id)
    const after = await lib.world.readEntry(ref.worldId, odo.id)
    expect(after.facts['role']).toMatchObject([
      { text: 'Boatman', from: { kind: 'chapter', chapterId: ref.chapterId } },
    ])
    expect(after.quotes.map((q) => [q.field, q.text])).toEqual([
      ['role', 'Odo waited by the boats.'],
    ])

    // New entries and relationships.
    const created = await lib.world.inboxAccept(
      ref.worldId,
      inbox.find((i) => i.suggestion?.type === 'new')!.id,
    )
    expect((await lib.world.readEntry(ref.worldId, created.entryId!)).name).toBe('Vela')
    const rel = await lib.world.inboxAccept(
      ref.worldId,
      inbox.find((i) => i.suggestion?.type === 'relationship')!.id,
    )
    expect((await lib.world.view(ref.worldId)).relationships.map((x) => x.id)).toEqual([
      rel.relationshipId,
    ])

    // Answering the question: never asked again, and told to the AI next time.
    const question = inbox.find((i) => i.kind === 'question')!
    await lib.world.answerQuestion(ref.worldId, question.id, 'A spy from the north.')
    expect((await lib.world.inbox(ref.worldId, false)).captured).toEqual([])
    await ai.updateWorld({ requestId: 'u2', ...ref }, () => {})
    expect(fake.requests[1]!.messages[1]!.content).toContain('Who is Vela? A spy from the north.')
    const again = (await lib.world.inbox(ref.worldId, false)).captured
    expect(again.some((i) => i.kind === 'question')).toBe(false)
    // Already done: not suggested twice.
    expect(again.map((i) => i.text)).toEqual([])
  })

  it('reading a chapter again replaces what it found there before, not captured lines', async () => {
    const ref = await story()
    fake = await startFakeOllama(() =>
      JSON.stringify({ summary: 'S.', questions: [{ question: 'Who is Odo?', quote: '' }] }),
    )
    const source = { ...ref, chapterTitle: 'Arrival' }
    await lib.world.inboxCapture(ref.worldId, 'Kept.', source)
    const ai = service({})
    await ai.updateWorld({ requestId: 'u1', ...ref }, () => {})
    await ai.updateWorld({ requestId: 'u2', ...ref }, () => {})
    const items = (await lib.world.inbox(ref.worldId, false)).captured
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['captured', 'Kept.'],
      ['question', 'Who is Odo?'],
    ])
  })

  it('says so when the AI’s answer can’t be read, and keeps nothing', async () => {
    const ref = await story()
    fake = await startFakeOllama(() => 'I think Mara is nice.')
    await expect(service({}).updateWorld({ requestId: 'u1', ...ref }, () => {})).rejects.toThrow(
      'couldn’t be read',
    )
    expect((await lib.storySummaries(ref.seriesId))[0]!.summary).toBeNull()
  })

  it('asks the whole story from chapter summaries, making the missing ones first', async () => {
    const ref = await story()
    const second = await lib.createChapter({
      seriesId: ref.seriesId,
      volumeId: ref.volumeId,
      title: 'The Letter',
    })
    await lib.saveChapter(ref.seriesId, ref.volumeId, second.id, {
      content: doc('Odo found a letter from Vela.'),
    })
    const [first] = await lib.storySummaries(ref.seriesId)
    await lib.saveSummary(ref.seriesId, ref.volumeId, ref.chapterId, 'Mara runs.', first!.textHash)
    fake = await startFakeOllama((req) =>
      req.messages[0]!.content.startsWith('Summarise') ? 'Odo finds Vela’s letter.' : 'In Ch 2.',
    )
    const progress: string[] = []
    const r = await service({}).ask(
      {
        requestId: 'a1',
        mode: 'ask',
        messages: [{ role: 'user', content: 'Where does the letter come from?' }],
        scope: { kind: 'story', seriesId: ref.seriesId, volumeId: null, chapterId: null, text: '' },
      },
      () => {},
      (t) => progress.push(t),
    )
    expect(r.text).toBe('In Ch 2.')
    // Only the chapter without a summary was summarised.
    expect(fake.requests).toHaveLength(2)
    expect(fake.requests[0]!.messages[1]!.content).toContain('Odo found a letter from Vela.')
    expect(progress[0]).toContain('1 of 1')
    const system = fake.requests[1]!.messages[0]!.content
    expect(system).toContain('Ch 1 “Arrival”: Mara runs.')
    expect(system).toContain('Ch 2 “The Letter”: Odo finds Vela’s letter.')
    expect(system).not.toContain('Odo found a letter') // summaries, not the text
    expect(system).toContain('The whole world, briefly')
    // Kept for next time.
    expect((await lib.storySummaries(ref.seriesId)).every((x) => x.current)).toBe(true)
  })

  it('makes the changes itself (new things first, so facts can name them), each undoable', async () => {
    const ref = await story()
    await lib.saveChapter(ref.seriesId, ref.volumeId, ref.chapterId, {
      content: doc('Mara ran to the harbour.', 'Vela watched from the tower.'),
    })
    fake = await startFakeOllama(() =>
      JSON.stringify({
        summary: 'S.',
        new: [{ name: 'Vela', kind: 'person', about: 'A watcher.', quote: '' }],
        // Vela isn't in the world yet when the AI answers: this lands on the second pass.
        facts: [
          { entry: 'Vela', field: 'Role', value: 'Watcher', quote: 'Vela watched from the tower.' },
        ],
        relationships: [{ from: 'Mara', to: 'Vela', type: 'met', words: '', quote: '' }],
        questions: [{ question: 'Who sent Vela?', quote: '' }],
      }),
    )
    const r = await service({}).updateWorld({ requestId: 'u1', ...ref }, () => {})
    expect(r).toMatchObject({ applied: 3, suggestions: 0, questions: 1 })
    const view = await lib.world.view(ref.worldId)
    const vela = view.entries.find((e) => e.name === 'Vela')!
    expect(vela.facts['role']?.map((v) => v.text)).toEqual(['Watcher'])
    expect(view.relationships).toHaveLength(1)
    const items = (await lib.world.inbox(ref.worldId, false)).captured
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['applied', 'New person: Vela — A watcher.'],
      ['applied', 'Vela: Role → Watcher'],
      ['applied', 'Mara and Vela: Met'],
      ['question', 'Who sent Vela?'],
    ])
    // Undo takes back exactly what it added.
    const fact = items[1]!
    await lib.world.saveEntry(ref.worldId, vela.id, { aliases: ['the Watcher'] }) // the writer's own change
    await lib.world.undoApplied(ref.worldId, fact.id)
    const after = await lib.world.readEntry(ref.worldId, vela.id)
    expect(after.facts['role'] ?? []).toEqual([])
    expect(after.quotes).toEqual([])
    expect(after.aliases).toEqual(['the Watcher'])
    await lib.world.undoApplied(ref.worldId, items[2]!.id)
    expect((await lib.world.view(ref.worldId)).relationships).toEqual([])
    await lib.world.undoApplied(ref.worldId, items[0]!.id)
    expect((await lib.world.view(ref.worldId)).entries.some((e) => e.name === 'Vela')).toBe(false)
    expect((await lib.listTrash()).map((t) => t.name)).toContain('Vela')
    // Reading the chapter again keeps nothing it already undid… and doesn't drop the question twice.
    expect((await lib.world.inbox(ref.worldId, false)).captured.map((i) => i.kind)).toEqual([
      'question',
    ])
  })

  it('sorts new names: entries of the right kind, and what isn’t a name set aside', async () => {
    const ref = await story()
    fake = await startFakeOllama(() =>
      JSON.stringify({
        names: [
          { name: 'Halloween', kind: 'none', about: '' },
          { name: 'Brannoch', kind: 'person', about: 'A captain.' },
          { name: 'Saltmarch', kind: 'place', about: '' },
        ],
      }),
    )
    const names = ['Halloween', 'Brannoch', 'Saltmarch', 'Unsorted'].map((name) => ({
      name,
      quote: `${name} was there.`,
      chapterId: ref.chapterId,
    }))
    const r = await service({}).sortNames(
      { requestId: 's1', worldId: ref.worldId, names },
      () => {},
    )
    expect(r).toEqual({ applied: 2, suggestions: 0, skipped: 1 })
    const view = await lib.world.view(ref.worldId)
    expect(view.entries.find((e) => e.name === 'Brannoch')?.template).toBe('person')
    expect(view.entries.find((e) => e.name === 'Saltmarch')?.template).toBe('city')
    expect(view.entries.some((e) => e.name === 'Halloween')).toBe(false)
    const items = (await lib.world.inbox(ref.worldId, false)).captured
    expect(items.map((i) => i.text)).toEqual([
      'New person: Brannoch — A captain.',
      'New place: Saltmarch',
    ])
    expect(fake.requests[0]!.messages[1]!.content).toContain('Halloween: “Halloween was there.”')
  })

  it('makes the audiobook script: who says each line, narration by the narrator, marked once', async () => {
    const ref = await story()
    const ashley = await lib.world.createEntry(ref.worldId, { name: 'Ashley', template: 'person' })
    const guy = await lib.world.createEntry(ref.worldId, { name: 'Guy', template: 'person' })
    await lib.saveChapter(ref.seriesId, ref.volumeId, ref.chapterId, {
      povEntryId: guy.id,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '“Hey,” I shot back. “Ease up.”' }],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '“Are you serious?”' },
              { type: 'hardBreak' },
              { type: 'text', text: ' She looked annoyed.' },
            ],
          },
          { type: 'sceneBreak' },
          { type: 'paragraph', content: [{ type: 'text', text: '“Ew. Grape.”' }] },
        ],
      },
    })
    fake = await startFakeOllama(() =>
      JSON.stringify({
        narrator: 'Guy',
        speakers: { '1': 'narrator', '2': 'narrator', '3': 'Ashley', '4': 'unknown' },
      }),
    )
    const r = await service({}).voiceScript(
      { requestId: 'v1', seriesId: ref.seriesId, volumeId: null, chapterId: ref.chapterId },
      () => {},
    )
    expect(fake.requests[0]!.messages[1]!.content).toContain(
      '[1] “Hey,” I shot back. [2] “Ease up.”',
    )
    expect(r.script).toBe(
      [
        '# Ch 1: Arrival',
        '[voice:Guy] “Hey,”',
        '[voice:Guy] I shot back.',
        '[voice:Guy] “Ease up.”',
        '[voice:Ashley] “Are you serious?”',
        '[voice:Guy] She looked annoyed.',
        '[pause 1s]',
        '[voice:Other] “Ew. Grape.”',
        '',
      ].join('\n'),
    )
    expect(r).toMatchObject({ chapters: 1, lines: 6 })
    const marked = await lib.readSpeakers(ref.seriesId, ref.volumeId, ref.chapterId)
    expect(marked?.lines['are you serious']).toEqual({ entryId: ashley.id, name: 'Ashley' })
    // Unchanged chapter: not marked again.
    await service({}).voiceScript(
      { requestId: 'v2', seriesId: ref.seriesId, volumeId: null, chapterId: ref.chapterId },
      () => {},
    )
    expect(fake.requests).toHaveLength(1)
  })

  it('flags a chapter that reads as told by someone other than its POV', async () => {
    const ref = await story()
    const a = await lib.world.createEntry(ref.worldId, { name: 'Guy A', template: 'person' })
    await lib.world.createEntry(ref.worldId, { name: 'Guy B', template: 'person' })
    await lib.saveChapter(ref.seriesId, ref.volumeId, ref.chapterId, { povEntryId: a.id })
    fake = await startFakeOllama(() => JSON.stringify({ narrator: 'Guy B', speakers: {} }))
    const r = await service({}).voiceScript(
      { requestId: 'v1', seriesId: ref.seriesId, volumeId: null, chapterId: ref.chapterId },
      () => {},
    )
    // The POV the writer set is used; the mismatch is flagged, nothing changed.
    expect(r.script).toContain('[voice:Guy A] Mara ran to the harbour.')
    const items = (await lib.world.inbox(ref.worldId, false)).captured
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      [
        'continuity',
        '“Arrival” reads as told by Guy B, but its POV is Guy A. The audio uses Guy A; change the POV if that’s wrong.',
      ],
    ])
  })

  it('third person: narration is the Narrator', async () => {
    const ref = await story()
    fake = await startFakeOllama(() => JSON.stringify({ narrator: '', speakers: {} }))
    const r = await service({}).voiceScript(
      { requestId: 'v1', seriesId: ref.seriesId, volumeId: null, chapterId: null },
      () => {},
    )
    expect(r.script).toContain('[voice:Narrator] Mara ran to the harbour.')
  })
})
