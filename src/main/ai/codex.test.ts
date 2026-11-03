import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS, type AiSettings } from '@shared/settings'
import type { LibraryHost } from '../libraryHost'
import { AiService } from './service'
import { findCodex } from './codex'
import { makeFakeCodex, readFakeState } from './testing/fakeCodex'

const made: string[] = []
let ai: AiService | null = null
afterEach(() => {
  ai?.dispose()
  ai = null
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function setup() {
  const fake = makeFakeCodex()
  made.push(fake.dir)
  process.env['FAKE_CODEX_STATE'] = fake.state
  const settings: AiSettings = {
    ...DEFAULT_AI_SETTINGS,
    enabled: true,
    provider: 'chatgpt',
    codexPath: fake.path,
  }
  ai = new AiService({
    settings: async () => settings,
    host: { current: null } as unknown as LibraryHost,
  })
  return { fake, ai, settings }
}

describe('ChatGPT through Codex', () => {
  it('signs in through the browser, answers in a stream, signs out', async () => {
    const { fake, ai } = setup()
    expect((await ai.status()).account).toBeNull()
    await expect(
      ai.ask(
        { requestId: 'a', mode: 'chat', messages: [{ role: 'user', content: 'hi' }], scope: null },
        () => {},
      ),
    ).rejects.toThrow(/Continue with ChatGPT/)

    let opened = ''
    await ai.chatgptSignIn(async (url) => {
      opened = url
      // The writer signs in on OpenAI's page.
      const s = readFakeState(fake.state)
      fs.writeFileSync(fake.state, JSON.stringify({ ...s, browserDone: true }))
    })
    expect(opened).toMatch(/^https:\/\/auth\.openai\.com\//)
    const status = await ai.status()
    expect(status).toMatchObject({
      provider: 'chatgpt',
      reachable: true,
      account: { email: 'writer@example.com', plan: 'plus' },
      models: ['gpt-6.1'],
    })

    const tokens: string[] = []
    const r = await ai.ask(
      {
        requestId: 'b',
        mode: 'chat',
        messages: [
          { role: 'user', content: 'first question' },
          { role: 'assistant', content: 'first answer' },
          { role: 'user', content: 'Is this scene working?' },
        ],
        scope: null,
      },
      (t) => tokens.push(t),
    )
    expect(r.text).toContain('Is this scene working?')
    expect(tokens.length).toBeGreaterThan(1)
    const log = readFakeState(fake.state).log!
    const start = log.find((l) => l.method === 'thread/start')!.params
    expect(start).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' })
    expect(String(start['baseInstructions'])).toContain('never run commands')
    const turn = log.find((l) => l.method === 'turn/start')!.params as { input: { text: string }[] }
    expect(turn.input[0]!.text).toContain('Writer: first question')

    // Grammar asks for JSON with a schema.
    const g = await ai.grammar({ requestId: 'g', paragraphs: ['teh end.'] }, () => {})
    expect(g.paragraphs).toEqual(['the end.'])

    await ai.chatgptSignOut()
    expect((await ai.status()).account).toBeNull()
  })

  it('says how to install Codex when it isn’t there', async () => {
    expect(findCodex('/nowhere/codex')).toBeNull()
    const settings = {
      ...DEFAULT_AI_SETTINGS,
      enabled: true,
      provider: 'chatgpt' as const,
      codexPath: '/nowhere/codex',
    }
    ai = new AiService({
      settings: async () => settings,
      host: { current: null } as unknown as LibraryHost,
    })
    const s = await ai.status()
    expect(s.reachable).toBe(false)
    expect(s.error).toMatch(/npm install -g @openai\/codex/)
  })
})
