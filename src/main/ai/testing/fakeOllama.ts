/** A pretend Ollama for tests: answers by a rule, streamed in small pieces. Not shipped. */
import { createServer } from 'node:http'

export interface FakeOllama {
  url: string
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
        const text = answer(request)
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        for (let i = 0; i < text.length; i += 7) {
          res.write(
            JSON.stringify({
              message: { role: 'assistant', content: text.slice(i, i + 7) },
              done: false,
            }) + '\n',
          )
        }
        return res.end(JSON.stringify({ done: true }) + '\n')
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
