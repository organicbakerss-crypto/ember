/**
 * The phone reader's home-screen icon, drawn here as a PNG (iOS wants a PNG):
 * an open book on the accent colour. No image files to keep in the repo.
 */
import { crc32, deflateSync } from 'node:zlib'

const SIZE = 180

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** The icon as base64 PNG bytes. */
export function iconPng(): string {
  const px = Buffer.alloc(SIZE * SIZE * 4)
  const set = (x: number, y: number, [r, g, b]: number[]) => {
    const i = (y * SIZE + x) * 4
    px[i] = r!
    px[i + 1] = g!
    px[i + 2] = b!
    px[i + 3] = 255
  }
  const bg = [0xb5, 0x53, 0x2e]
  const page = [0xfa, 0xf7, 0xf2]
  const line = [0xd9, 0xc9, 0xb6]
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      set(x, y, bg)
      // Two pages, a little gap down the spine, gently sloping tops.
      const left = x >= 32 && x < 88
      const right = x >= 92 && x < 148
      const lift = left ? Math.round((88 - x) / 8) : right ? Math.round((x - 92) / 8) : 0
      if ((left || right) && y >= 50 - lift && y < 132) {
        set(x, y, page)
        const inner = left ? x - 32 : x - 92
        if (inner > 8 && inner < 48 && y > 62 && y < 124 && (y - 62) % 11 === 0) set(x, y, line)
      }
    }
  }
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return png.toString('base64')
}
