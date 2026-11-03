/**
 * A tiny S3-compatible server for tests: one bucket in memory, signed
 * requests checked, conditional puts, paged listing. Not shipped.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { signV4 } from '../s3'

export interface FakeS3 {
  url: string
  objects: Map<string, { body: Buffer; etag: string; lastModified: Date }>
  /** Answer every request with this status (e.g. 503), or null. */
  failWith: number | null
  close(): Promise<void>
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

export async function startFakeS3(options: {
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  pageSize?: number
  port?: number
}): Promise<FakeS3> {
  const objects: FakeS3['objects'] = new Map()
  const state = { failWith: null as number | null }
  const pageSize = options.pageSize ?? 1000

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req)
      const send = (status: number, text = '', headers: Record<string, string> = {}) => {
        res.writeHead(status, headers)
        res.end(text)
      }
      if (state.failWith) return send(state.failWith, '<Error><Code>Fake</Code></Error>')
      const url = new URL(req.url ?? '/', 'http://x')
      // Check the signature.
      const auth = req.headers['authorization'] ?? ''
      const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1]?.split(';') ?? []
      const headers: Record<string, string> = {}
      for (const name of signed) headers[name] = String(req.headers[name] ?? '')
      const query: Record<string, string> = {}
      url.searchParams.forEach((v, k) => (query[k] = v))
      const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '')
      if (payloadHash !== createHash('sha256').update(body).digest('hex')) {
        return send(400, '<Error><Code>BadDigest</Code></Error>')
      }
      const expected = signV4({
        method: req.method ?? 'GET',
        path: url.pathname,
        query,
        headers,
        payloadHash,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        region: 'auto',
        service: 's3',
        amzDate: String(req.headers['x-amz-date'] ?? ''),
      })
      if (expected !== auth) return send(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>')

      const parts = url.pathname.split('/').slice(1)
      if (decodeURIComponent(parts[0] ?? '') !== options.bucket) {
        return send(404, '<Error><Code>NoSuchBucket</Code></Error>')
      }
      const key = parts.slice(1).map(decodeURIComponent).join('/')

      if (req.method === 'GET' && !key) {
        const prefix = query['prefix'] ?? ''
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
        const start = query['continuation-token'] ? Number(query['continuation-token']) : 0
        const page = keys.slice(start, start + pageSize)
        const truncated = start + pageSize < keys.length
        const xml =
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>` +
          page
            .map((k) => {
              const o = objects.get(k)!
              return `<Contents><Key>${esc(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>${esc(`"${o.etag}"`)}</ETag><Size>${o.body.length}</Size></Contents>`
            })
            .join('') +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : '') +
          `</ListBucketResult>`
        return send(200, xml, { 'content-type': 'application/xml' })
      }
      const existing = objects.get(key)
      if (req.method === 'GET') {
        if (!existing) return send(404, '<Error><Code>NoSuchKey</Code></Error>')
        res.writeHead(200, { etag: `"${existing.etag}"` })
        return res.end(existing.body)
      }
      if (req.method === 'PUT') {
        const ifMatch = req.headers['if-match']
        const ifNoneMatch = req.headers['if-none-match']
        if (ifNoneMatch === '*' && existing)
          return send(412, '<Error><Code>PreconditionFailed</Code></Error>')
        if (ifMatch !== undefined && (!existing || `"${existing.etag}"` !== ifMatch)) {
          return send(412, '<Error><Code>PreconditionFailed</Code></Error>')
        }
        const etag = createHash('md5')
          .update(body)
          .update(String(Date.now() + Math.random()))
          .digest('hex')
        objects.set(key, { body, etag, lastModified: new Date() })
        return send(200, '', { etag: `"${etag}"` })
      }
      if (req.method === 'DELETE') {
        objects.delete(key)
        return send(204)
      }
      send(405)
    })().catch((err) => {
      res.writeHead(500)
      res.end(String(err))
    })
  })
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    get failWith() {
      return state.failWith
    },
    set failWith(v) {
      state.failWith = v
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
