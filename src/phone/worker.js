/**
 * The phone reader's gatekeeper: a Cloudflare Worker in front of the sync
 * bucket. It's the only thing holding access to the bucket, and it allows
 * only two things: reading chapters, and adding notes. It can't change or
 * delete a chapter or anything else the computers sync.
 *
 * Bindings (set when the computer deploys it):
 *   BUCKET     the sync bucket (R2)
 *   PASS_HASH  hex SHA-256 of "phone-reader:" + the passphrase
 *   APP_NAME   the app's name, for the page title
 *
 * The page itself (READER_HTML below) is put in when it's deployed. Notes are
 * kept under library/phone/notes/, which the computers' sync never touches.
 */

const READER_HTML = '__READER_HTML__'
const ICON_PNG = '__ICON_PNG__'

const UNITS = 'library/units/'
const BLOBS = 'library/blobs/'
const NOTES = 'library/phone/notes/'
const NOTE_ID = /^pn-[a-z0-9-]{6,60}$/
const HASH = /^[0-9a-f]{64}$/
const UNIT = /^series\/[A-Za-z0-9_-]{1,64}(?:\/volumes\/[A-Za-z0-9_-]{1,64})?$/
const ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NOTE_BYTES = 20000

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  })
const problem = (status, message) => json({ error: message }, status)

