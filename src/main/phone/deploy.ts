/**
 * Putting the phone reader on the writer's Cloudflare account: one Worker
 * (the gatekeeper, with the reading page inside it) bound to the sync
 * bucket, at <name>.<account>.workers.dev. It needs a Cloudflare token that
 * may edit Workers (the sync token only reaches storage); the token is used
 * kept on this computer (see reader.ts). The passphrase is only ever stored as a hash.
 */
import { createHash } from 'node:crypto'
import { appConfig } from '../../../app.config'
import { AppError } from '../errors'
import { CLOUDFLARE_API } from '../sync/cloudflare'
import workerJs from '../../phone/worker.js?raw'
import readerHtml from '../../phone/reader.html?raw'
import { iconPng } from './icon'

/** The Worker's name (and so the start of its address). */
export const READER_NAME = `${appConfig.urlScheme}-reader`
const SALT = 'phone-reader:'
export const MIN_PASSPHRASE = 8

/** What the phone sends instead of the passphrase (the Worker keeps only this). */
export const passHash = (passphrase: string) =>
  createHash('sha256')
    .update(SALT + passphrase)
    .digest('hex')

interface ThemeFile {
  id: string
  name: string
  appearance: 'light' | 'dark'
  colors: Record<string, string>
}
const themeFiles = import.meta.glob<ThemeFile>('../../renderer/src/themes/*.json', {
  eager: true,
  import: 'default',
})

/** The app's themes for the phone: colours only (no skin words, fonts or decorations). */
export function phoneThemes(): {
  id: string
  name: string
  appearance: string
  colors: Record<string, string>
}[] {
  return Object.values(themeFiles)
    .filter((t) => t?.id && t.colors)
    .sort((a, b) =>
      a.appearance === b.appearance
        ? a.name.localeCompare(b.name)
        : a.appearance === 'light'
          ? -1
          : 1,
    )
    .map((t) => {
      const c = t.colors
      return {
        id: t.id,
        name: t.name,
        appearance: t.appearance,
        colors: {
          bg: c['page'] ?? c['bg']!,
          bar: c['bg']!,
          text: c['page-text'] ?? c['text']!,
          muted: c['muted']!,
          line: c['border']!,
          accent: c['accent']!,
          'accent-text': c['accent-text'] ?? '#fff',
          card: c['surface'] ?? c['bg']!,
        },
      }
    })
}

/** The Worker's code with the page and icon inside it. */
export function readerScript(): string {
  const page = readerHtml.replace(`'__THEMES__'`, JSON.stringify(phoneThemes()))
  if (page.includes('__THEMES__')) throw new Error('The phone reader’s themes didn’t go in.')
  const script = workerJs
    .replace(`'__READER_HTML__'`, JSON.stringify(page))
    .replace(`'__ICON_PNG__'`, JSON.stringify(iconPng()))
  if (script.includes('__READER_HTML__') || script.includes('__ICON_PNG__'))
    throw new Error('The phone reader’s page didn’t go in.')
  return script
}

/** Cloudflare's token page, filled in with what the phone reader needs. */
export function readerTokenPageUrl(): string {
  const permissions = encodeURIComponent(
    JSON.stringify([
      { key: 'workers_scripts', type: 'edit' },
      { key: 'workers_r2', type: 'edit' },
    ]),
  )
  const name = encodeURIComponent(`${appConfig.name} phone reader`)
  return `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${permissions}&name=${name}&accountId=*&zoneId=all`
}

interface ApiResponse<T> {
  success: boolean
  errors?: { code: number; message: string }[]
  result: T
}

export async function deployReader(input: {
  token: string
  bucket: string
  /** The sign-in phrase's hash (passHash). */
  passHash: string
  /** The script to upload (readerScript()). */
  script?: string
  fetchImpl?: typeof fetch
  api?: string
}): Promise<{ url: string }> {
  if (!/^[0-9a-f]{64}$/.test(input.passHash)) throw new Error('No sign-in phrase.')
  const fetchImpl = input.fetchImpl ?? fetch
  const api = input.api ?? CLOUDFLARE_API
  const call = async <T>(
    method: string,
    path: string,
    body?: unknown,
    form?: FormData,
  ): Promise<ApiResponse<T>> => {
    let res: Response
    try {
      res = await fetchImpl(`${api}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${input.token.trim()}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: form ?? (body ? JSON.stringify(body) : undefined),
        signal: AbortSignal.timeout(60_000),
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
  const noPermission = (r: ApiResponse<unknown>) =>
    r.errors?.some((e) => e.code === 10000 || /auth|permission/i.test(e.message)) ?? false
  const tokenHelp =
    'That token can’t set up Workers. Make one with “Open Cloudflare” here (it picks Workers and R2), then paste it.'

  const accounts = await call<{ id: string; name: string }[]>('GET', '/accounts')
  if (!accounts.success || !accounts.result?.length)
    throw new AppError(
      'invalid-input',
      `Cloudflare didn’t accept that token (${problem(accounts)}). Copy the whole token value again.`,
    )
  // The account that holds the sync bucket.
  let accountId: string | null = null
  for (const a of accounts.result) {
    const listed = await call<{ buckets: { name: string }[] }>(
      'GET',
      `/accounts/${a.id}/r2/buckets`,
    )
    if (listed.success && listed.result.buckets.some((b) => b.name === input.bucket)) {
      accountId = a.id
      break
    }
  }
  if (!accountId)
    throw new AppError(
      'invalid-input',
      `That token can’t see your sync storage (“${input.bucket}”). Make it in the same Cloudflare account, with “Open Cloudflare” here.`,
    )

  const metadata = {
    main_module: 'worker.js',
    compatibility_date: '2025-01-01',
    bindings: [
      { type: 'r2_bucket', name: 'BUCKET', bucket_name: input.bucket },
      { type: 'secret_text', name: 'PASS_HASH', text: input.passHash },
      { type: 'plain_text', name: 'APP_NAME', text: appConfig.name },
    ],
  }
  const form = new FormData()
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
  form.append(
    'worker.js',
    new Blob([input.script ?? readerScript()], { type: 'application/javascript+module' }),
    'worker.js',
  )
  const put = await call(
    'PUT',
    `/accounts/${accountId}/workers/scripts/${READER_NAME}`,
    undefined,
    form,
  )
  if (!put.success)
    throw new AppError(
      'invalid-input',
      noPermission(put) ? tokenHelp : `Cloudflare didn’t take the phone reader: ${problem(put)}`,
    )

  // The account's workers.dev name (made the first time, if there's none yet).
  let sub = await call<{ subdomain: string }>('GET', `/accounts/${accountId}/workers/subdomain`)
  if (!sub.success || !sub.result?.subdomain) {
    const name = `${appConfig.urlScheme}-${Math.random().toString(36).slice(2, 8)}`
    sub = await call<{ subdomain: string }>('PUT', `/accounts/${accountId}/workers/subdomain`, {
      subdomain: name,
    })
    if (!sub.success)
      throw new AppError(
        'invalid-input',
        `Couldn’t give your account a workers.dev address: ${problem(sub)}. In Cloudflare, open Workers & Pages once (it sets one up), then try again.`,
      )
  }
  const on = await call('POST', `/accounts/${accountId}/workers/scripts/${READER_NAME}/subdomain`, {
    enabled: true,
    previews_enabled: false,
  })
  if (!on.success)
    throw new AppError(
      'invalid-input',
      `Couldn’t turn the phone reader’s address on: ${problem(on)}`,
    )
  return { url: `https://${READER_NAME}.${sub.result.subdomain}.workers.dev` }
}
