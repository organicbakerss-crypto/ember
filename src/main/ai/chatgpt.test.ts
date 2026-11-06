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
