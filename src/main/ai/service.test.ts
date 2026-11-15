import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AiSettings } from '@shared/settings'
import { Library } from '../library/library'
import type { LibraryHost } from '../libraryHost'
import { AiService } from './service'
import { startFakeOllama, type FakeOllama } from './testing/fakeOllama'
import { sharePage, type TestMessage } from '@shared/ai/sharedChatTestPage'

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

  it('keeps the writer’s fixes to who says a line, even after the chapter changes', async () => {
    const ref = await story()
    await lib.saveChapter(ref.seriesId, ref.volumeId, ref.chapterId, {
      content: doc('“Ew. Grape.”', 'Mara sighed.'),
    })
    fake = await startFakeOllama(() => JSON.stringify({ narrator: '', speakers: { '1': 'Mara' } }))
    const ai = service({})
    const first = await ai.chapterSpeakers({ requestId: 's1', ...ref }, () => {})
    expect(first.lines['ew grape']).toBe('Mara')
    await lib.fixSpeaker(ref.seriesId, ref.volumeId, ref.chapterId, 'ew grape', {
      entryId: null,
      name: 'Ashley',
    })
    expect(
      (await ai.chapterSpeakers({ requestId: 's2', ...ref }, () => {})).lines['ew grape'],
    ).toBe('Ashley')
    // The chapter changes: marked again by the AI, the fix still wins.
    await lib.saveChapter(ref.seriesId, ref.volumeId, ref.chapterId, {
      content: doc('“Ew. Grape.”', 'Mara sighed loudly.'),
    })
    const again = await ai.chapterSpeakers({ requestId: 's3', ...ref }, () => {})
    expect(fake.requests).toHaveLength(2)
    expect(again.lines['ew grape']).toBe('Ashley')
  })

  it('never answers blind: with nothing chosen it looks up the world and the story first', async () => {
    fake = await startFakeOllama(() => 'By the boats.')
    const ref = await story()
    const r = await service({}).ask(
      {
        requestId: 'r-look',
        seriesId: ref.seriesId,
        mode: 'chat',
        messages: [{ role: 'user', content: 'Where was Odo waiting?' }],
        scope: null,
        attachments: [{ name: 'handoff.md', text: 'Odo is secretly a prince.' }],
      },
      () => {},
    )
    const system = fake.requests[0]!.messages[0]!.content
    expect(system).toContain('Odo waited by the boats.')
    expect(system).toContain('handoff.md')
    expect(system).toContain('Odo is secretly a prince.')
    expect(system).toContain('never invent')
    expect(r.lookedAt.join(' ')).toContain('1 passage')
    expect(r.lookedAt.join(' ')).toContain('handoff.md')
  })

  it('reads the whole story word for word, or in parts with running notes when it is long', async () => {
    fake = await startFakeOllama((req) =>
      req.messages[0]!.content.includes('running notes')
        ? 'NOTES: Mara at the harbour.'
        : 'Answer.',
    )
    const ref = await story()
    const scope = { kind: 'full' as const, ...ref, volumeId: null, chapterId: null, text: '' }
    const ask = (q: string) =>
      service({}).ask(
        { requestId: `r-${q}`, mode: 'ask', messages: [{ role: 'user', content: q }], scope },
        () => {},
      )
    await ask('Who is at the harbour?')
    expect(fake.requests.at(-1)!.messages[0]!.content).toContain('Odo waited by the boats.')
    // A long story: read in parts, the answer from the notes.
    const long = Array.from(
      { length: 700 },
      (_, i) => `Sentence ${i} of a long chapter goes on and on here.`,
    )
    const ch = await lib.createChapter({
      seriesId: ref.seriesId,
      volumeId: ref.volumeId,
      title: 'Long',
    })
    await lib.saveChapter(ref.seriesId, ref.volumeId, ch.id, { content: doc(...long) })
    const before = fake.requests.length
    const r = await ask('Who is at the harbour?')
    const sent = fake.requests.slice(before)
    expect(sent.length).toBeGreaterThan(2)
    expect(sent.at(-1)!.messages[0]!.content).toContain('NOTES: Mara at the harbour.')
    expect(r.lookedAt.join(' ')).toContain('parts')
  })
})

