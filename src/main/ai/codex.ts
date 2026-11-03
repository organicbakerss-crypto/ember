/**
 * ChatGPT through Codex: OpenAI's official way for other apps to use a
 * ChatGPT plan ("Sign in with ChatGPT"). Codex's app-server runs in the
 * background and does the sign-in, keeps the login fresh, and talks to
 * OpenAI; this app never holds the login itself. It speaks JSON-RPC, one
 * message per line, over stdin/stdout.
 *
 * Codex is a coding agent, so every conversation here is started read-only,
 * with no approvals, in an empty folder, and told it isn't working on code.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { delimiter, join } from 'node:path'
import { appConfig } from '../../../app.config'
import { AppError } from '../errors'
import type { ChatMessage } from './ollama'

type Json = Record<string, unknown>

/** Where Codex is usually installed, beyond PATH (apps opened from a dock see a short PATH). */
function candidates(): string[] {
  const home = os.homedir()
  const exe = process.platform === 'win32' ? 'codex.cmd' : 'codex'
  const dirs = [
    ...(process.env['PATH'] ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, 'AppData', 'Roaming', 'npm'),
  ]
  return [...new Set(dirs.filter(Boolean).map((d) => join(d, exe)))]
}

/** The Codex command to run: the one set in Settings, or one found on this computer. */
export function findCodex(configured: string): string | null {
  if (configured.trim()) return fs.existsSync(configured.trim()) ? configured.trim() : null
  return candidates().find((p) => fs.existsSync(p)) ?? null
}

export const CODEX_MISSING =
  'Codex isn’t installed on this computer. Install it once with “npm install -g @openai/codex” (or the Codex app), then check again.'

