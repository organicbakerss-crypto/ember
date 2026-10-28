/**
 * Serves library images (covers and world portraits) to renderer windows through a custom URL
 * scheme, so windows never need file access of their own.
 */
import fs from 'node:fs'
import { extname } from 'node:path'
import { protocol } from 'electron'
import { MEDIA_SCHEME, mimeForExtension, parseCoverUrl, parseWorldImageUrl } from '@shared/media'
import { isId } from '@shared/ids'
import { coverTargetSchema } from '@shared/ipc'
import type { LibraryHost } from './libraryHost'

/** Must run before the app is ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ])
}

export function handleMediaRequests(host: LibraryHost): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const image = parseWorldImageUrl(request.url)
    if (image) {
      if (!isId('world', image.worldId)) return new Response('Not found', { status: 404 })
      try {
        const path = host.current.world.imagePath(image.worldId, image.file)
        const mime = mimeForExtension(extname(path).slice(1)) ?? 'application/octet-stream'
        // Readable by the page's canvas (region detection needs the pixels).
        return new Response(await fs.promises.readFile(path), {
          headers: {
            'content-type': mime,
            'cache-control': 'max-age=31536000, immutable',
            'access-control-allow-origin': '*',
          },
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    }
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
