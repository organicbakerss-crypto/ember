/**
 * Sign in with ChatGPT for local open-source clients.
 * https://developers.openai.com/siwc/token-sharing-open-source
 *
 * Dynamic OAuth client registration + PKCE, OIDC ID-token verification and
 * separately consented ChatGPT plan use through public Responses API.
 * No Codex client ID, internal backend URL, API key or browser-held token.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { appConfig } from '../../../app.config'
import { writeFileAtomic } from '../fs/atomicWrite'
import { AppError } from '../errors'
import { idleLimit, type IdleLimit } from './idle'
import type { ChatMessage } from './ollama'

export const AUTH_BASE = 'https://auth.openai.com'
export const ANSWERS_BASE = 'https://api.openai.com/v1'
const RESOURCE = 'https://api.openai.com/v1'
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const PERMISSION = 'chatgpt.tokens.use.direct'
const PORT = 1455
const CALLBACK_PATH = '/auth/callback'

export interface SecretBox {
  canEncrypt(): boolean
  encrypt(text: string): string
  decrypt(data: string): string
}

interface Login {
  clientId: string
  subject: string
  email: string | null
  idToken: string
  access: string
  refresh: string
  expires: number
  scopes: string[]
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
}

interface JwtClaims {
  iss?: string
  aud?: string | string[]
  exp?: number
  iat?: number
  nonce?: string
  sub?: string
  email?: string
}

interface Jwk {
  kid?: string
  kty: string
  alg?: string
  use?: string
  n?: string
  e?: string
}

const fail = (message: string) => new AppError('invalid-input', message)
const form = (data: Record<string, string>) => new URLSearchParams(data)
const page = (heading: string, message: string) =>
  `<!doctype html><meta charset="utf-8"><title>${heading}</title><body style="font:16px system-ui;max-width:32rem;margin:15vh auto;text-align:center"><h1>${heading}</h1><p>${message}</p></body>`

/** A token is trusted only after verifying its signature and OIDC claims. */
async function validateIdentity(
  idToken: string,
  clientId: string,
  nonce: string | null,
  fetchImpl: typeof fetch,
  authBase: string,
): Promise<JwtClaims & { sub: string }> {
  const segments = idToken.split('.')
  if (segments.length !== 3) throw fail('OpenAI returned an invalid identity token.')
  let header: { alg?: string; kid?: string }
  let claims: JwtClaims
  try {
    header = JSON.parse(Buffer.from(segments[0]!, 'base64url').toString('utf8'))
    claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8'))
  } catch {
    throw fail('OpenAI returned an unreadable identity token.')
  }
  if (header.alg !== 'RS256' || !header.kid)
    throw fail('OpenAI returned an unsupported identity-token signature.')
  const jwks = await fetchImpl(`${authBase}/.well-known/jwks.json`)
  if (!jwks.ok) throw fail('Couldn’t verify the ChatGPT sign-in (identity keys unavailable).')
  const keys = (await jwks.json()) as { keys?: Jwk[] }
  const key = keys.keys?.find((item) => item.kid === header.kid && item.kty === 'RSA' && (!item.use || item.use === 'sig'))
  if (!key) throw fail('Couldn’t verify the ChatGPT sign-in (unknown signing key).')
  let valid = false
  try {
    valid = verify(
      'RSA-SHA256',
      Buffer.from(`${segments[0]}.${segments[1]}`),
      createPublicKey({ key: { kty: key.kty, n: key.n, e: key.e }, format: 'jwk' }),
      Buffer.from(segments[2]!, 'base64url'),
    )
  } catch {
    valid = false
  }
  const now = Math.floor(Date.now() / 1000)
  if (
    !valid ||
    claims.iss !== authBase ||
    !(typeof claims.aud === 'string' ? claims.aud === clientId : claims.aud?.includes(clientId)) ||
    typeof claims.exp !== 'number' || claims.exp <= now ||
    (typeof claims.iat === 'number' && claims.iat > now + 60) ||
    !claims.sub ||
    (nonce !== null && claims.nonce !== nonce)
  ) throw fail('OpenAI identity verification failed. Please sign in again.')
  return claims as JwtClaims & { sub: string }
}

export class ChatGpt {
  private login: Login | null | undefined
  private hostId: string | null = null
  private waiting: Server | null = null
  private cancelPending: (() => void) | null = null
  private refreshPending: Promise<Login> | null = null

