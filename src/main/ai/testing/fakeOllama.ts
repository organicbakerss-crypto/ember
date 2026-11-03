/** A pretend Ollama for tests: answers by a rule, streamed in small pieces. Not shipped. */
import { createServer } from 'node:http'

export interface FakeOllama {
  url: string
  /** The next answer, streamed slowly (for testing scrolling while it types). */
  next: string | null
  /** Every chat request received. */
  requests: { model: string; messages: { role: string; content: string }[]; format?: string }[]
  close(): Promise<void>
}

export async function startFakeOllama(
  answer: (request: FakeOllama['requests'][number]) => string,
  models = ['llama3.2:3b'],
): Promise<FakeOllama> {
  const requests: FakeOllama['requests'] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ models: models.map((name) => ({ name })) }))
      }
      if (req.url === '/api/chat') {
        const request = JSON.parse(body) as FakeOllama['requests'][number]
        if (!models.includes(request.model)) {
          res.writeHead(404, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: `model '${request.model}' not found` }))
        }
        requests.push(request)
        const slow = fake.next
        const text = slow ?? answer(request)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        const piece = (i: number) =>
          JSON.stringify({
            message: { role: 'assistant', content: text.slice(i, i + 7) },
            done: false,
          }) + '\n'
        if (!slow) {
          for (let i = 0; i < text.length; i += 7) res.write(piece(i))
          return res.end(JSON.stringify({ done: true }) + '\n')
        }
        let i = 0
        const step = () => {
          if (i >= text.length) return res.end(JSON.stringify({ done: true }) + '\n')
          res.write(piece(i))
          i += 7
          setTimeout(step, 2)
        }
        return step()
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const fake: FakeOllama = {
    url: `http://127.0.0.1:${port}`,
    requests,
    next: null,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
  return fake
}
