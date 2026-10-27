import { describe, expect, it } from 'vitest'
import { coverUrl, detectImageType, parseCoverUrl, type CoverTarget } from './media'

describe('cover URLs', () => {
  it('round-trips every target kind', () => {
    const targets: CoverTarget[] = [
      { kind: 'series', seriesId: 'ser_a' },
      { kind: 'volume', seriesId: 'ser_a', volumeId: 'vol_b' },
      { kind: 'world', worldId: 'wld_c' },
    ]
    for (const target of targets) {
      expect(parseCoverUrl(coverUrl(target, { version: 'x y' }))).toEqual(target)
    }
  })

  it('rejects anything else', () => {
    expect(parseCoverUrl('library-media://cover/series/a/b')).toBeNull()
    expect(parseCoverUrl('library-media://other/series/a')).toBeNull()
    expect(parseCoverUrl('file:///etc/passwd')).toBeNull()
    expect(parseCoverUrl('not a url')).toBeNull()
  })
})

describe('detectImageType', () => {
  it('recognises images by their bytes', () => {
    expect(detectImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))?.ext).toBe('png')
    expect(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xdb]))?.ext).toBe('jpg')
    const webp = new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')
    expect(detectImageType(webp)?.ext).toBe('webp')
    expect(detectImageType(new TextEncoder().encode('<svg xmlns'))).toBeNull()
  })
})
