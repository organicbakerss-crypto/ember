import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AiSettings } from '@shared/settings'
import type { LibraryHost } from '../libraryHost'
import { AiService } from './service'
import { startFakeChatGpt, type FakeChatGpt } from './testing/fakeChatGpt'

let fake: FakeChatGpt | null = null
let dir = ''
afterEach(async () => {
  await fake?.close()
  fake = null
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

const plain = { canEncrypt: () => false, encrypt: (t: string) => t, decrypt: (t: string) => t }

async function setup() {
  fake = await startFakeChatGpt()
  dir = fs.mkdtempSync(join(os.tmpdir(), 'chatgpt-'))
  const settings: AiSettings = { ...DEFAULT_AI_SETTINGS, enabled: true, provider: 'chatgpt' }
  const ai = new AiService({
    settings: async () => settings,
    host: { current: null } as unknown as LibraryHost,
    chatgpt: {
      file: join(dir, 'chatgpt.json'),
      secrets: plain,
      authBase: fake.url,
      answersBase: fake.url,
    },
  })
  // The browser: follows the sign-in page back to the app.
  const browser = async (url: string) => {
    const response = await fetch(url, { redirect: 'follow' })
    await response.text()
  }
  return { ai, browser, settings }
}

describe('ChatGPT, signed in directly', () => {
  it('signs in with PKCE, keeps the login, answers in a stream, signs out', async () => {
    const { ai, browser } = await setup()
    expect((await ai.status()).account).toBeNull()
    const ask = {
      requestId: 'a',
      mode: 'chat' as const,
      messages: [{ role: 'user' as const, content: 'hi' }],
      scope: null,
    }
    await expect(ai.ask(ask, () => {})).rejects.toThrow(/Sign in with ChatGPT first/)

    let opened = ''
    await ai.chatgptSignIn(async (url) => {
      opened = url
      await browser(url)
    })
    const auth = new URL(opened)
    expect(auth.pathname).toBe('/api/accounts/authorize')
    expect(auth.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(auth.searchParams.get('resource')).toBe('https://api.openai.com/v1')
    expect(auth.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct')
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256')
    expect(new URL(auth.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1')
    expect(new URL(auth.searchParams.get('redirect_uri')!).pathname).toBe('/auth/callback')
    const token = fake!.requests.find((r) => r.path === '/api/accounts/oauth/token')!.body
    expect(token).toMatchObject({ grant_type: 'authorization_code', code: 'code_123' })
    expect(String(token['code_verifier']).length).toBeGreaterThan(40)

    const status = await ai.status()
    expect(status).toMatchObject({
      provider: 'chatgpt',
      account: { email: 'writer@example.com', plan: null },
      models: ['gpt-6.1-sol'],
    })
    // Kept on disk, so it survives a restart.
    expect(fs.existsSync(join(dir, 'chatgpt.json'))).toBe(true)

    const tokens: string[] = []
    const r = await ai.ask(
      {
        ...ask,
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'one' },
          { role: 'user', content: 'Is this scene working?' },
        ],
      },
      (t) => tokens.push(t),
    )
    expect(r.text).toBe('From ChatGPT: Is this scene working?')
    expect(tokens.length).toBeGreaterThan(1)
    const call = fake!.requests.find((x) => x.path === '/responses')!
    expect(call.headers.authorization?.toString()).toMatch(/^Bearer /)
    expect(call.body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true })
    expect((call.body['input'] as unknown[]).length).toBe(3)

    const e = await ai.editChapter(
      {
        requestId: 'g',
        seriesId: 'ser_none',
        instruction: 'Fix spelling',
        chapterTitle: 'A',
        chapter: 'teh end.',
        messages: [],
      },
      () => {},
    )
    expect(e.text).toBe('the end.')

    await ai.chatgptSignOut()
    expect((await ai.status()).account).toBeNull()
  })

  it('thinks as hard as asked in the AI pane, and copes with a model that can’t choose', async () => {
    const { ai, browser, settings } = await setup()
    await ai.chatgptSignIn(browser)
    const ask = {
      requestId: 't',
      mode: 'chat' as const,
      messages: [{ role: 'user' as const, content: 'Is this scene working?' }],
      scope: null,
    }
    const calls = () => fake!.requests.filter((r) => r.path === '/responses')
    await ai.ask(ask, () => {})
    expect(calls().at(-1)!.body['reasoning']).toBeUndefined() // automatic: the model decides

    settings.chatgptThinking = 'high'
    await ai.ask(ask, () => {})
    expect(calls().at(-1)!.body['reasoning']).toEqual({ effort: 'high' })

    // A model that refuses a thinking level: asked again without one, answered, remembered.
    fake!.rejectEffort = true
    const before = calls().length
    const r = await ai.ask(ask, () => {})
    expect(r.text).toContain('From ChatGPT')
    expect(calls().length).toBe(before + 2)
    expect(calls().at(-1)!.body['reasoning']).toBeUndefined()
    await ai.ask(ask, () => {})
    expect(calls().length).toBe(before + 3)
  })

  it('refreshes a login that has run out', async () => {
    const { ai, browser } = await setup()
    fake!.expireTokens = true
    await ai.chatgptSignIn(browser)
    fake!.expireTokens = false
    await ai.ask(
      { requestId: 'b', mode: 'chat', messages: [{ role: 'user', content: 'hi' }], scope: null },
      () => {},
    )
    const refresh = fake!.requests.filter(
      (r) => r.path === '/api/accounts/oauth/token' && r.body['grant_type'] === 'refresh_token',
    )
    expect(refresh.length).toBeGreaterThan(0)
  }, 10000)
})

describe('the story memory keeps up as you talk (ChatGPT)', () => {
  it('adds what the exchange settled, links topics, and can be undone', async () => {
    const { ai, browser, settings } = await setup()
    await ai.chatgptSignIn(browser)
    dir = dir || fs.mkdtempSync(join(os.tmpdir(), 'mem-'))
    const { Library } = await import('../library/library')
    const lib = await Library.open(join(dir, 'lib'), { create: true })
    ;(ai as unknown as { options: { host: { current: unknown } } }).options.host.current = lib
    const series = await lib.createSeries({ name: 'Casino', world: { mode: 'none' } })
    const T0 = new Date().toISOString()
    const mk = (
      i: number,
      title: string,
      points: { text: string; state: 'fixed' | 'unfixed' }[],
    ) => ({
      formatVersion: 1,
      id: `nod_${String(i).padStart(16, '0')}`,
      title,
      state: 'fixed' as const,
      summary: '',
      volumeId: null,
      entryIds: [],
      links: [],
      parentId: null,
      loose: false,
      pos: null,
      points: points.map((p, j) => ({
        id: `pnt_${String(i * 10 + j).padStart(16, '0')}`,
        ...p,
        sources: [],
        createdAt: T0,
        updatedAt: T0,
      })),
      history: [],
      createdAt: T0,
      updatedAt: T0,
    })
    await lib.saveNodes(series.id, [
      mk(1, 'The Saint’s Eye', [{ text: 'The dealer is the fence', state: 'unfixed' }]),
      mk(2, 'Casino heist', [{ text: 'It happens on a holiday', state: 'fixed' }]),
    ])
    let asked = ''
    fake!.answer = (instructions, last) => {
      if (!instructions.includes('keep the story memory')) return null
      asked = instructions
      expect(last).toContain('yes, the dealer is the fence')
      return JSON.stringify({
        points: [
          {
            node: 'T1',
            text: 'The Eye is hidden in a slot machine',
            state: 'fixed',
            quote: 'slot machine',
          },
          { node: 'LOOSE', text: 'A song plays during the heist', state: 'whim' },
        ],
        states: [{ point: 'P1', state: 'fixed', why: 'the writer agreed' }],
        links: [{ a: 'T1', b: 'T2' }],
      })
    }
    const change = await ai.updateMemory({
      seriesId: series.id,
      conversationId: 'cnv_aaaaaaaaaaaaaaaa',
      conversationTitle: 'Planning',
      question: 'Ok yes, the dealer is the fence. And the Eye is hidden in a slot machine.',
      answer: 'Great: the dealer fences it, and the slot machine hides it.',
    })
    expect(asked).toContain('The dealer is the fence')
    expect(change!.summary).toContain('linked “The Saint’s Eye” and “Casino heist”')
    let nodes = (await lib.listNodes(series.id)).nodes
    const eye = nodes.find((n) => n.title === 'The Saint’s Eye')!
    expect(eye.points.map((p) => [p.text, p.state])).toEqual([
      ['The dealer is the fence', 'fixed'],
      ['The Eye is hidden in a slot machine', 'fixed'],
    ])
    expect(eye.links).toEqual([mk(2, '', []).id])
    expect(eye.history.at(-1)!.what).toContain('From “Planning”')
    expect(nodes.find((n) => n.loose)!.points[0]!.text).toBe('A song plays during the heist')
    const call = fake!.requests.filter((r) => r.path === '/responses').at(-1)!
    expect(call.body['reasoning']).toEqual({ effort: 'low' }) // a quick step, never in the way

    // Undo puts everything back as it was (the new Loose ends goes too).
    expect(await ai.memoryLog.undo(series.id, change!.id)).toEqual({ undone: 3, skipped: [] })
    nodes = (await lib.listNodes(series.id)).nodes
    expect(nodes.map((n) => n.title).sort()).toEqual(['Casino heist', 'The Saint’s Eye'])
    expect(nodes.find((n) => n.title === 'The Saint’s Eye')!.points).toHaveLength(1)

    // Turned off: nothing happens.
    settings.memoryAuto = false
    expect(
      await ai.updateMemory({
        seriesId: series.id,
        conversationId: 'cnv_aaaaaaaaaaaaaaaa',
        conversationTitle: 'Planning',
        question: 'yes, the dealer is the fence',
        answer: 'ok',
      }),
    ).toBeNull()
  })
})
