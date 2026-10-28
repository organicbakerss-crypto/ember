import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pointInRegion } from '@shared/world/maps'
import {
  detect,
  loadOpenCv,
  magicWand,
  mergeOutlines,
  polygonArea,
  prepare,
  splitOutline,
  type CV,
  type Pixels,
  type Prepared,
} from './detect'

/** A 400 × 200 political map: a 4px black frame, two black border lines, three flat colours and a letter. */
function politicalMap(): Pixels {
  const width = 400
  const height = 200
  const data = new Uint8ClampedArray(width * height * 4)
  const colours = [
    [200, 220, 160],
    [230, 200, 150],
    [170, 200, 230],
  ]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const border =
        x < 4 ||
        x >= width - 4 ||
        y < 4 ||
        y >= height - 4 ||
        (x >= 130 && x < 134) ||
        (x >= 270 && x < 274)
      const letter = x >= 60 && x < 64 && y >= 90 && y < 110 // a small dark mark, like lettering
      const c = border || letter ? [20, 20, 20] : colours[x < 132 ? 0 : x < 272 ? 1 : 2]!
      data.set([c[0]!, c[1]!, c[2]!, 255], (y * width + x) * 4)
    }
  }
  return { data, width, height }
}

/**
 * A 480 × 320 painted map: textured sea with a grid, two textured islands of
 * different colours, a white label box in the sea and a paper frame.
 */
function paintedMap(): Pixels {
  const width = 480
  const height = 320
  const data = new Uint8ClampedArray(width * height * 4)
  let seed = 7
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff - 0.5) * 50
  }
  const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c: number[]
      const frame = x < 12 || x >= width - 12 || y < 12 || y >= height - 12
      if (frame) c = [235, 225, 200]
      else if (inEllipse(x, y, 140, 160, 90, 110)) c = [120 + noise(), 150 + noise(), 70 + noise()]
      else if (inEllipse(x, y, 350, 150, 80, 70)) c = [160 + noise(), 110 + noise(), 70 + noise()]
      else if (x >= 300 && x < 340 && y >= 260 && y < 276)
        c = [245, 245, 240] // a label
      else if (x % 40 === 0 || y % 40 === 0)
        c = [30, 50, 60] // grid lines
      else c = [20 + noise() / 3, 80 + noise() / 2, 110 + noise() / 2]
      data.set([...c.map((v) => Math.max(0, Math.min(255, v))), 255], (y * width + x) * 4)
    }
  }
  return { data, width, height }
}

let cv: CV
let political: Prepared
let painted: Prepared
beforeAll(async () => {
  // Loaded with require: the test runner would otherwise try to transform the 11 MB file.
  // (Reached through `process` because this folder is typed for the window, not Node.)
  const node = (globalThis as unknown as { process: NodeProcess }).process
  const require = node.getBuiltinModule('node:module').createRequire(import.meta.url)
  cv = (await loadOpenCv(async () => ({ module: require('@techstark/opencv-js') }))).cv
  political = prepare(cv, politicalMap())
  painted = prepare(cv, paintedMap())
}, 60000)
afterAll(() => {
  political?.delete()
  painted?.delete()
})

interface NodeProcess {
  getBuiltinModule(name: 'node:module'): {
    createRequire(url: string): (id: string) => unknown
  }
}

const inside = (regions: Point2[][][], p: [number, number]) =>
  regions.findIndex((rings) => pointInRegion(p, { rings }))
type Point2 = [number, number]

describe('detecting regions', () => {
  it('finds every area enclosed by border lines on a political map (auto picks borders)', () => {
    const { method, regions } = detect(cv, political, 'auto')
    expect(method).toBe('borders')
    expect(regions).toHaveLength(3)
    expect(
      new Set([inside(regions, [60, 40]), inside(regions, [200, 100]), inside(regions, [340, 100])])
        .size,
    ).toBe(3)
    for (const rings of regions) {
      // Lettering doesn't become a region of its own, or a hole in one.
      expect(Math.abs(polygonArea(rings[0]!))).toBeGreaterThan(5000)
      expect(rings).toHaveLength(1)
    }
  })

  it('finds each landmass on a painted map, ignoring texture, grid lines, labels and the frame', () => {
    const { method, regions } = detect(cv, painted, 'auto')
    expect(method).toBe('landSea')
    expect(regions).toHaveLength(2)
    expect(inside(regions, [140, 160])).not.toBe(-1)
    expect(inside(regions, [350, 150])).not.toBe(-1)
    expect(inside(regions, [320, 268])).toBe(-1) // the label box
    expect(inside(regions, [240, 40])).toBe(-1) // the sea
  })

  it('uses a clicked point as the sea when asked', () => {
    const { regions } = detect(cv, painted, 'landSea', [240, 300])
    expect(regions).toHaveLength(2)
  })

  it('finds areas of one colour', () => {
    const { regions } = detect(cv, painted, 'colours')
    expect(inside(regions, [140, 160])).not.toBe(-1)
    expect(inside(regions, [350, 150])).not.toBe(-1)
    expect(inside(regions, [140, 160])).not.toBe(inside(regions, [350, 150]))
  })
})

describe('the magic wand', () => {
  it('fills just the area clicked, within the tolerance', () => {
    const region = magicWand(cv, political, [200, 100], 10)!
    expect(pointInRegion([200, 100], { rings: region })).toBe(true)
    expect(pointInRegion([60, 40], { rings: region })).toBe(false)
    const area = Math.abs(polygonArea(region[0]!))
    expect(area).toBeGreaterThan(130 * 190)
    expect(area).toBeLessThan(140 * 200)
  })

  it('fills a textured island without leaking into the sea', () => {
    const island = magicWand(cv, painted, [140, 160], 15)!
    expect(pointInRegion([140, 160], { rings: island })).toBe(true)
    expect(pointInRegion([140, 90], { rings: island })).toBe(true)
    expect(pointInRegion([240, 40], { rings: island })).toBe(false)
    expect(pointInRegion([350, 150], { rings: island })).toBe(false)
  })

  it('adds to and cuts from a shape', () => {
    const left = magicWand(cv, political, [60, 40], 10)!
    const both = magicWand(cv, political, [200, 100], 10, { rings: left, mode: 'add' })!
    expect(pointInRegion([60, 40], { rings: both })).toBe(true)
    expect(pointInRegion([200, 100], { rings: both })).toBe(true)
    const cut = magicWand(cv, political, [60, 40], 10, { rings: left, mode: 'subtract' })
    expect(cut).toBeNull()
  })
})

describe('fix-up tools', () => {
  it('merges neighbouring regions across their border, and splits one along a line', () => {
    const left = magicWand(cv, political, [60, 40], 10)!
    const middle = magicWand(cv, political, [200, 100], 10)!
    const merged = mergeOutlines(cv, [left, middle], 400, 200)!
    expect(pointInRegion([60, 40], { rings: merged })).toBe(true)
    expect(pointInRegion([200, 100], { rings: merged })).toBe(true)
    expect(pointInRegion([132, 100], { rings: merged })).toBe(true)

    const pieces = splitOutline(
      cv,
      middle,
      [
        [200, 0],
        [200, 200],
      ],
      400,
      200,
    )!
    expect(pieces).toHaveLength(2)
    expect(pieces.some((rings) => pointInRegion([160, 100], { rings }))).toBe(true)
    expect(pieces.some((rings) => pointInRegion([240, 100], { rings }))).toBe(true)
    expect(
      splitOutline(
        cv,
        middle,
        [
          [10, 10],
          [20, 20],
        ],
        400,
        200,
      ),
    ).toBeNull()
  })
})
