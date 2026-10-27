/**
 * Serves library images (covers) to renderer windows through a custom URL
 * scheme, so windows never need file access of their own.
 */
import fs from 'node:fs'
import { extname } from 'node:path'
import { protocol } from 'electron'
import { MEDIA_SCHEME, mimeForExtension, parseCoverUrl } from '@shared/media'
import { coverTargetSchema } from '@shared/ipc'
import type { LibraryHost } from './libraryHost'

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

export function handleMediaRequests(host: LibraryHost): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const target = coverTargetSchema.safeParse(parseCoverUrl(request.url))
    if (!target.success) return new Response('Not found', { status: 404 })
    try {
      const path = await host.current.getCoverFile(target.data)
      if (!path) return new Response('Not found', { status: 404 })
      const mime = mimeForExtension(extname(path).slice(1)) ?? 'application/octet-stream'
      return new Response(await fs.promises.readFile(path), {
        headers: { 'content-type': mime, 'cache-control': 'max-age=31536000, immutable' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
