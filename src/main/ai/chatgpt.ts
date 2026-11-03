/**
 * ChatGPT with your own plan ("Sign in with ChatGPT"), directly: OpenAI's
 * sign-in page in the browser, back to a one-time local address on this
 * computer (OAuth with PKCE), then answers from the same service Codex uses,
 * on the plan's allowance. No API key, nothing else to install.
 *
 * The login stays on this computer, encrypted by the system where it can
 * be; it's refreshed when it runs out and removed on Sign out.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { appConfig } from '../../../app.config'
import { writeFileAtomic } from '../fs/atomicWrite'
import { AppError } from '../errors'
import type { ChatMessage } from './ollama'

export const AUTH_BASE = 'https://auth.openai.com'
export const ANSWERS_BASE = 'https://chatgpt.com/backend-api/codex'
/** The public sign-in client ChatGPT plans are used through. */
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const PORT = 1455
const REDIRECT = `http://127.0.0.1:${PORT}/auth/callback`
const SCOPE = 'openid profile email offline_access'

export interface SecretBox {
  canEncrypt(): boolean
  encrypt(text: string): string
  decrypt(data: string): string
}

interface Login {
  access: string
  refresh: string
  idToken: string
  /** Seconds since 1970 when the access token runs out. */
  expires: number
  accountId: string
  email: string | null
  plan: string | null
}

