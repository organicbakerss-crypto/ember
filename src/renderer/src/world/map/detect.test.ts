import { beforeAll, describe, expect, it } from 'vitest'
import { pointInRegion } from '@shared/world/maps'
import {
  detectAll,
  loadOpenCv,
  magicWand,
  mergeOutlines,
  polygonArea,
  splitOutline,
  type CV,
  type Pixels,
} from './detect'

/** A 400 × 200 map: a 4px black frame, two black border lines, three flat colours and a letter. */
function testMap(): Pixels {
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
      const i = (y * width + x) * 4
      const border =
        x < 4 ||
        x >= width - 4 ||
        y < 4 ||
        y >= height - 4 ||
        (x >= 130 && x < 134) ||
        (x >= 270 && x < 274)
      const letter = x >= 60 && x < 64 && y >= 90 && y < 110 // a small dark mark, like lettering
      const c = border || letter ? [20, 20, 20] : colours[x < 132 ? 0 : x < 272 ? 1 : 2]!
      data.set([c[0]!, c[1]!, c[2]!, 255], i)
    }
  }
  return { data, width, height }
}

interface NodeProcess {
  getBuiltinModule(name: 'node:module'): {
    createRequire(url: string): (id: string) => unknown
  }
}

let cv: CV
beforeAll(async () => {
  // Loaded with require: the test runner would otherwise try to transform the 11 MB file.
  // (Reached through `process` because this folder is typed for the window, not Node.)
  const node = (globalThis as unknown as { process: NodeProcess }).process
  const require = node.getBuiltinModule('node:module').createRequire(import.meta.url)
  cv = (await loadOpenCv(async () => ({ module: require('@techstark/opencv-js') }))).cv
}, 60000)

describe('region detection', () => {
  it('auto-detect finds every area enclosed by border lines', () => {
    const regions = detectAll(cv, testMap())
    expect(regions).toHaveLength(3)
    const inside = (p: [number, number]) =>
      regions.findIndex((rings) => pointInRegion(p, { rings }))
    expect(new Set([inside([60, 40]), inside([200, 100]), inside([340, 100])]).size).toBe(3)
    // Lettering doesn't become a region of its own, or a hole in one.
    for (const rings of regions) {
      expect(Math.abs(polygonArea(rings[0]!))).toBeGreaterThan(5000)
      expect(rings).toHaveLength(1)
    }
  })

  it('the magic wand fills just the area clicked, within the tolerance', () => {
    const region = magicWand(cv, testMap(), [200, 100], 10)!
    expect(pointInRegion([200, 100], { rings: region })).toBe(true)
    expect(pointInRegion([60, 40], { rings: region })).toBe(false)
    const area = Math.abs(polygonArea(region[0]!))
    expect(area).toBeGreaterThan(130 * 190)
    expect(area).toBeLessThan(140 * 200)
  })

  it('merges neighbouring regions across their border, and splits one along a line', () => {
    const [left, middle] = [
      magicWand(cv, testMap(), [60, 40], 10)!,
      magicWand(cv, testMap(), [200, 100], 10)!,
    ]
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
