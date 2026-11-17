import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Library } from '../library/library'
import { MemoryCloud } from '../sync/memoryCloud'
import { SyncEngine } from '../sync/engine'
import worker from '../../phone/worker.js'
import { deployReader, passHash, readerScript, READER_NAME } from './deploy'
import { NOTES_PREFIX, PhoneNotes } from './notes'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.promises.rm(d, { recursive: true, force: true })
})

const doc = (...ps: string[]) => ({
  type: 'doc' as const,
  content: ps.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})

/** Cloudflare's R2 binding, over the same in-memory bucket sync uses. */
function r2(cloud: MemoryCloud) {
  const object = (body: Uint8Array) => ({
    body: new Blob([body]).stream(),
    text: async () => new TextDecoder().decode(body),
  })
  return {
    async get(key: string) {
      const got = await cloud.get(key)
      return got ? object(got.body) : null
    },
    async list({ prefix }: { prefix: string; cursor?: string }) {
      return { objects: (await cloud.list(prefix)).map((o) => ({ key: o.key })), truncated: false }
    },
    async put(key: string, value: string) {
      await cloud.put(key, new TextEncoder().encode(value))
    },
    async delete(key: string) {
      await cloud.delete(key)
    },
  }
}

const PASS = 'a long passphrase'

/** A real library, synced to the bucket the way the app does it. */
async function synced() {
  const dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'phone-'))
  dirs.push(dir)
  const lib = await Library.open(join(dir, 'lib'), { create: true })
  const series = await lib.createSeries({ name: 'Saga', world: { mode: 'new', name: 'Isles' } })
  const volume = await lib.createVolume({ seriesId: series.id, name: 'Book One' })
  const first = await lib.createChapter({
    seriesId: series.id,
    volumeId: volume.id,
    title: 'Arrival',
  })
  await lib.saveChapter(series.id, volume.id, first.id, {
    content: doc('Mara ran to the harbour.'),
  })
  const second = await lib.createChapter({
    seriesId: series.id,
    volumeId: volume.id,
    title: 'Tide',
  })
  await lib.saveChapter(series.id, volume.id, second.id, { content: doc('The tide turned.') })
  const cloud = new MemoryCloud()
  const engine = new SyncEngine({
    root: lib.root,
    stateDir: join(lib.paths.localDir, 'sync'),
    cloud,
    device: 'Mac',
    hooks: {
      lock: (unit, task) => lib.lockUnit(unit, task),
      borrow: async () => () => {},
      beforeReplace: (unit, rel) => lib.keepBeforeSync(unit, rel),
      trashFile: (unit, rel) => lib.trashSyncedFile(unit, rel),
      trashUnit: (unit) => lib.trashSyncedUnit(unit),
      changed: (unit, rels, unitChanged) => void lib.syncedChanges(unit, rels, unitChanged),
      notice: () => {},
    },
  })
  await engine.cycle()
  const env = { BUCKET: r2(cloud), PASS_HASH: passHash(PASS), APP_NAME: 'Reader' }
  const call = (path: string, init: RequestInit & { key?: string } = {}) =>
    worker.fetch(
      new Request(`https://reader.example.workers.dev${path}`, {
        ...init,
        headers: { authorization: `Bearer ${init.key ?? passHash(PASS)}`, ...(init.headers ?? {}) },
      }),
      env,
    )
  return { lib, cloud, engine, series, volume, first, second, call }
}