/** The claims in a JWT (not verified: only read for the account's name and plan). */
function claims(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

function loginFrom(
  tokens: { access_token: string; refresh_token?: string; id_token?: string },
  previous?: Login,
): Login {
  const idToken = tokens.id_token ?? previous?.idToken ?? ''
  const id = claims(idToken)
  const access = claims(tokens.access_token)
  const auth = (id['https://api.openai.com/auth'] ??
    access['https://api.openai.com/auth'] ??
    {}) as Record<string, unknown>
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token ?? previous?.refresh ?? '',
    idToken,
    expires: Number(access['exp']) || Math.floor(Date.now() / 1000) + 3600,
    accountId: String(auth['chatgpt_account_id'] ?? previous?.accountId ?? ''),
    email: (id['email'] as string | undefined) ?? previous?.email ?? null,
    plan: (auth['chatgpt_plan_type'] as string | undefined) ?? previous?.plan ?? null,
  }
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;text-align:center"><h1 style="font-size:1.4rem">${title}</h1><p>${text}</p></body>`

export class ChatGpt {
  private login: Login | null | undefined = undefined
  private waiting: Server | null = null

  constructor(
    private readonly options: {
      /** Where the login is kept (device-only). */
      file: string
      secrets: SecretBox
      fetchImpl?: typeof fetch
      authBase?: string
      answersBase?: string
    },
  ) {}

  private get fetch() {
    return this.options.fetchImpl ?? fetch
  }

  /* ---------- the login, kept on this computer ---------- */

  private async load(): Promise<Login | null> {
    if (this.login !== undefined) return this.login
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.options.file, 'utf8')) as {
        encrypted: boolean
        data: string
      }
      const text = raw.encrypted ? this.options.secrets.decrypt(raw.data) : raw.data
      this.login = JSON.parse(text) as Login
    } catch {
      this.login = null
    }
    return this.login
  }

  private async save(login: Login | null) {
    this.login = login
    if (!login) {
      await fs.promises.rm(this.options.file, { force: true })
      return
    }
    const text = JSON.stringify(login)
    const encrypted = this.options.secrets.canEncrypt()
    await fs.promises.mkdir(join(this.options.file, '..'), { recursive: true })
    await writeFileAtomic(
      this.options.file,
      JSON.stringify({ encrypted, data: encrypted ? this.options.secrets.encrypt(text) : text }),
    )
  }

  async account(): Promise<{ email: string | null; plan: string | null } | null> {
    const login = await this.load()
    return login ? { email: login.email, plan: login.plan } : null
  }

  async signOut(): Promise<void> {
    await this.save(null)
  }

  /**
   * Signs in: opens OpenAI's page (with `open`), waits for it to come back
   * to this computer, and keeps the login.
   */
  async signIn(open: (url: string) => Promise<void>, timeoutMs = 10 * 60_000): Promise<void> {
    this.waiting?.close()
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(24).toString('base64url')
    const authBase = this.options.authBase ?? AUTH_BASE

    const code = await new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', REDIRECT)
        if (url.pathname !== '/auth/callback') {
          res.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        if (url.searchParams.get('state') !== state || error || !url.searchParams.get('code')) {
          res.writeHead(400, { 'content-type': 'text/html' })
          res.end(page('Sign-in didn’t finish', 'Go back to the app and try again.'))
          reject(
            new AppError('invalid-input', `Sign-in didn’t finish${error ? `: ${error}` : ''}.`),
          )
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page('Signed in', `You can close this tab and go back to ${appConfig.name}.`))
        resolve(url.searchParams.get('code')!)
      })
      this.waiting = server
      server.on('error', (err: NodeJS.ErrnoException) =>
        reject(
          new AppError(
            'invalid-input',
            err.code === 'EADDRINUSE'
              ? `Something else is using port ${PORT} (another sign-in in progress, maybe Codex). Close it and try again.`
              : `Couldn’t start the sign-in: ${err.message}`,
          ),
        ),
      )
      const timer = setTimeout(
        () => reject(new AppError('invalid-input', 'Sign-in timed out. Try again.')),
        timeoutMs,
      )
      server.on('close', () => clearTimeout(timer))
      server.listen(PORT, '127.0.0.1', () => {
        const params = new URLSearchParams({
          response_type: 'code',
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT,
          scope: SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
          id_token_add_organizations: 'true',
          codex_cli_simplified_flow: 'true',
          originator: appConfig.urlScheme,
        })
        open(`${authBase}/oauth/authorize?${params}`).catch(reject)
      })
    }).finally(() => {
      this.waiting?.close()
      this.waiting = null
    })

    const res = await this.fetch(`${authBase}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }),
    })
    if (!res.ok) {
      throw new AppError(
        'invalid-input',
        `OpenAI refused the sign-in (${res.status}): ${await res.text().catch(() => '')}`.trim(),
      )
    }
    await this.save(loginFrom((await res.json()) as { access_token: string }))
  }

  /** A login that's still good (refreshed first when it has run out). */
  private async fresh(): Promise<Login> {
    const login = await this.load()
    if (!login) {
      throw new AppError(
        'invalid-input',
        'Sign in with ChatGPT first: Settings → AI → Continue with ChatGPT.',
      )
    }
    if (login.expires - 60 > Date.now() / 1000) return login
    const res = await this.fetch(`${this.options.authBase ?? AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: login.refresh,
        scope: 'openid profile email',
      }),
    })
    if (!res.ok) {
      await this.save(null)
      throw new AppError(
        'invalid-input',
        'Your ChatGPT sign-in has expired. Sign in again in Settings → AI.',
      )
    }
    const next = loginFrom((await res.json()) as { access_token: string }, login)
    await this.save(next)
    return next
  }

  /* ---------- answers ---------- */

  async models(): Promise<string[]> {
    const login = await this.fresh()
    try {
      const res = await this.fetch(
        `${this.options.answersBase ?? ANSWERS_BASE}/models?client_version=0.166.0`,
        {
          headers: this.headers(login),
        },
      )
      if (!res.ok) return []
      const data = (await res.json()) as {
        models?: { slug?: string; id?: string; visibility?: string }[]
        data?: { id: string }[]
      }
      const list = data.models ?? data.data ?? []
      return list
        .filter((m) => (m as { visibility?: string }).visibility !== 'hide')
        .map((m) => (m as { slug?: string }).slug ?? (m as { id: string }).id)
        .filter(Boolean)
    } catch {
      return []
    }
  }

  private headers(login: Login): Record<string, string> {
    return {
      authorization: `Bearer ${login.access}`,
      'chatgpt-account-id': login.accountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: appConfig.urlScheme,
      session_id: randomUUID(),
    }
  }

  /** One answer, streamed to `onToken` as it comes. */
  async chat(input: {
    messages: ChatMessage[]
    model: string
    json?: boolean
    signal?: AbortSignal
    onToken?: (text: string) => void
  }): Promise<string> {
    const login = await this.fresh()
    const instructions = input.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const body = {
      model: input.model,
      instructions,
      input: input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          type: 'message',
          role: m.role,
          content: [
            { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: m.content },
          ],
        })),
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
      // JSON answers (grammar) are asked for in the instructions and read leniently:
      // the plan's service doesn't take every structured-output option the API does.
    }
    let res: Response
    try {
      res = await this.fetch(`${this.options.answersBase ?? ANSWERS_BASE}/responses`, {
        method: 'POST',
        headers: {
          ...this.headers(login),
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: input.signal,
      })
    } catch (err) {
      if (input.signal?.aborted) throw new AppError('cancelled', 'Stopped.')
      throw new AppError('invalid-input', 'Couldn’t reach ChatGPT. Check your connection.', {
        cause: err,
      })
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      let message = text
      try {
        const data = JSON.parse(text) as { detail?: string; error?: { message?: string } }
        message = data.error?.message ?? data.detail ?? text
      } catch {
        // Plain text.
      }
      if (res.status === 401) {
        throw new AppError(
          'invalid-input',
          'ChatGPT didn’t accept the sign-in. Sign out and in again in Settings → AI.',
        )
      }
      if (res.status === 429) {
        throw new AppError(
          'invalid-input',
          `ChatGPT says you’ve hit your plan’s limit for now. ${message}`.trim(),
        )
      }
      throw new AppError(
        'invalid-input',
        `ChatGPT couldn’t answer (${res.status}): ${message.slice(0, 300)}`,
      )
    }
    let out = ''
    let pending = ''
    const decoder = new TextDecoder()
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true })
        let end: number
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, end)
          pending = pending.slice(end + 2)
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n')
          if (!data || data === '[DONE]') continue
          const event = JSON.parse(data) as {
            type?: string
            delta?: string
            response?: { error?: { message?: string } }
            message?: string
          }
          if (event.type === 'response.output_text.delta' && event.delta) {
            out += event.delta
            input.onToken?.(event.delta)
          } else if (event.type === 'response.failed' || event.type === 'error') {
            throw new AppError(
              'invalid-input',
              `ChatGPT couldn’t answer: ${event.response?.error?.message ?? event.message ?? 'failed'}`,
            )
          }
        }
      }
    } catch (err) {
      if (input.signal?.aborted) throw new AppError('cancelled', 'Stopped.')
      throw err
    }
    return out
  }

  cancelSignIn(): void {
    this.waiting?.close()
  }
}
