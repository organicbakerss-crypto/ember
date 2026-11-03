import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryCloud } from './memoryCloud'
import { BUCKET_NAME, setupFromToken, tokenPageUrl } from './cloudflare'

const TOKEN = 'tok_value_abcdefghijklmnopqrstuvwxyz'

/** A pretend Cloudflare API: one account, some buckets. */
function fakeApi(opts: { buckets?: string[]; r2Off?: boolean; badToken?: boolean } = {}) {
  const buckets = new Set(opts.buckets ?? [])
  const calls: string[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.test', '')
    calls.push(`${init.method} ${path}`)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (
      (init.headers as Record<string, string>).authorization !== `Bearer ${TOKEN}` ||
      opts.badToken
    ) {
      return json({ success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] }, 401)
    }
    if (path === '/accounts') return json({ success: true, result: [{ id: 'acc1', name: 'Me' }] })
    if (path === '/user/tokens/verify')
      return json({ success: true, result: { id: 'tokid', status: 'active' } })
    if (path === '/accounts/acc1/r2/buckets' && opts.r2Off) {
      return json(
        {
          success: false,
          errors: [{ code: 10042, message: 'Please enable R2 through the Cloudflare Dashboard.' }],
        },
        403,
      )
    }
    if (path === '/accounts/acc1/r2/buckets' && init.method === 'GET') {
      return json({ success: true, result: { buckets: [...buckets].map((name) => ({ name })) } })
    }
    if (path === '/accounts/acc1/r2/buckets' && init.method === 'POST') {
      buckets.add((JSON.parse(String(init.body)) as { name: string }).name)
      return json({ success: true, result: {} })
    }
    return json({ success: false, errors: [{ code: 7003, message: 'no route' }] }, 404)
  }) as unknown as typeof fetch
  return { fetchImpl, buckets, calls }
}

describe('setting up from one Cloudflare token', () => {
  it('makes its own bucket and works out the storage keys from the token', async () => {
    const api = fakeApi({ buckets: ['old-app-stuff'] })
    const setup = await setupFromToken(TOKEN, { fetchImpl: api.fetchImpl, api: 'https://api.test' })
    expect(setup).toEqual({
      endpoint: 'https://acc1.r2.cloudflarestorage.com',
      bucket: BUCKET_NAME,
      accessKeyId: 'tokid',
      secretAccessKey: createHash('sha256').update(TOKEN).digest('hex'),
    })
    expect([...api.buckets].sort()).toEqual([BUCKET_NAME, 'old-app-stuff'])
  })

  it('finds the same bucket from the second computer, but never one holding other things', async () => {
    const ours = new MemoryCloud()
    await ours.put('library/units/worlds/w.json', new Uint8Array([1]))
    let api = fakeApi({ buckets: [BUCKET_NAME] })
    const setup = await setupFromToken(TOKEN, {
      fetchImpl: api.fetchImpl,
      api: 'https://api.test',
      makeCloud: () => ours,
    })
    expect(setup.bucket).toBe(BUCKET_NAME)
    expect(api.calls.some((c) => c.startsWith('POST'))).toBe(false)

    const foreign = new MemoryCloud()
    await foreign.put('something-else.json', new Uint8Array([1]))
    api = fakeApi({ buckets: [BUCKET_NAME] })
    const other = await setupFromToken(TOKEN, {
      fetchImpl: api.fetchImpl,
      api: 'https://api.test',
      makeCloud: () => foreign,
    })
    expect(other.bucket).toBe(`${BUCKET_NAME}-2`)
  })

  it('explains a wrong token and R2 not turned on', async () => {
    await expect(
      setupFromToken(TOKEN, {
        fetchImpl: fakeApi({ badToken: true }).fetchImpl,
        api: 'https://api.test',
      }),
    ).rejects.toThrow(/didn’t accept that token/)
    await expect(
      setupFromToken(TOKEN, {
        fetchImpl: fakeApi({ r2Off: true }).fetchImpl,
        api: 'https://api.test',
      }),
    ).rejects.toThrow(/isn’t turned on/)
  })

  it('links to the token page with the permission filled in', () => {
    const url = new URL(tokenPageUrl())
    expect(url.hostname).toBe('dash.cloudflare.com')
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys')!)).toEqual([
      { key: 'workers_r2', type: 'edit' },
    ])
  })
})
