/** A local fake SIWC authorization server and streamed Responses API for tests only. */
import { createServer } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const kid = 'test-openai-key'
const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const signature = (claims: Record<string, unknown>) => {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const content = header + '.' + body
  return content + '.' + sign('RSA-SHA256', Buffer.from(content), keys.privateKey).toString('base64url')
}

export interface FakeChatGpt {
  url: string
  requests: {
    path: string
    headers: Record<string, string | string[] | undefined>
    body: Record<string, unknown>
  }[]
  expireTokens: boolean
  close(): Promise<void>
}

export async function startFakeChatGpt(): Promise<FakeChatGpt> {
  const requests: FakeChatGpt['requests'] = []
  const state = { expire: false, refreshes: 0, nonce: '', clientId: 'oaiapp_ember_test' }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      let body: Record<string, unknown>
      try {
        body = raw.startsWith('{')
          ? JSON.parse(raw) as Record<string, unknown>
          : Object.fromEntries(new URLSearchParams(raw))
      } catch { body = {} }
      requests.push({ path: url.pathname, headers: req.headers, body })
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      if (url.pathname === '/.well-known/jwks.json') {
        return json(200, { keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })
      }
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(200, { revocation_endpoint: 'http://127.0.0.1:' + (server.address() as {port: number}).port + '/revoke' })
      }
      if (url.pathname === '/revoke') return json(200, {})
      if (url.pathname === '/api/accounts/authorize') {
        state.nonce = url.searchParams.get('nonce') ?? ''
        const back = new URL(url.searchParams.get('redirect_uri')!)
        back.searchParams.set('code', 'code_123')
        back.searchParams.set('state', url.searchParams.get('state')!)
        if (url.searchParams.get('client_id') === 'dynamic_agent_client')
          back.searchParams.set('client_id', state.clientId)
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }
      if (url.pathname === '/api/accounts/oauth/token') {
        const now = Math.floor(Date.now() / 1000)
        return json(200, {
          access_token: signature({ exp: now + 3600, aud: 'https://api.openai.com/v1', iss: 'test' }),
          refresh_token: 'refresh_' + (++state.refreshes),
          id_token: signature({
            iss: 'http://127.0.0.1:' + (server.address() as {port: number}).port,
            aud: state.clientId,
            exp: now + 3600,
            iat: now,
            nonce: state.nonce,
            sub: 'subject_ember_test',
            email: 'writer@example.com',
          }),
          expires_in: state.expire ? -10 : 3600,
          scope,
        })
      }
      if (req.headers.authorization?.toString().startsWith('Bearer ') !== true)
        return json(401, { detail: 'no bearer token' })
      if (url.pathname === '/models') return json(200, {
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'hidden-one', visibility: 'hide' },
        ],
      })
      if (url.pathname === '/responses') {
        const input = body.input as { role: string; content: string }[]
        const last = input[input.length - 1]?.content ?? ''
        const editing = String(body.instructions ?? '').includes('You edit one chapter')
        const reply = editing
          ? last.slice(last.indexOf('”:') + 4).replace(/teh/g, 'the')
          : 'From ChatGPT: ' + last.slice(-40)
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (let i = 0; i < reply.length; i += 8) {
          res.write('event: response.output_text.delta\n' +
            'data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: reply.slice(i, i + 8) }) + '\n\n')
        }
        res.write('data: ' + JSON.stringify({ type: 'response.completed' }) + '\n\n')
        return res.end()
      }
      json(404, { detail: 'not found' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: 'http://127.0.0.1:' + port,
    requests,
    get expireTokens() { return state.expire },
    set expireTokens(value) { state.expire = value },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
