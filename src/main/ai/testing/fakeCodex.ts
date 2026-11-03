/**
 * A pretend `codex app-server` for tests: the same JSON-RPC lines, a sign-in
 * that "succeeds in the browser" when the sign-in URL is opened, and answers
 * by a rule. Written to a temp folder as a runnable script. Not shipped.
 */
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const SCRIPT = String.raw`#!/usr/bin/env node
const fs = require('fs')
const state = process.env.FAKE_CODEX_STATE
const read = () => { try { return JSON.parse(fs.readFileSync(state, 'utf8')) } catch { return { signedIn: false } } }
const write = (s) => fs.writeFileSync(state, JSON.stringify(s))
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
let buf = ''
let threads = 0
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    const s = read()
    const log = (s.log = s.log || []); log.push({ method: m.method, params: m.params }); write(s)
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake' } })
    else if (m.method === 'account/read') send({ id: m.id, result: { account: s.signedIn ? { type: 'chatgpt', email: 'writer@example.com', planType: 'plus' } : null, requiresOpenaiAuth: true } })
    else if (m.method === 'account/login/start') {
      send({ id: m.id, result: { type: 'chatgpt', loginId: 'L1', authUrl: 'https://auth.openai.com/oauth/authorize?fake=1' } })
      // The browser part: finishes when the test marks it done.
      const t = setInterval(() => { const x = read(); if (x.browserDone) { clearInterval(t); x.signedIn = true; write(x); send({ method: 'account/login/completed', params: { loginId: 'L1', success: true, error: null } }) } }, 50)
    }
    else if (m.method === 'account/logout') { s.signedIn = false; write(s); send({ id: m.id, result: {} }) }
    else if (m.method === 'model/list') send({ id: m.id, result: { data: [{ id: 'gpt-6.1', displayName: 'GPT-6.1', hidden: false }, { id: 'secret', hidden: true }], nextCursor: null } })
    else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'T' + (++threads) } } })
    else if (m.method === 'turn/start') {
      const threadId = m.params.threadId
      send({ id: m.id, result: { turn: { id: 'U1' } } })
      const text = m.params.outputSchema
        ? JSON.stringify({ paragraphs: JSON.parse(m.params.input[0].text.slice(m.params.input[0].text.indexOf('{'))).paragraphs.map((p) => p.replace(/teh/g, 'the')) })
        : 'From ChatGPT: ' + m.params.input[0].text.slice(-40)
      let k = 0
      const step = () => {
        if (read().interrupted) { send({ method: 'turn/completed', params: { threadId, turn: { status: 'interrupted', error: null } } }); return }
        if (k >= text.length) { send({ method: 'turn/completed', params: { threadId, turn: { status: 'completed', error: null } } }); return }
        send({ method: 'item/agentMessage/delta', params: { threadId, turnId: 'U1', itemId: 'I', delta: text.slice(k, k + 8) } }); k += 8
        setTimeout(step, 5)
      }
      step()
    }
    else if (m.method === 'turn/interrupt') { s.interrupted = true; write(s); send({ id: m.id, result: {} }) }
    else if (m.id !== undefined) send({ id: m.id, result: {} })
  }
})
`

export function makeFakeCodex(): { path: string; state: string; dir: string } {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'fake-codex-'))
  const path = join(dir, 'codex')
  fs.writeFileSync(path, SCRIPT, { mode: 0o755 })
  const state = join(dir, 'state.json')
  fs.writeFileSync(state, JSON.stringify({ signedIn: false }))
  return { path, state, dir }
}

export const readFakeState = (state: string) =>
  JSON.parse(fs.readFileSync(state, 'utf8')) as {
    signedIn: boolean
    log?: { method: string; params: Record<string, unknown> }[]
  }
