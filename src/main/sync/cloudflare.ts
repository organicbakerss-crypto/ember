/**
 * Setting up from one Cloudflare API token: the app finds the account,
 * makes its own bucket (or finds it again on the next computer) and works
 * out the storage keys from the token. The writer only creates the token.
 *
 * An API token with R2 permission is also an S3 key pair: the key id is the
 * token's id, and the secret is the SHA-256 of the token's value.
 */
import { createHash } from 'node:crypto'
import { appConfig } from '../../../app.config'
import { AppError } from '../errors'
import type { CloudStore } from './cloud'
import { S3Cloud } from './s3'

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4'

/** The bucket this app makes for itself (never one made by anything else). */
export const BUCKET_NAME = `${appConfig.urlScheme}-library`

export interface TokenSetup {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

interface ApiResponse<T> {
  success: boolean
  errors?: { code: number; message: string }[]
  result: T
}

export async function setupFromToken(
  token: string,
  options: {
    fetchImpl?: typeof fetch
    api?: string
    /** The S3 endpoint for an account (tests point it elsewhere). */
    endpointFor?: (accountId: string) => string
    makeCloud?: (setup: TokenSetup) => CloudStore
  } = {},
): Promise<TokenSetup> {
  const fetchImpl = options.fetchImpl ?? fetch
  const api = options.api ?? CLOUDFLARE_API
  const call = async <T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> => {
    let res: Response
    try {
      res = await fetchImpl(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new AppError('invalid-input', 'Couldn’t reach Cloudflare. Check your connection.', {
        cause: err,
      })
    }
    const data = (await res.json().catch(() => null)) as ApiResponse<T> | null
    return (
      data ?? {
        success: false,
        errors: [{ code: res.status, message: res.statusText }],
        result: null as T,
      }
    )
  }
  const problem = (r: ApiResponse<unknown>) =>
    r.errors?.map((e) => e.message).join('; ') || 'unknown error'

  const accounts = await call<{ id: string; name: string }[]>('GET', '/accounts')
  if (!accounts.success) {
    throw new AppError(
      'invalid-input',
      `Cloudflare didn’t accept that token (${problem(accounts)}). Copy the whole token value again.`,
    )
  }
  if (!accounts.result?.length) {
    throw new AppError('invalid-input', 'That token can’t see any Cloudflare account.')
  }

  // The token's id (its S3 key id). User tokens and account tokens check in different places.
  let tokenId: string | null = null
  const user = await call<{ id: string; status: string }>('GET', '/user/tokens/verify')
  if (user.success) tokenId = user.result.id
  for (const a of accounts.result) {
    if (tokenId) break
    const r = await call<{ id: string }>('GET', `/accounts/${a.id}/tokens/verify`)
    if (r.success) tokenId = r.result.id
  }
  if (!tokenId) throw new AppError('invalid-input', 'Cloudflare couldn’t confirm that token.')
  const accessKeyId = tokenId
  const secretAccessKey = createHash('sha256').update(token).digest('hex')

  // Find this app's bucket (the next computer finds the one the first made), or make it.
  let lastProblem = ''
  for (const account of accounts.result) {
    const listed = await call<{ buckets: { name: string }[] }>(
      'GET',
      `/accounts/${account.id}/r2/buckets`,
    )
    if (!listed.success) {
      lastProblem = problem(listed)
      continue
    }
    const endpoint =
      options.endpointFor?.(account.id) ?? `https://${account.id}.r2.cloudflarestorage.com`
    const names = new Set(listed.result.buckets.map((b) => b.name))
    for (const bucket of [BUCKET_NAME, `${BUCKET_NAME}-2`, `${BUCKET_NAME}-3`]) {
      const setup = { endpoint, bucket, accessKeyId, secretAccessKey }
      if (names.has(bucket)) {
        // Only use it if it holds nothing but this app's library.
        const cloud = options.makeCloud?.(setup) ?? new S3Cloud(setup)
        let objects
        try {
          objects = await cloud.list('')
        } catch (err) {
          throw new AppError(
            'invalid-input',
            `Found the storage bucket “${bucket}” in “${account.name}”, but couldn’t open it: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        if (objects.every((o) => o.key.startsWith('library/'))) return setup
        continue
      }
      const made = await call('POST', `/accounts/${account.id}/r2/buckets`, { name: bucket })
      if (!made.success) {
        throw new AppError('invalid-input', `Couldn’t make the storage bucket: ${problem(made)}`)
      }
      return setup
    }
  }
  throw new AppError(
    'invalid-input',
    /enable|purchase|subscri/i.test(lastProblem)
      ? 'R2 storage isn’t turned on in this Cloudflare account yet. In Cloudflare, open R2 Object Storage and turn it on, then connect again.'
      : `That token can’t use R2 storage (${lastProblem || 'no access'}). Make it with the “Open Cloudflare” button, which picks the right permission.`,
  )
}

/** Cloudflare's token page, filled in with the one permission sync needs. */
export function tokenPageUrl(): string {
  const permissions = encodeURIComponent(JSON.stringify([{ key: 'workers_r2', type: 'edit' }]))
  const name = encodeURIComponent(`${appConfig.name} sync`)
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${permissions}&name=${name}&accountId=*&zoneId=all`
}
