/** A pretend VoiceStudio for tests: its capabilities, MCP tools and transcription. Not shipped. */
import { createServer } from 'node:http'

export interface FakeStudio {
  url: string
  /** Every generate_speech call's arguments. */
  spoken: Record<string, unknown>[]
  /** The text the next transcription returns. */
  heard: string
  close(): Promise<void>
}

/** A tiny valid WAV: `ms` of silence, then a short tone, then silence again. */
export function testWav(ms = 200): Buffer {
  const rate = 8000
  const n = Math.round((rate * ms) / 1000)
  const data = Buffer.alloc(n * 2)
  for (let i = Math.floor(n / 3); i < Math.floor((2 * n) / 3); i++) {
    data.writeInt16LE(Math.round(8000 * Math.sin(i / 3)), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

export async function startFakeStudio(
  voices = [
    { id: 'p1', name: 'Calm narrator' },
    { id: 'p2', name: 'Ashley voice' },
  ],
): Promise<FakeStudio> {
  const fake: FakeStudio = { url: '', spoken: [], heard: 'Hello there', close: async () => {} }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      if (req.url === '/.well-known/voicestudio-speech') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ service: 'VoiceStudio' }))
      }
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ text: fake.heard }))
      }
      if (req.url?.startsWith('/mcp')) {
        const msg = JSON.parse(body.toString()) as {
          id?: number
          method: string
          params?: { name?: string; arguments?: Record<string, unknown> }
        }
        if (msg.id === undefined) {
          res.writeHead(202)
          return res.end()
        }
        let result: unknown = {}
        if (msg.method === 'tools/call') {
          const name = msg.params?.name
          const args = msg.params?.arguments ?? {}
          let out: unknown = null
          if (name === 'list_voices') out = voices.map((v) => ({ ...v, type: 'clone' }))
          if (name === 'generate_speech') {
            fake.spoken.push(args)
            out = { audio_id: `a${fake.spoken.length}`, wav_base64: testWav().toString('base64') }
          }
          result = { structuredContent: { result: JSON.stringify(out) }, isError: false }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' })
        return res.end(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`,
        )
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const address = server.address() as { port: number }
  fake.url = `http://127.0.0.1:${address.port}`
  fake.close = () => new Promise((r) => server.close(() => r()))
  return fake
}
