/**
 * Cover images. Kept free of runtime dependencies so the renderer can import
 * it without pulling in the schema library.
 */

/** What a cover belongs to. Covers live inside that item's folder. */
export type CoverTarget =
  | { kind: 'series'; seriesId: string }
  | { kind: 'volume'; seriesId: string; volumeId: string }
  | { kind: 'world'; worldId: string }

/** A cover image on disk. `version` changes whenever the image does (for cache busting). */
export interface CoverInfo {
  version: string
}

/** Largest cover image accepted. */
export const MAX_COVER_BYTES = 20 * 1024 * 1024

/** Largest map image accepted (maps can be big). */
export const MAX_MAP_BYTES = 60 * 1024 * 1024

/** Custom URL scheme the renderer uses to load library images. */
export const MEDIA_SCHEME = 'library-media'

/** e.g. `library-media://cover/volume/<series-id>/<volume-id>?v=<version>` */
export function coverUrl(target: CoverTarget, cover: CoverInfo): string {
  const path =
    target.kind === 'series'
      ? `series/${target.seriesId}`
      : target.kind === 'volume'
        ? `volume/${target.seriesId}/${target.volumeId}`
        : `world/${target.worldId}`
  return `${MEDIA_SCHEME}://cover/${path}?v=${encodeURIComponent(cover.version)}`
}

/** The reverse of `coverUrl`. Returns null for anything that isn't a cover URL. */
export function parseCoverUrl(url: string): CoverTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.host !== 'cover') return null
  const [kind, a, b, ...rest] = parsed.pathname.split('/').filter(Boolean)
  if (rest.length) return null
  if (kind === 'series' && a && !b) return { kind, seriesId: a }
  if (kind === 'volume' && a && b) return { kind, seriesId: a, volumeId: b }
  if (kind === 'world' && a && !b) return { kind, worldId: a }
  return null
}

const SIGNATURES: { ext: string; mime: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: 'png', mime: 'image/png', test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { ext: 'gif', mime: 'image/gif', test: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  {
    ext: 'webp',
    mime: 'image/webp',
    test: (b) =>
      startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  },
]

/** Identifies an image by its first bytes, not by its file name. */
export function detectImageType(bytes: Uint8Array): { ext: string; mime: string } | null {
  const match = SIGNATURES.find((s) => s.test(bytes))
  return match ? { ext: match.ext, mime: match.mime } : null
}

export const COVER_EXTENSIONS = SIGNATURES.map((s) => s.ext)

export function mimeForExtension(ext: string): string | null {
  return SIGNATURES.find((s) => s.ext === ext)?.mime ?? null
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, i) => bytes[i] === value)
}

/** World images (portraits) are stored once per world, named by content hash. */
export const WORLD_IMAGE = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/

/** e.g. `library-media://world-image/<world-id>/<hash>.png` (never changes, so cached forever). */
export function worldImageUrl(worldId: string, file: string): string {
  return `${MEDIA_SCHEME}://world-image/${worldId}/${file}`
}

export function parseWorldImageUrl(url: string): { worldId: string; file: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${MEDIA_SCHEME}:` || parsed.host !== 'world-image') return null
  const [worldId, file, ...rest] = parsed.pathname.split('/').filter(Boolean)
  if (rest.length || !worldId || !file || !WORLD_IMAGE.test(file)) return null
  return { worldId, file }
}