describe('the phone reader’s gatekeeper', () => {
  it('lets nothing through without the passphrase', async () => {
    const { call } = await synced()
    expect((await call('/api/library', { key: 'nope' })).status).toBe(401)
    expect((await call('/api/library', { key: passHash('a long passphras') })).status).toBe(401)
    expect((await call('/api/check')).status).toBe(200)
  })

  it('reads stories, books and chapters from what the computers synced, in reading order', async () => {
    const { call, series, volume, first, second } = await synced()
    const lib = (await (await call('/api/library')).json()) as {
      stories: { name: string; id: string; books: { name: string; unit: string }[] }[]
    }
    expect(lib.stories.map((s) => s.name)).toEqual(['Saga'])
    expect(lib.stories[0]!.id).toBe(series.id)
    expect(lib.stories[0]!.books.map((b) => b.name)).toEqual(['Book One'])
    const unit = lib.stories[0]!.books[0]!.unit
    expect(unit).toBe(`series/${series.id}/volumes/${volume.id}`)
    const book = (await (await call(`/api/book?unit=${encodeURIComponent(unit)}`)).json()) as {
      chapters: { id: string; hash: string }[]
    }
    expect(book.chapters.map((c) => c.id)).toEqual([first.id, second.id])
    const ch = (await (await call(`/api/chapter/${book.chapters[0]!.hash}`)).json()) as {
      title: string
      content: unknown
    }
    expect(ch.title).toBe('Arrival')
    expect(JSON.stringify(ch.content)).toContain('Mara ran to the harbour.')
  })

  it('serves only chapters, never other synced files, and never changes a chapter', async () => {
    const { call, cloud } = await synced()
    const manifests = [...cloud.objects.keys()].filter((k) => k.startsWith('library/units/series/'))
    const seriesManifest = JSON.parse(
      new TextDecoder().decode(
        cloud.objects.get(manifests.find((k) => !k.includes('/volumes/'))!)!.body,
      ),
    ) as { files: Record<string, { hash: string }> }
    // series.json is a real blob, but not a chapter.
    expect((await call(`/api/chapter/${seriesManifest.files['series.json']!.hash}`)).status).toBe(
      404,
    )
    // Nothing outside notes can be written or deleted.
    const before = new Map(cloud.objects)
    expect((await call('/api/book?unit=series%2Fx', { method: 'PUT' })).status).toBe(404)
    expect((await call('/api/notes/../units', { method: 'DELETE' })).status).toBe(404)
    expect((await call('/api/notes/pn-bad%2F..', { method: 'DELETE' })).status).toBe(400)
    for (const [k, v] of before) expect(cloud.objects.get(k)?.etag).toBe(v.etag)
  })

  it('keeps notes from the phone; the computer ticks them off, and archived ones go after 3 days', async () => {
    const { call, cloud, engine, series, volume, first } = await synced()
    const put = await call('/api/notes/pn-abc123-x', {
      method: 'PUT',
      body: JSON.stringify({
        seriesId: series.id,
        volumeId: volume.id,
        chapterId: first.id,
        chapterTitle: 'Arrival',
        quote: 'ran to the harbour',
        paragraph: 0,
        text: 'Make this slower.',
        archivedAt: '2020-01-01T00:00:00.000Z', // the phone can't archive
        extra: 'dropped',
      }),
    })
    expect(put.status).toBe(200)
    const saved = (await put.json()) as Record<string, unknown>
    expect(saved['from']).toBe('iphone')
    expect(saved['archivedAt']).toBeNull()
    expect(saved['extra']).toBeUndefined()
    expect([...cloud.objects.keys()]).toContain(`${NOTES_PREFIX}pn-abc123-x.json`)
    // An empty note, or one for no chapter, is refused.
    const bad = await call('/api/notes/pn-abc124-x', {
      method: 'PUT',
      body: JSON.stringify({
        seriesId: series.id,
        volumeId: volume.id,
        chapterId: first.id,
        text: ' ',
      }),
    })
    expect(bad.status).toBe(400)

    // Sync carries on as before with notes in the bucket, and leaves them alone.
    await engine.cycle()
    expect([...cloud.objects.keys()]).toContain(`${NOTES_PREFIX}pn-abc123-x.json`)

    const notes = new PhoneNotes(() => cloud)
    const [note] = await notes.list()
    expect(note).toMatchObject({
      text: 'Make this slower.',
      quote: 'ran to the harbour',
      archivedAt: null,
    })
    const done = await notes.archive('pn-abc123-x', true)
    expect(done.archivedAt).not.toBeNull()
    // The phone sees it ticked off, and editing it there doesn't undo that.
    const seen = (await (await call('/api/notes')).json()) as {
      notes: { archivedAt: string | null }[]
    }
    expect(seen.notes[0]!.archivedAt).toBe(done.archivedAt)
    await call('/api/notes/pn-abc123-x', {
      method: 'PUT',
      body: JSON.stringify({
        seriesId: series.id,
        volumeId: volume.id,
        chapterId: first.id,
        text: 'Edited',
      }),
    })
    expect((await notes.list())[0]!.archivedAt).toBe(done.archivedAt)
    // Put back, then ticked again: still there within 3 days, gone after.
    expect((await notes.archive('pn-abc123-x', false)).archivedAt).toBeNull()
    await notes.archive('pn-abc123-x', true)
    expect(await notes.list(Date.now() + 2 * 86400000)).toHaveLength(1)
    expect(await notes.list(Date.now() + 4 * 86400000)).toHaveLength(0)
    expect([...cloud.objects.keys()]).not.toContain(`${NOTES_PREFIX}pn-abc123-x.json`)
  })

  it('leaves a note it can’t read where it is', async () => {
    const { cloud } = await synced()
    await cloud.put(`${NOTES_PREFIX}pn-broken-1.json`, new TextEncoder().encode('{ not json'))
    expect(await new PhoneNotes(() => cloud).list()).toEqual([])
    expect([...cloud.objects.keys()]).toContain(`${NOTES_PREFIX}pn-broken-1.json`)
  })
})