describe('ChatGPT chats brought in by share link', () => {
  const ID = '6af6d288-3d88-83e8-bbb5-72a95ca016f6'
  const LINK = `https://chatgpt.com/share/${ID}`
  const pages = new Map<string, Response | (() => Response)>()
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://chatgpt.com/')) {
      const page = pages.get(url)
      if (!page) return new Response('Not found', { status: 404 })
      return typeof page === 'function' ? page() : page.clone()
    }
    return fetch(input, init)
  }) as typeof fetch
  const withPages = (settings: Partial<AiSettings>) =>
    new AiService({
      settings: async () => ({
        ...DEFAULT_AI_SETTINGS,
        enabled: true,
        host: fake!.url,
        ...settings,
      }),
      host: { current: lib } as unknown as LibraryHost,
      chatgpt: { file: join(dir, 'chatgpt.json'), secrets: plain },
      fetchImpl,
    })
  const page = (messages: TestMessage[]) =>
    new Response(sharePage('Saga planning', messages), { headers: { 'content-type': 'text/html' } })

  it('brings a chat in read-only, updates it from the same link, and refuses other links', async () => {
    fake = await startFakeOllama(() => 'ok')
    const ref = await story()
    const ai = withPages({})
    pages.set(
      LINK,
      page([
        { role: 'user', text: 'Where did the curse start?' },
        { role: 'assistant', text: 'It started at Kestrel Bay during the flood.' },
      ]),
    )
    const first = await ai.importChat(ref.seriesId, { url: `${LINK}?utm=x` })
    expect(first).toMatchObject({ title: 'Saga planning', messages: 2, updated: false })
    const list = await lib.listConversations(ref.seriesId)
    expect(list).toHaveLength(1)
    expect(list[0]!.imported?.url).toBe(LINK)
    const saved = await lib.readConversation(ref.seriesId, first.conversationId)
    expect(saved.source).toMatchObject({ kind: 'chatgpt-share', shareId: ID })

    // The chat grew in ChatGPT and the link was updated: the same conversation is updated.
    pages.set(
      LINK,
      page([
        { role: 'user', text: 'Where did the curse start?' },
        { role: 'assistant', text: 'It started at Kestrel Bay during the flood.' },
        { role: 'user', text: 'And who carries it?' },
        { role: 'assistant', text: 'Mara carries the curse now.' },
      ]),
    )
    const again = await ai.importChat(ref.seriesId, { url: LINK })
    expect(again).toMatchObject({
      conversationId: first.conversationId,
      messages: 4,
      updated: true,
    })
    expect(await lib.listConversations(ref.seriesId)).toHaveLength(1)

    await expect(
      ai.importChat(ref.seriesId, { url: 'https://example.com/share/x' }),
    ).rejects.toThrow(/isn’t a ChatGPT share link/)
    await expect(
      ai.importChat(ref.seriesId, {
        url: 'https://chatgpt.com/share/00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/save the page/)
    pages.set(LINK, new Response('<html>changed</html>'))
    await expect(ai.importChat(ref.seriesId, { url: LINK })).rejects.toThrow(/without the chat/)
    // A failed read leaves the chat brought in before as it was.
    expect((await lib.readConversation(ref.seriesId, first.conversationId)).messages).toHaveLength(
      4,
    )
  })

  it('brings a chat in from a page saved in the browser, and updates the same one later', async () => {
    fake = await startFakeOllama(() => 'ok')
    const ref = await story()
    const ai = withPages({})
    const saved = (n: number) =>
      sharePage(
        'Saga planning',
        Array.from({ length: n }, (_, i) => ({
          role: i % 2 ? ('assistant' as const) : ('user' as const),
          text: `Message ${i}`,
        })),
      ).replace('<head>', `<head><link rel="canonical" href="${LINK}"/>`)
    const first = await ai.importChat(ref.seriesId, { html: saved(4) })
    expect(first).toMatchObject({ messages: 4, updated: false })
    const again = await ai.importChat(ref.seriesId, { html: saved(10) })
    expect(again).toMatchObject({
      conversationId: first.conversationId,
      messages: 10,
      updated: true,
    })
    expect((await lib.readConversation(ref.seriesId, first.conversationId)).source?.url).toBe(LINK)
    await expect(
      ai.importChat(ref.seriesId, { html: '<html><body>My notes</body></html>' }),
    ).rejects.toThrow(/No ChatGPT conversation was found/)
  })

  it('looks through imported chats when answering, and says which chat it used', async () => {
    fake = await startFakeOllama(() => 'From your notes: the flood.')
    const ref = await story()
    const ai = withPages({})
    pages.set(
      LINK,
      page([
        { role: 'user', text: 'Where did the curse start?' },
        { role: 'assistant', text: 'It started at Kestrel Bay during the great flood.' },
        { role: 'user', text: 'What does Odo eat?' },
        { role: 'assistant', text: 'Odo eats bread and fish.' },
      ]),
    )
    await ai.importChat(ref.seriesId, { url: LINK })
    const r = await ai.ask(
      {
        requestId: 'r-chats',
        seriesId: ref.seriesId,
        mode: 'chat',
        messages: [{ role: 'user', content: 'Remind me where the curse started?' }],
        scope: null,
      },
      () => {},
    )
    const system = fake.requests[0]!.messages[0]!.content
    expect(system).toContain('earlier conversations with ChatGPT')
    expect(system).toContain('Kestrel Bay during the great flood')
    expect(system).toContain('“Saga planning”')
    expect(system).not.toContain('bread and fish')
    expect(r.lookedAt.join(' ')).toContain('your ChatGPT chat')
    // The imported chat itself is never sent as the conversation.
    expect(fake.requests[0]!.messages).toHaveLength(2)
  })

  it('carries on an imported chat: its latest messages word for word, the rest looked up', async () => {
    fake = await startFakeOllama(() => 'Picking up from the eye.')
    const ref = await story()
    const ai = withPages({})
    const long = 'filler '.repeat(400).trim()
    pages.set(
      LINK,
      page([
        { role: 'user', text: 'The vault holds the Saint’s Eye.' },
        { role: 'assistant', text: 'Then everyone hunts for the Eye.' },
        ...Array.from({ length: 10 }, (_, i) => ({
          role: i % 2 ? ('assistant' as const) : ('user' as const),
          text: `${long} middle ${i}`,
        })),
        { role: 'user', text: 'So whoever gets it has to pawn it off.' },
        { role: 'assistant', text: 'Yes: the pawn shop is the next scene.' },
      ]),
    )
    const imported = await ai.importChat(ref.seriesId, { url: LINK })
    const r = await ai.ask(
      {
        requestId: 'r-cont',
        seriesId: ref.seriesId,
        continues: imported.conversationId,
        mode: 'chat',
        messages: [{ role: 'user', content: 'Where were we with the Eye?' }],
        scope: null,
      },
      () => {},
    )
    const system = fake.requests[0]!.messages[0]!.content
    expect(system).toContain('carries on the writer')
    expect(system).toContain('Yes: the pawn shop is the next scene.')
    expect(system).toContain('middle 9')
    // Too far back for the local model's share word for word; found by the lookup instead.
    expect(system).not.toContain('middle 2')
    expect(system).toContain('The vault holds the Saint’s Eye.')
    expect(r.lookedAt.join(' ')).toMatch(/the last \d+ messages of “Saga planning”/)

    await lib.deleteConversation(ref.seriesId, imported.conversationId)
    const gone = await ai.ask(
      {
        requestId: 'r-cont2',
        seriesId: ref.seriesId,
        continues: imported.conversationId,
        mode: 'chat',
        messages: [{ role: 'user', content: 'Hello?' }],
        scope: null,
      },
      () => {},
    )
    expect(gone.lookedAt.join(' ')).toContain('is gone')
  })
})

describe('the story memory', () => {
  const T = (d: number) => new Date(Date.UTC(2026, 2, d)).toISOString()
  const long = (text: string) => `${text} ${'words '.repeat(2100)}`
  async function chatAboutTwoStories(seriesId: string) {
    const conversation = {
      formatVersion: 1,
      id: 'cnv_aaaaaaaaaaaaaaaa',
      mode: 'chat' as const,
      title: 'Casino Scene Feedback',
      createdAt: T(1),
      updatedAt: T(9),
      messages: [
        // Before the story had a name: only its characters.
        {
          role: 'user' as const,
          content: long('Josh hides the Eye in his apartment.'),
          at: T(1),
          read: null,
        },
        {
          role: 'user' as const,
          content: long('Space opera: the ship is called Wren.'),
          at: T(2),
          read: null,
        },
        {
          role: 'user' as const,
          content:
            'Casino: Josh and Rodney rob the vault for the Saint’s Eye. Maybe the dealer is the fence?',
          at: T(5),
          read: null,
        },
        { role: 'assistant' as const, content: 'Or the Eye could be fake.', at: T(5), read: null },
        {
          role: 'user' as const,
          content: 'No, the Eye is real. And yes, the dealer is the fence.',
          at: T(9),
          read: null,
        },
      ],
    }
    await lib.saveConversation(seriesId, conversation)
    return conversation
  }
  /** A pretend AI for the three steps: sorting, deciding which labels are the story, making nodes. */
  const ai3 = (r: { messages: { content: string }[] }) => {
    const system = r.messages[0]!.content
    const part = r.messages[1]?.content ?? ''
    if (system.includes('sorting a long conversation'))
      return JSON.stringify(
        part.includes('Wren')
          ? { label: 'space opera', about: 'The ship', names: ['Wren'] }
          : part.includes('Casino')
            ? {
                label: 'casino story',
                about: 'The vault job',
                names: ['Josh', 'Rodney', 'Saint’s Eye'],
              }
            : { label: 'josh story', about: 'Josh and the Eye', names: ['Josh', 'Eye'] },
      )
    if (system.includes('Decide which labels'))
      return JSON.stringify({
        identity: 'A casino heist: Josh and Rodney rob a vault for the Saint’s Eye.',
        // Seen whole, "josh story" is the same story as the casino one.
        labels: { 'casino story': true, 'josh story': true, 'space opera': false },
      })
    if (system.includes('You keep the story memory')) {
      if (part.includes('Wren'))
        return '{"relevant":true,"nodes":[{"title":"Wren","state":"fixed","summary":"The ship.","points":[{"text":"The ship is called Wren","state":"fixed"}]}],"loose":[]}'
      if (part.includes('apartment'))
        return '{"relevant":true,"nodes":[{"title":"The Saint’s Eye","state":"fixed","summary":"The relic.","points":[{"text":"Josh hides the Eye in his apartment","state":"fixed","quote":"hides the Eye"}]}],"loose":[]}'
      return JSON.stringify({
        relevant: true,
        nodes: [
          {
            node: '',
            title: 'The Saint’s Eye',
            state: 'fixed',
            summary: 'The relic in the vault.',
            book: null,
            points: [
              { text: 'The dealer is the fence', state: 'fixed', quote: 'the dealer is the fence' },
              { text: 'The Eye is fake', state: 'rejected', quote: 'Eye could be fake' },
            ],
          },
        ],
        loose: [{ text: 'A song in the casino', state: 'whim', quote: '' }],
      })
    }
    return 'An answer.'
  }
  const settle = async (ai: AiService, seriesId: string) => {
    let d = await ai.memory.draft(seriesId)
    for (let i = 0; i < 200 && d?.state === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      d = await ai.memory.draft(seriesId)
    }
    return d!
  }

  it('sorts the whole chat by story first, so early parts are judged with what came later', async () => {
    fake = await startFakeOllama(ai3)
    const ref = await story()
    const c = await chatAboutTwoStories(ref.seriesId)
    const ai = service({})
    await ai.memory.start({
      seriesId: ref.seriesId,
      conversationIds: [c.id],
      instruction: 'Only the casino story',
      clues: 'Josh and Rodney, a heist',
      from: null,
      to: null,
    })
    let d = await settle(ai, ref.seriesId)
    expect(d.phase).toBe('sorted')
    expect(d.parts.map((p) => [p.label, p.mine])).toEqual([
      ['josh story', true],
      ['space opera', false],
      ['casino story', true],
    ])
    expect(d.identity).toContain('casino heist')
    expect(d.nodes).toHaveLength(0) // nothing is made until the writer has checked
    const identify = fake.requests.find((r) =>
      r.messages[0]!.content.includes('Decide which labels'),
    )!
    expect(identify.messages[0]!.content).toContain('Josh and Rodney, a heist')

    await ai.memory.read(ref.seriesId)
    d = await settle(ai, ref.seriesId)
    expect(d.state).toBe('done')
    expect(d.parts.map((p) => p.status)).toEqual(['used', 'skipped', 'used'])
    expect(d.parts[1]!.reason).toContain('space opera')
    const eye = d.nodes.find((n) => n.title === 'The Saint’s Eye')!
    expect(eye.points.map((p) => p.text)).toContain('Josh hides the Eye in his apartment')
    expect(d.nodes.map((n) => n.title)).not.toContain('Wren')
    // Pass 2 knows the story from the start.
    const making = fake.requests.find((r) =>
      r.messages[0]!.content.includes('You keep the story memory'),
    )!
    expect(making.messages[0]!.content).toContain('A casino heist')

    expect(await ai.memory.keep(ref.seriesId)).toEqual({ nodes: 2 })
    const r = await ai.ask(
      {
        requestId: 'r-mem',
        seriesId: ref.seriesId,
        mode: 'chat',
        messages: [{ role: 'user', content: 'Who is the fence for the Eye?' }],
        scope: null,
      },
      () => {},
    )
    const system = fake.requests.at(-1)!.messages[0]!.content
    expect(system).toContain("From the story's memory")
    expect(system).toContain('The dealer is the fence')
    expect(system).not.toContain('The Eye is fake')
    expect(r.lookedAt.join(' ')).toContain('1 memory topic')
  })

  it('the writer can change the sorting; a skipped part can be read after all; dates limit what is read', async () => {
    fake = await startFakeOllama(ai3)
    const ref = await story()
    const c = await chatAboutTwoStories(ref.seriesId)
    const ai = service({})
    await ai.memory.start({
      seriesId: ref.seriesId,
      conversationIds: [c.id],
      instruction: 'casino',
      from: '2026-03-05',
      to: null,
    })
    let d = await settle(ai, ref.seriesId)
    expect(d.parts.every((p) => p.firstAt >= T(5))).toBe(true)
    await ai.memory.discard(ref.seriesId)

    await ai.memory.start({
      seriesId: ref.seriesId,
      conversationIds: [c.id],
      instruction: 'casino',
      from: null,
      to: null,
    })
    await settle(ai, ref.seriesId)
    // The writer says the first stretch isn't theirs after all.
    await ai.memory.read(ref.seriesId, [2])
    d = await settle(ai, ref.seriesId)
    expect(d.parts.map((p) => p.status)).toEqual(['skipped', 'skipped', 'used'])
    expect(d.parts[0]!.mineByWriter).toBe(true)
    // …then changes their mind about the space opera part: read it anyway.
    await ai.memory.resume(ref.seriesId, [1])
    d = await settle(ai, ref.seriesId)
    expect(d.nodes.map((n) => n.title)).toContain('Wren')
    expect(await ai.memory.keep(ref.seriesId, ['loose'])).toEqual({ nodes: 1 })
    expect((await lib.listNodes(ref.seriesId)).nodes.map((n) => n.title)).toEqual(['Loose ends'])
  })

  it('never overwrites a memory file it can’t read', async () => {
    const ref = await story()
    const dir = join(lib.paths.seriesDir(ref.seriesId), 'memory')
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(join(dir, 'nod_aaaaaaaaaaaaaaaa.json'), '{ broken')
    const { nodes, problems } = await lib.listNodes(ref.seriesId)
    expect(nodes).toHaveLength(0)
    expect(problems).toHaveLength(1)
    const T0 = new Date().toISOString()
    await expect(
      lib.saveNodes(ref.seriesId, [
        {
          formatVersion: 1,
          id: 'nod_aaaaaaaaaaaaaaaa',
          title: 'X',
          state: 'fixed',
          summary: '',
          volumeId: null,
          entryIds: [],
          links: [],
          parentId: null,
          loose: false,
          pos: null,
          points: [],
          history: [],
          createdAt: T0,
          updatedAt: T0,
        },
      ]),
    ).rejects.toThrow(/can't be read/)
    expect(await fs.promises.readFile(join(dir, 'nod_aaaaaaaaaaaaaaaa.json'), 'utf8')).toBe(
      '{ broken',
    )
  })
})