/** A running `codex app-server`, started when first needed. */
export class CodexClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (v: Json) => void; reject: (e: Error) => void }
  >()
  private readonly listeners = new Set<(method: string, params: Json) => void>()
  private buffer = ''
  private workDir: string | null = null

  constructor(private readonly command: () => string | null) {}

  /** Starts Codex (once) and introduces this app to it. */
  start(): Promise<void> {
    if (this.ready) return this.ready
    const command = this.command()
    if (!command) return Promise.reject(new AppError('invalid-input', CODEX_MISSING))
    this.ready = new Promise<void>((resolve, reject) => {
      const child = spawn(command, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
        env: process.env,
      })
      this.child = child
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => this.read(chunk))
      child.stderr.on('data', () => {})
      child.on('error', (err) => {
        this.reset(new AppError('invalid-input', `Couldn’t start Codex: ${err.message}`))
        reject(new AppError('invalid-input', `Couldn’t start Codex (${command}): ${err.message}`))
      })
      child.on('exit', () => this.reset(new AppError('invalid-input', 'Codex stopped. Try again.')))
      this.request('initialize', {
        clientInfo: { name: appConfig.urlScheme, title: appConfig.name, version: '0.1.0' },
        capabilities: null,
      }).then(() => {
        this.notify('initialized')
        resolve()
      }, reject)
    })
    this.ready.catch(() => {
      this.ready = null
    })
    return this.ready
  }

  private reset(err: Error) {
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
    this.child = null
    this.ready = null
  }

  stop(): void {
    this.child?.kill()
    this.reset(new AppError('cancelled', 'Stopped.'))
  }

  private read(chunk: string) {
    this.buffer += chunk
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line) continue
      let msg: Json
      try {
        msg = JSON.parse(line) as Json
      } catch {
        continue
      }
      if (typeof msg['id'] === 'number' && ('result' in msg || 'error' in msg)) {
        const p = this.pending.get(msg['id'])
        if (!p) continue
        this.pending.delete(msg['id'])
        if (msg['error']) {
          const e = msg['error'] as { message?: string }
          p.reject(new AppError('invalid-input', `Codex: ${e.message ?? 'request failed'}`))
        } else p.resolve((msg['result'] ?? {}) as Json)
      } else if (typeof msg['method'] === 'string') {
        if ('id' in msg) {
          // A request from Codex (an approval, say): this app never approves anything.
          this.send({ id: msg['id'], error: { code: -32601, message: 'Not supported here.' } })
          continue
        }
        for (const l of this.listeners) l(msg['method'], (msg['params'] ?? {}) as Json)
      }
    }
  }

  private send(msg: Json) {
    this.child?.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  private notify(method: string, params?: Json) {
    this.send(params ? { method, params } : { method })
  }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  async call(method: string, params: Json = {}): Promise<Json> {
    await this.start()
    return this.request(method, params)
  }

  /** Listens to Codex's notifications until the returned function is called. */
  listen(listener: (method: string, params: Json) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /* ---------- the account ---------- */

  async account(): Promise<{ email: string | null; plan: string | null } | null> {
    const r = await this.call('account/read', {})
    const account = r['account'] as {
      type?: string
      email?: string | null
      planType?: string
    } | null
    return account?.type === 'chatgpt'
      ? { email: account.email ?? null, plan: account.planType ?? null }
      : null
  }

  /**
   * Signs in with ChatGPT: opens OpenAI's sign-in page (with `open`) and waits
   * for Codex to say it's done.
   */
  async signIn(open: (url: string) => Promise<void>, timeoutMs = 10 * 60_000): Promise<void> {
    await this.start()
    let stop = () => {}
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AppError('invalid-input', 'Sign-in timed out. Try again.')),
        timeoutMs,
      )
      stop = this.listen((method, params) => {
        if (method !== 'account/login/completed') return
        clearTimeout(timer)
        if (params['success']) resolve()
        else
          reject(
            new AppError(
              'invalid-input',
              `Sign-in didn’t finish: ${String(params['error'] ?? 'cancelled')}`,
            ),
          )
      })
    })
    try {
      const r = await this.request('account/login/start', { type: 'chatgpt' })
      if (typeof r['authUrl'] !== 'string')
        throw new AppError('invalid-input', 'Codex gave no sign-in page.')
      await open(r['authUrl'])
      await done
    } finally {
      stop()
    }
  }

  async signOut(): Promise<void> {
    await this.call('account/logout', {})
  }

  async models(): Promise<{ id: string; name: string }[]> {
    const r = await this.call('model/list', {})
    const data = (r['data'] ?? []) as { id: string; displayName?: string; hidden?: boolean }[]
    return data.filter((m) => !m.hidden).map((m) => ({ id: m.id, name: m.displayName || m.id }))
  }

  /* ---------- a conversation ---------- */

  private folder(): string {
    this.workDir ??= fs.mkdtempSync(join(os.tmpdir(), 'ai-'))
    return this.workDir
  }

  /** One answer: a short-lived conversation, streamed to `onToken`. */
  async chat(input: {
    messages: ChatMessage[]
    model?: string
    json?: boolean
    signal?: AbortSignal
    onToken?: (text: string) => void
  }): Promise<string> {
    await this.start()
    const system = input.messages.filter((m) => m.role === 'system').map((m) => m.content)
    const turns = input.messages.filter((m) => m.role !== 'system')
    const last = turns[turns.length - 1]
    const earlier = turns.slice(0, -1)
    const text =
      (earlier.length
        ? `The conversation so far:\n\n${earlier
            .map((m) => `${m.role === 'user' ? 'Writer' : 'You'}: ${m.content}`)
            .join('\n\n')}\n\nThe writer now says:\n\n`
        : '') + (last?.content ?? '')

    const thread = await this.request('thread/start', {
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      cwd: this.folder(),
      ...(input.model ? { model: input.model } : {}),
      baseInstructions: `${system.join('\n\n')}\n\nYou are not working on code or files here: never run commands, read files or use tools. Answer in plain text${input.json ? ' (JSON when asked for JSON)' : ''}.`,
    })
    const threadId = (thread['thread'] as { id: string }).id
    let out = ''
    let turnId: string | null = null
    let stop = () => {}
    const finished = new Promise<string>((resolve, reject) => {
      stop = this.listen((method, params) => {
        if (params['threadId'] !== threadId) return
        if (method === 'item/agentMessage/delta') {
          const delta = String(params['delta'] ?? '')
          out += delta
          input.onToken?.(delta)
        } else if (method === 'item/completed') {
          const item = params['item'] as { type?: string; text?: string }
          // A message that arrived whole (no deltas).
          if (item?.type === 'agentMessage' && item.text && !out) {
            out = item.text
            input.onToken?.(item.text)
          }
        } else if (method === 'turn/completed') {
          const turn = params['turn'] as { status: string; error: { message?: string } | null }
          if (turn.status === 'completed') resolve(out)
          else if (turn.status === 'interrupted') reject(new AppError('cancelled', 'Stopped.'))
          else
            reject(
              new AppError(
                'invalid-input',
                `ChatGPT couldn’t answer: ${turn.error?.message ?? turn.status}`,
              ),
            )
        }
      })
    })
    const onAbort = () => {
      if (turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => {})
    }
    input.signal?.addEventListener('abort', onAbort)
    try {
      const started = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(input.json ? { outputSchema: GRAMMAR_SCHEMA } : {}),
      })
      turnId = (started['turn'] as { id: string }).id
      if (input.signal?.aborted) onAbort()
      return await finished
    } finally {
      stop()
      input.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** The one JSON answer asked for: corrected paragraphs. */
const GRAMMAR_SCHEMA = {
  type: 'object',
  properties: { paragraphs: { type: 'array', items: { type: 'string' } } },
  required: ['paragraphs'],
  additionalProperties: false,
}