describe('putting the phone reader on Cloudflare', () => {
  /** A pretend Cloudflare API, recording what was asked. */
  function api(over: Record<string, (body: unknown) => unknown> = {}) {
    const calls: { method: string; path: string; body: unknown }[] = []
    const ok = (result: unknown) => ({ success: true, result })
    const routes: Record<string, (body: unknown) => unknown> = {
      'GET /accounts': () => ok([{ id: 'acc1', name: 'Me' }]),
      'GET /accounts/acc1/r2/buckets': () => ok({ buckets: [{ name: 'lib-bucket' }] }),
      [`PUT /accounts/acc1/workers/scripts/${READER_NAME}`]: () => ok({}),
      'GET /accounts/acc1/workers/subdomain': () => ok({ subdomain: 'me123' }),
      [`POST /accounts/acc1/workers/scripts/${READER_NAME}/subdomain`]: () => ok({}),
      ...over,
    }
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const path = url.replace('https://api.test', '')
      const body =
        init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : null
      calls.push({ method: init.method ?? 'GET', path, body })
      const route = routes[`${init.method} ${path}`]
      return new Response(
        JSON.stringify(
          route ? route(body) : { success: false, errors: [{ code: 404, message: 'no' }] },
        ),
      )
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  it('uploads the gatekeeper with the page inside, bound to the sync bucket, and gives its address', async () => {
    const { calls, fetchImpl } = api()
    const r = await deployReader({
      token: 'tok-1234567890',
      bucket: 'lib-bucket',
      passphrase: PASS,
      fetchImpl,
      api: 'https://api.test',
    })
    expect(r.url).toBe(`https://${READER_NAME}.me123.workers.dev`)
    const upload = calls.find((c) => c.method === 'PUT')!.body as FormData
    const metadata = JSON.parse(await (upload.get('metadata') as Blob).text()) as {
      bindings: { type: string; name: string; bucket_name?: string; text?: string }[]
    }
    expect(metadata.bindings).toContainEqual({
      type: 'r2_bucket',
      name: 'BUCKET',
      bucket_name: 'lib-bucket',
    })
    const secret = metadata.bindings.find((b) => b.name === 'PASS_HASH')!
    expect(secret.type).toBe('secret_text')
    expect(secret.text).toBe(passHash(PASS))
    expect(JSON.stringify(metadata)).not.toContain(PASS)
    const script = await (upload.get('worker.js') as Blob).text()
    expect(script).toContain('<!doctype html>')
    expect(script).not.toContain('__READER_HTML__')
    expect(script).not.toContain('__ICON_PNG__')
  })

  it('says when the token can’t set up Workers, and refuses a short passphrase', async () => {
    const { fetchImpl } = api({
      [`PUT /accounts/acc1/workers/scripts/${READER_NAME}`]: () => ({
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      }),
    })
    await expect(
      deployReader({
        token: 'tok-1234567890',
        bucket: 'lib-bucket',
        passphrase: PASS,
        fetchImpl,
        api: 'https://api.test',
      }),
    ).rejects.toThrow(/can’t set up Workers/)
    await expect(
      deployReader({
        token: 'tok-1234567890',
        bucket: 'lib-bucket',
        passphrase: 'short',
        fetchImpl,
        api: 'https://api.test',
      }),
    ).rejects.toThrow(/at least 8/)
  })

  it('the built script is a module that still answers', async () => {
    const script = readerScript()
    const file = join(await fs.promises.mkdtemp(join(os.tmpdir(), 'reader-')), 'worker.mjs')
    dirs.push(join(file, '..'))
    await fs.promises.writeFile(file, script)
    const built = (await import(file)) as { default: typeof worker }
    const res = await built.default.fetch(new Request('https://x.workers.dev/'), {
      APP_NAME: 'Reader',
    })
    const html = await res.text()
    expect(html).toContain('<title>Reader</title>')
    const icon = await built.default.fetch(new Request('https://x.workers.dev/icon.png'), {})
    expect(new Uint8Array(await icon.arrayBuffer()).slice(1, 4)).toEqual(
      new TextEncoder().encode('PNG'),
    )
  })
})