/** Same length and same bytes, without stopping early. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function readText(object) {
  if (!object) return null
  const stream = object.body.pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).text()
}

async function manifestOf(env, unit) {
  const got = await env.BUCKET.get(`${UNITS}${unit}.json`)
  if (!got) return null
  const m = JSON.parse(await got.text())
  return m && !m.deleted && m.files ? m : null
}

async function fileOf(env, manifest, rel) {
  const hash = manifest.files[rel]?.hash
  if (!hash || !HASH.test(hash)) return null
  const text = await readText(await env.BUCKET.get(`${BLOBS}${hash}`))
  return text === null ? null : JSON.parse(text)
}

/** Stories and their books, in order. */
async function library(env) {
  const keys = []
  let cursor
  do {
    const page = await env.BUCKET.list({ prefix: `${UNITS}series/`, cursor })
    keys.push(...page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  const units = keys
    .filter((k) => k.endsWith('.json'))
    .map((k) => k.slice(UNITS.length, -'.json'.length))
    .filter((u) => UNIT.test(u))
  const stories = []
  for (const unit of units.filter((u) => !u.includes('/volumes/'))) {
    const m = await manifestOf(env, unit)
    const series = m && (await fileOf(env, m, 'series.json'))
    if (!series) continue
    const books = []
    for (const v of units.filter((u) => u.startsWith(`${unit}/volumes/`))) {
      const vm = await manifestOf(env, v)
      const volume = vm && (await fileOf(env, vm, 'volume.json'))
      if (volume) books.push({ unit: v, id: volume.id, name: volume.name })
    }
    const order = Array.isArray(series.volumeOrder) ? series.volumeOrder : []
    books.sort(
      (a, b) =>
        (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9) ||
        a.name.localeCompare(b.name),
    )
    stories.push({ unit, id: series.id, name: series.name, kind: series.kind ?? 'series', books })
  }
  stories.sort((a, b) => a.name.localeCompare(b.name))
  return stories
}

/** A book's chapters in reading order: id and the hash of its file (to fetch and cache). */
async function book(env, unit) {
  const m = await manifestOf(env, unit)
  if (!m) return null
  const outline = await fileOf(env, m, 'outline.json')
  const ids = []
  for (const item of outline?.items ?? []) {
    if (item.type === 'chapter') ids.push(item.id)
    else if (item.type === 'arc') ids.push(...(item.chapterIds ?? []))
  }
  const chapters = []
  for (const id of ids) {
    const hash = m.files[`chapters/${id}.json`]?.hash
    if (ID.test(id) && hash && HASH.test(hash)) chapters.push({ id, hash })
  }
  return { unit, chapters }
}

async function listNotes(env) {
  const out = []
  let cursor
  do {
    const page = await env.BUCKET.list({ prefix: NOTES, cursor })
    for (const o of page.objects) {
      const got = await env.BUCKET.get(o.key)
      if (!got) continue
      try {
        out.push(JSON.parse(await got.text()))
      } catch {
        // A note that can't be read is left where it is.
      }
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

/** A note as the phone may write it: only these fields, plain text, small. */
function cleanNote(id, body, before) {
  const s = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  if (
    !ID.test(body.seriesId ?? '') ||
    !ID.test(body.volumeId ?? '') ||
    !ID.test(body.chapterId ?? '')
  )
    return null
  const text = s(body.text, 8000).trim()
  if (!text) return null
  const now = new Date().toISOString()
  return {
    formatVersion: 1,
    id,
    from: 'iphone',
    seriesId: body.seriesId,
    volumeId: body.volumeId,
    chapterId: body.chapterId,
    chapterTitle: s(body.chapterTitle, 200),
    quote: s(body.quote, 2000),
    /** Which paragraph the quote starts in (to find it again if the words repeat). */
    paragraph: Number.isInteger(body.paragraph) ? body.paragraph : null,
    text,
    createdAt: before?.createdAt ?? now,
    updatedAt: now,
    archivedAt: before?.archivedAt ?? null,
  }
}

const MANIFEST = (name) =>
  JSON.stringify({
    name: `${name} reader`,
    short_name: name,
    start_url: '/',
    display: 'standalone',
    background_color: '#14110f',
    theme_color: '#14110f',
    icons: [{ src: '/icon.png', sizes: '180x180', type: 'image/png' }],
  })

/** Keeps the page itself on the phone so it opens with no signal. */
const SERVICE_WORKER = `
const CACHE = 'reader-shell-v1'
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/icon.png', '/manifest.webmanifest'])))
  self.skipWaiting()
})
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(e.request, copy))
        return res
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/'))),
  )
})
`

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname
    const name = env.APP_NAME || 'Reader'
    const html = (body) =>
      new Response(body, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-cache',
          'x-frame-options': 'DENY',
          'content-security-policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        },
      })

    if (request.method === 'GET' && (path === '/' || path === '/index.html'))
      return html(READER_HTML.replaceAll('__APP_NAME__', name))
    if (path === '/manifest.webmanifest')
      return new Response(MANIFEST(name), {
        headers: { 'content-type': 'application/manifest+json' },
      })
    if (path === '/sw.js')
      return new Response(SERVICE_WORKER, {
        headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' },
      })
    if (path === '/icon.png' || path === '/apple-touch-icon.png') {
      const bytes = Uint8Array.from(atob(ICON_PNG), (c) => c.charCodeAt(0))
      return new Response(bytes, {
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
      })
    }
    if (!path.startsWith('/api/')) return problem(404, 'Not found.')

    // Everything under /api/ needs the passphrase.
    const auth = request.headers.get('authorization') ?? ''
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!env.PASS_HASH || !sameSecret(given, env.PASS_HASH))
      return problem(401, 'Wrong passphrase.')

    try {
      if (path === '/api/check') return json({ ok: true })
      if (path === '/api/library' && request.method === 'GET')
        return json({ stories: await library(env) })
      if (path === '/api/book' && request.method === 'GET') {
        const unit = url.searchParams.get('unit') ?? ''
        if (!UNIT.test(unit) || !unit.includes('/volumes/')) return problem(400, 'No such book.')
        const b = await book(env, unit)
        return b ? json(b) : problem(404, 'No such book.')
      }
      const blob = /^\/api\/chapter\/([0-9a-f]{64})$/.exec(path)
      if (blob && request.method === 'GET') {
        const text = await readText(await env.BUCKET.get(`${BLOBS}${blob[1]}`))
        if (text === null) return problem(404, 'Not found.')
        // Only chapter files, never anything else the computers sync.
        let chapter
        try {
          chapter = JSON.parse(text)
        } catch {
          return problem(404, 'Not found.')
        }
        if (
          !chapter ||
          typeof chapter.id !== 'string' ||
          !chapter.id.startsWith('chp_') ||
          !chapter.content
        )
          return problem(404, 'Not found.')
        return json(
          {
            id: chapter.id,
            title: chapter.title ?? '',
            type: chapter.type ?? 'chapter',
            content: chapter.content,
          },
          200,
          { 'cache-control': 'private, max-age=31536000, immutable' },
        )
      }
      if (path === '/api/notes' && request.method === 'GET')
        return json({ notes: await listNotes(env) })
      const note = /^\/api\/notes\/([^/]+)$/.exec(path)
      if (note) {
        const id = note[1]
        if (!NOTE_ID.test(id)) return problem(400, 'Bad note.')
        const key = `${NOTES}${id}.json`
        if (request.method === 'PUT') {
          const raw = await request.text()
          if (raw.length > MAX_NOTE_BYTES) return problem(413, 'That note is too long.')
          let body
          try {
            body = JSON.parse(raw)
          } catch {
            return problem(400, 'Bad note.')
          }
          const there = await env.BUCKET.get(key)
          const before = there ? JSON.parse(await there.text()) : null
          const clean = cleanNote(id, body ?? {}, before)
          if (!clean) return problem(400, 'Bad note.')
          await env.BUCKET.put(key, JSON.stringify(clean), {
            httpMetadata: { contentType: 'application/json' },
          })
          return json(clean)
        }
        if (request.method === 'DELETE') {
          await env.BUCKET.delete(key)
          return json({ ok: true })
        }
      }
      return problem(404, 'Not found.')
    } catch (err) {
      return problem(500, `Something went wrong: ${err && err.message ? err.message : String(err)}`)
    }
  },
}