  constructor(private readonly options: {
    file: string
    secrets: SecretBox
    fetchImpl?: typeof fetch
    authBase?: string
    answersBase?: string
  }) {}

  private get fetch(): typeof fetch { return this.options.fetchImpl ?? fetch }
  private get authBase(): string { return this.options.authBase ?? AUTH_BASE }
  private get answersBase(): string { return this.options.answersBase ?? ANSWERS_BASE }
  private get hostFile(): string { return `${this.options.file}.host-id` }

  private async host(): Promise<string> {
    if (this.hostId) return this.hostId
    try {
      const stored = (await fs.promises.readFile(this.hostFile, 'utf8')).trim()
      if (/^urn:uuid:[0-9a-f-]{36}$/i.test(stored)) return (this.hostId = stored)
    } catch { /* first sign-in */ }
    const id = `urn:uuid:${randomUUID()}`
    await fs.promises.mkdir(join(this.hostFile, '..'), { recursive: true })
    await writeFileAtomic(this.hostFile, id)
    await fs.promises.chmod(this.hostFile, 0o600)
    this.hostId = id
    return id
  }

  private async load(): Promise<Login | null> {
    if (this.login !== undefined) return this.login
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.options.file, 'utf8')) as { encrypted: boolean; data: string }
      const text = raw.encrypted ? this.options.secrets.decrypt(raw.data) : raw.data
      const data = JSON.parse(text) as Partial<Login>
      // Old Codex OAuth tokens must NOT be reused for the supported SIWC flow.
      this.login = typeof data.clientId === 'string' && typeof data.subject === 'string' &&
        Array.isArray(data.scopes) ? data as Login : null
    } catch {
      this.login = null
    }
    return this.login
  }

  private async save(login: Login | null): Promise<void> {
    const text = login ? JSON.stringify(login) : ''
    if (!login) {
      this.login = null
      await fs.promises.rm(this.options.file, { force: true })
      return
    }
    const encrypted = this.options.secrets.canEncrypt()
    await fs.promises.mkdir(join(this.options.file, '..'), { recursive: true })
    await writeFileAtomic(this.options.file, JSON.stringify({
      encrypted,
      data: encrypted ? this.options.secrets.encrypt(text) : text,
    }))
    await fs.promises.chmod(this.options.file, 0o600)
    this.login = login
  }

  async account(): Promise<{ email: string | null; plan: string | null } | null> {
    const login = await this.load()
    return login?.access ? { email: login.email, plan: null } : null
  }

  async signOut(): Promise<void> {
    const previous = await this.load()
    // Keep the issued registration for a future sign-in on the same host.
    await this.save(previous ? { ...previous, access: '', refresh: '', idToken: '' } : null)
    if (!previous?.refresh) return
    try {
      const discovery = await this.fetch(`${this.authBase}/.well-known/openid-configuration`)
      if (!discovery.ok) throw Error('Discovery unavailable')
      const config = await discovery.json() as { revocation_endpoint?: string }
      if (!config.revocation_endpoint?.startsWith(`${this.authBase}/`)) throw Error('Invalid revocation endpoint')
      const response = await this.fetch(config.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ token: previous.refresh, token_type_hint: 'refresh_token', client_id: previous.clientId }),
      })
      if (!response.ok) throw Error('Revocation refused')
    } catch {
      throw fail('Signed out locally. Remote token revocation could not be confirmed; you can disconnect Ember in ChatGPT settings.')
    }
  }

  async signIn(open: (url: string) => Promise<void>, timeoutMs = 10 * 60_000): Promise<void> {
    this.cancelSignIn()
    const previous = await this.load()
    const host = await this.host()
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(24).toString('base64url')
    const nonce = randomBytes(24).toString('base64url')
    const registering = !previous?.clientId
    const selectedClient = previous?.clientId ?? 'dynamic_agent_client'
    const redirect = `http://127.0.0.1:${PORT}${CALLBACK_PATH}`

    const result = await new Promise<{ code: string; clientId: string }>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = (err?: Error, value?: { code: string; clientId: string }) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (server.listening) server.close()
        if (this.waiting === server) this.waiting = null
        this.cancelPending = null
        if (err) reject(err)
        else resolve(value!)
      }
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', redirect)
        if (url.pathname !== CALLBACK_PATH || req.method !== 'GET') {
          res.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        const issued = url.searchParams.get('client_id')
        const code = url.searchParams.get('code')
        if (url.searchParams.get('state') !== state || error || !code ||
            (registering && (!issued || issued === 'dynamic_agent_client')) ||
            (!registering && issued && issued !== selectedClient)) {
          res.writeHead(400, { 'content-type': 'text/html' })
          res.end(page('Sign-in not completed', 'Return to Ember and try again.'))
          done(fail(error ? `ChatGPT sign-in was declined: ${error}` : 'ChatGPT sign-in validation failed.'))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(page('Authorization received', `Return to ${appConfig.name} to finish connecting.`))
        done(undefined, { code, clientId: registering ? issued! : selectedClient })
      })
      this.waiting = server
      this.cancelPending = () => done(fail('ChatGPT sign-in cancelled.'))
      server.once('error', (e: NodeJS.ErrnoException) =>
        done(fail(e.code === 'EADDRINUSE'
          ? `Port ${PORT} is in use. Close the other sign-in and try again.`
          : `Couldn’t start sign-in: ${e.message}`)))
      timer = setTimeout(() => done(fail('ChatGPT sign-in timed out.')), timeoutMs)
      server.listen(PORT, '127.0.0.1', () => {
        const params = form({
          response_type: 'code',
          client_id: selectedClient,
          redirect_uri: redirect,
          scope: SCOPES,
          resource: RESOURCE,
          state,
          nonce,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          ext_agent_host_id: host,
        })
        if (registering) params.set('agent_name_hint', appConfig.name)
        else {
          if (previous?.idToken) params.set('id_token_hint', previous.idToken)
          if (previous?.email) params.set('login_hint', previous.email)
        }
        open(`${this.authBase}/api/accounts/authorize?${params}`).catch((error) =>
          done(fail(`Couldn’t open ChatGPT sign-in: ${String(error)}`)))
      })
    })

    const res = await this.fetch(`${this.authBase}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code: result.code,
        client_id: result.clientId,
        code_verifier: verifier,
        redirect_uri: redirect,
        resource: RESOURCE,
      }),
    })
    if (!res.ok) throw fail(`ChatGPT declined the authorization exchange (HTTP ${res.status}). Try again.`)
    const tokens = await res.json() as TokenResponse
    if (!tokens.access_token || !tokens.id_token || !tokens.refresh_token)
      throw fail('ChatGPT did not return complete sign-in credentials.')
    const identity = await validateIdentity(tokens.id_token, result.clientId, nonce, this.fetch, this.authBase)
    if (previous?.subject && previous.subject !== identity.sub)
      throw fail('This sign-in belongs to a different ChatGPT account. The existing registration was not replaced.')
    const scopes = tokens.scope?.split(/\s+/).filter(Boolean) ?? []
    if (!scopes.includes(PERMISSION)) throw fail('ChatGPT plan use was not authorized. Please reconnect and approve the plan-use permission.')
    await this.save({
      clientId: result.clientId,
      subject: identity.sub,
      email: typeof identity.email === 'string' ? identity.email : null,
      idToken: tokens.id_token,
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600),
      scopes,
    })
  }

  private async fresh(): Promise<Login> {
    const current = await this.load()
    if (!current?.access) throw fail('Connect your ChatGPT account in Settings → AI.')
    if (!current.scopes.includes(PERMISSION)) {
      throw fail('ChatGPT plan use was not authorized. Reconnect and allow Ember to use your plan.')
    }
    if (current.expires > Date.now() / 1000 + 90) return current
    if (this.refreshPending) return this.refreshPending
    this.refreshPending = (async () => {
      const res = await this.fetch(`${this.authBase}/api/accounts/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: 'refresh_token', client_id: current.clientId,
          refresh_token: current.refresh, resource: RESOURCE,
        }),
      })
      if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
          const body = await res.json().catch(() => ({})) as { error?: string }
          if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(body.error ?? '')) {
            await this.save({ ...current, access: '', refresh: '', idToken: '' })
            throw fail('ChatGPT sign-in expired. Reconnect in Settings → AI.')
          }
        }
        throw fail(`Couldn’t renew ChatGPT sign-in (HTTP ${res.status}). Try again.`)
      }
      const tokens = await res.json() as TokenResponse
      if (!tokens.access_token || !tokens.refresh_token) throw fail('ChatGPT returned an incomplete token refresh.')
      if (tokens.id_token) {
        const identity = await validateIdentity(tokens.id_token, current.clientId, null, this.fetch, this.authBase)
        if (identity.sub !== current.subject) throw fail('ChatGPT returned a refreshed token for a different account.')
      }
      const next = { ...current,
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        idToken: tokens.id_token ?? current.idToken,
        scopes: tokens.scope?.split(/\s+/).filter(Boolean) ?? current.scopes,
        expires: Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600),
      }
      await this.save(next)
      return next
    })()
    try { return await this.refreshPending }
    finally { this.refreshPending = null }
  }

  async models(): Promise<string[]> {
    const login = await this.fresh()
    const res = await this.fetch(`${this.answersBase}/models`, {
      headers: { authorization: `Bearer ${login.access}` },
    })
    if (!res.ok) throw fail(`Couldn’t retrieve ChatGPT models (HTTP ${res.status}).`)
    const data = await res.json() as { models?: { slug: string; visibility?: string }[] }
    return (data.models ?? []).filter((m) => m.visibility === 'list').map((m) => m.slug)
  }

  async chat(input: {
    messages: ChatMessage[]
    model: string
    json?: boolean
    signal?: AbortSignal
    idleMs?: number
    onToken?: (text: string) => void
  }): Promise<string> {
    const limit = idleLimit(input.signal, input.idleMs ?? 120000)
    try { return await this.stream(input, limit) }
    catch (error) {
      if (limit.timedOut) throw fail('ChatGPT stopped responding. Try again or check your plan usage.')
      throw error
    } finally { limit.done() }
  }

  private async stream(input: Parameters<ChatGpt['chat']>[0], limit: IdleLimit): Promise<string> {
    const login = await this.fresh()
    const instructions = input.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const body = {
      model: input.model,
      instructions,
      input: input.messages.filter((m) => m.role !== 'system').map((m) => ({
        role: m.role,
        content: m.content,
      })),
      store: false,
      stream: true,
    }
    let response: Response
    try {
      response = await this.fetch(`${this.answersBase}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${login.access}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: limit.signal,
      })
    } catch (error) {
      if (input.signal?.aborted && !limit.timedOut) throw new AppError('cancelled', 'Stopped.')
      throw new AppError('invalid-input', 'Couldn’t connect to ChatGPT.', { cause: error })
    }
    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => '')
      let diagnostic = raw
      try {
        const data = JSON.parse(raw) as { detail?: string; error?: { message?: string; code?: string } }
        diagnostic = data.error?.message ?? data.detail ?? raw
      } catch { /* non-JSON response */ }
      throw fail(`ChatGPT request failed (HTTP ${response.status}): ${diagnostic.slice(0, 350)}`)
    }
    let result = ''
    let pending = ''
    let completed = false
    const decoder = new TextDecoder()
    const consume = (block: string) => {
      const data = block.split('\n').filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart()).join('\n')
      if (!data || data === '[DONE]') return
      let event: { type?: string; delta?: string; response?: { error?: { message?: string; code?: string } }; message?: string }
      try { event = JSON.parse(data) } catch { throw fail('ChatGPT sent an unreadable stream event.') }
      if (event.type === 'response.output_text.delta' && event.delta) {
        result += event.delta
        input.onToken?.(event.delta)
      } else if (event.type === 'response.completed') {
        completed = true
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
        throw fail(`ChatGPT response did not complete: ${event.response?.error?.message ?? event.message ?? event.type}`)
      }
    }
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        limit.reset()
        pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
        let end: number
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, end)
          pending = pending.slice(end + 2)
          consume(block)
        }
      }
      pending += decoder.decode()
      if (pending.trim()) consume(pending)
    } catch (error) {
      if (input.signal?.aborted && !limit.timedOut) throw new AppError('cancelled', 'Stopped.')
      throw error
    }
    if (!completed) throw fail('ChatGPT stream ended before completing. Please retry.')
    return result
  }

  cancelSignIn(): void {
    this.cancelPending?.()
    this.waiting?.close()
    this.waiting = null
  }
}
