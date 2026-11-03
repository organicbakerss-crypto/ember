/**
 * A small S3 client (just what sync needs) for Cloudflare R2 or any
 * S3-compatible store: get, conditional put, list and delete, signed with
 * AWS Signature Version 4. No SDK: it's a few requests.
 */
import { createHash, createHmac } from 'node:crypto'
import {
  CloudError,
  PreconditionFailed,
  stripQuotes,
  type CloudObject,
  type CloudStore,
  type PutCondition,
} from './cloud'

export interface S3Credentials {
  /** e.g. https://<account>.r2.cloudflarestorage.com */
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** R2 uses "auto". */
  region?: string
}

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding, as SigV4 wants it (`/` kept in paths). */
export function uriEncode(value: string, keepSlash = false): string {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const ch = String.fromCharCode(byte)
      if (/[A-Za-z0-9\-._~]/.test(ch) || (keepSlash && ch === '/')) return ch
      return `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    })
    .join('')
}

export interface SignInput {
  method: string
  /** Already-encoded path, starting with `/`. */
  path: string
  query: Record<string, string>
  /** Lower-case names. `host` must be included. */
  headers: Record<string, string>
  payloadHash: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  service: string
  /** yyyymmddThhmmssZ */
  amzDate: string
}

/** The Authorization header for a request (AWS Signature Version 4). */
export function signV4(input: SignInput): string {
  const date = input.amzDate.slice(0, 8)
  const names = Object.keys(input.headers)
    .map((n) => n.toLowerCase())
    .sort()
  const lower = Object.fromEntries(
    Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
  const canonicalHeaders = names
    .map((n) => `${n}:${lower[n]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const signedHeaders = names.join(';')
  const canonicalQuery = Object.keys(input.query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(input.query[k]!)}`)
    .join('&')
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n')
  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join(
    '\n',
  )
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, input.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
}

const xmlText = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]

/** Splits a pasted "S3 API" URL (which may end in the bucket name) into endpoint and bucket. */
export function parseBucketUrl(url: string): { endpoint: string; bucket: string } | null {
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const bucket = u.pathname.split('/').filter(Boolean)[0] ?? ''
  return { endpoint: `${u.protocol}//${u.host}`, bucket }
}

const TIMEOUT_MS = 60_000

export class S3Cloud implements CloudStore {
  private readonly region: string

  constructor(
    private readonly creds: S3Credentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.region = creds.region ?? 'auto'
  }

  private async request(
    method: string,
    key: string | null,
    options: {
      query?: Record<string, string>
      body?: Uint8Array
      headers?: Record<string, string>
    } = {},
  ): Promise<Response> {
    const base = new URL(this.creds.endpoint)
    const path =
      `/${uriEncode(this.creds.bucket)}` + (key === null ? '' : `/${uriEncode(key, true)}`)
    const query = options.query ?? {}
    const body = options.body ?? new Uint8Array()
    const payloadHash = sha256Hex(body)
    const amzDate = this.clock()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '')
    const headers: Record<string, string> = {
      host: base.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...options.headers,
    }
    headers['authorization'] = signV4({
      method,
      path,
      query,
      headers,
      payloadHash,
      accessKeyId: this.creds.accessKeyId,
      secretAccessKey: this.creds.secretAccessKey,
      region: this.region,
      service: 's3',
      amzDate,
    })
    delete headers['host']
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
      .join('&')
    const url = `${base.protocol}//${base.host}${path}${qs ? `?${qs}` : ''}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: method === 'PUT' ? body : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      const code = String(((err as { cause?: { code?: string } }).cause ?? {}).code ?? '')
      if (code.startsWith('ERR_SSL')) {
        // Cloudflare refuses the connection itself for an address it doesn't know.
        throw new CloudError(
          'other',
          `Cloudflare refused the secure connection to ${base.host} (${code}). The storage address doesn’t match an account with R2.`,
          { cause: err },
        )
      }
      throw new CloudError('offline', 'Couldn’t reach the cloud.', { cause: err })
    }
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => '')
      throw new CloudError(
        'auth',
        `The cloud refused the keys (${tag(text, 'Code') ?? res.status}).`,
      )
    }
    return res
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '')
    const code = tag(text, 'Code')
    const message = tag(text, 'Message')
    throw new CloudError(
      res.status >= 500 ? 'offline' : 'other',
      `${what}: ${res.status}${code ? ` ${code}` : ''}${message ? ` (${xmlText(message)})` : ''}`,
    )
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    const res = await this.request('GET', key)
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) return this.fail(res, `Couldn’t download ${key}`)
    const body = new Uint8Array(await res.arrayBuffer())
    return { body, etag: stripQuotes(res.headers.get('etag') ?? '') }
  }

  async put(
    key: string,
    body: Uint8Array,
    condition: PutCondition = {},
  ): Promise<{ etag: string }> {
    const headers: Record<string, string> = {}
    if (condition.ifMatch !== undefined) headers['if-match'] = `"${condition.ifMatch}"`
    if (condition.ifNoneMatch) headers['if-none-match'] = '*'
    const res = await this.request('PUT', key, { body, headers })
    if (res.status === 412 || res.status === 409) {
      await res.body?.cancel()
      throw new PreconditionFailed(key)
    }
    if (!res.ok) return this.fail(res, `Couldn’t upload ${key}`)
    await res.body?.cancel()
    return { etag: stripQuotes(res.headers.get('etag') ?? '') }
  }

  async list(prefix: string): Promise<CloudObject[]> {
    const out: CloudObject[] = []
    let token: string | undefined
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix }
      if (token) query['continuation-token'] = token
      const res = await this.request('GET', null, { query })
      if (!res.ok) return this.fail(res, 'Couldn’t list the cloud')
      const xml = await res.text()
      for (const [, item] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        out.push({
          key: xmlText(tag(item!, 'Key') ?? ''),
          etag: stripQuotes(xmlText(tag(item!, 'ETag') ?? '')),
          size: Number(tag(item!, 'Size') ?? 0),
          lastModified: new Date(tag(item!, 'LastModified') ?? 0),
        })
      }
      token =
        tag(xml, 'IsTruncated') === 'true'
          ? xmlText(tag(xml, 'NextContinuationToken') ?? '')
          : undefined
    } while (token)
    return out
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key)
    if (!res.ok && res.status !== 404) return this.fail(res, `Couldn’t delete ${key}`)
    await res.body?.cancel()
  }
}
