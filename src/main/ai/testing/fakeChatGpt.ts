/**
 * A pretend OpenAI for tests: the sign-in page (which "signs in" straight
 * away and sends the browser back), the token endpoint, the model list and
 * streamed answers. Not shipped.
 */
import { createServer } from 'node:http'

const jwt = (claims: Record<string, unknown>) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`

export interface FakeChatGpt {
  url: string
  requests: {
    path: string
    headers: Record<string, string | string[] | undefined>
    body: Record<string, unknown>
  }[]
  /** Makes the next access tokens already expired (to test refreshing). */
  expireTokens: boolean
  close(): Promise<void>
}

export async function startFakeChatGpt(): Promise<FakeChatGpt> {
  const requests: FakeChatGpt['requests'] = []
  const state = { expire: false, refreshes: 0 }
  const tokens = () => ({
    access_token: jwt({
      exp: Math.floor(Date.now() / 1000) + (state.expire ? -10 : 3600),
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'plus' },
    }),
    refresh_token: `refresh_${++state.refreshes}`,
    id_token: jwt({
      email: 'writer@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'plus' },
    }),
  })
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      let body: Record<string, unknown>
      try {
        body = raw.startsWith('{')
          ? (JSON.parse(raw) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(raw))
      } catch {
        body = {}
      }
      requests.push({ path: url.pathname, headers: req.headers, body })
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(v))
      }
      if (url.pathname === '/oauth/authorize') {
        // The writer signs in; the page sends the browser back to the app.
        const back = new URL(url.searchParams.get('redirect_uri')!)
        back.searchParams.set('code', 'code_123')
        back.searchParams.set('state', url.searchParams.get('state')!)
        res.writeHead(302, { location: back.toString() })
        return res.end()
      }
      if (url.pathname === '/oauth/token') return json(200, tokens())
      if (req.headers['authorization']?.toString().startsWith('Bearer ') !== true)
        return json(401, { detail: 'no' })
      if (url.pathname === '/models')
        return json(200, {
          models: [{ slug: 'gpt-6.1-sol' }, { slug: 'hidden-one', visibility: 'hide' }],
        })
      if (url.pathname === '/responses') {
        const input = (body['input'] as { content: { text: string }[] }[]) ?? []
        const last = input[input.length - 1]?.content[0]?.text ?? ''
        const format = (body['text'] as { format?: { type?: string } } | undefined)?.format
        const text =
          format?.type === 'json_schema'
            ? JSON.stringify({
                paragraphs: (JSON.parse(last) as { paragraphs: string[] }).paragraphs.map((p) =>
                  p.replace(/teh/g, 'the'),
                ),
              })
            : `From ChatGPT: ${last.slice(-40)}`
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (let i = 0; i < text.length; i += 8) {
          res.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: text.slice(i, i + 8) })}\n\n`,
          )
        }
        res.write(`data: ${JSON.stringify({ type: 'response.completed' })}\n\n`)
        return res.end()
      }
      json(404, { detail: 'not found' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get expireTokens() {
      return state.expire
    },
    set expireTokens(v) {
      state.expire = v
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
