/**
 * Map geometry, computed from region outlines only (never from the image):
 * which regions touch (so places know what's nearby), centres for labels and
 * portraits, and which region a point falls in. Pure and local: the same code
 * runs in the app and in tests, and its results are derived data.
 */
import type { MapFile, MapRegion, Point } from '../schema'

/** Regions are compared on a grid this many cells across (the long side). */
const GRID = 400
/**
 * Regions closer than this many grid cells (1.5% of the map) count as touching:
 * detected regions stop short of the border line between them.
 */
const TOUCH = 6

/** Even-odd scanline fill of a region's rings into a label grid. */
function fill(
  labels: Int32Array,
  cols: number,
  rows: number,
  rings: Point[][],
  scale: number,
  label: number,
): void {
  for (let row = 0; row < rows; row++) {
    const y = (row + 0.5) / scale
    const xs: number[] = []
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[i]!
        const [x2, y2] = ring[j]!
        if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1))
      }
    }
    xs.sort((a, b) => a - b)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k]! * scale - 0.5))
      const to = Math.min(cols - 1, Math.floor(xs[k + 1]! * scale - 0.5))
      for (let col = from; col <= to; col++) labels[row * cols + col] = label
    }
  }
}

/** Pairs of region ids whose outlines touch (or nearly touch, across a border line). */
export function regionAdjacency(
  regions: readonly Pick<MapRegion, 'id' | 'rings'>[],
  width: number,
  height: number,
): [string, string][] {
  if (regions.length < 2) return []
  const scale = GRID / Math.max(width, height)
  const cols = Math.max(1, Math.ceil(width * scale))
  const rows = Math.max(1, Math.ceil(height * scale))
  const labels = new Int32Array(cols * rows)
  regions.forEach((r, i) => fill(labels, cols, rows, r.rings, scale, i + 1))
  const pairs = new Set<number>()
  const n = regions.length + 1
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const a = labels[row * cols + col]!
      if (!a) continue
      // Look right and down only; each pair is found from one side.
      for (let dy = 0; dy <= TOUCH; dy++) {
        for (let dx = -TOUCH; dx <= TOUCH; dx++) {
          if (dy === 0 && dx <= 0) continue
          if (dx * dx + dy * dy > TOUCH * TOUCH) continue
          const r = row + dy
          const c = col + dx
          if (r >= rows || c < 0 || c >= cols) continue
          const b = labels[r * cols + c]!
          if (b && b !== a) pairs.add(Math.min(a, b) * n + Math.max(a, b))
        }
      }
    }
  }
  return [...pairs].map((key) => [regions[Math.floor(key / n) - 1]!.id, regions[(key % n) - 1]!.id])
}

/** Places next to each place, from every map's touching regions and the travel sketch's roads. */
export function nearbyPlaces(maps: readonly MapFile[]): Record<string, string[]> {
  const out = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (a === b) return
    out.set(a, (out.get(a) ?? new Set()).add(b))
    out.set(b, (out.get(b) ?? new Set()).add(a))
  }
  for (const map of maps) {
    if (map.image) {
      const byId = new Map(map.regions.map((r) => [r.id, r.placeId]))
      for (const [a, b] of regionAdjacency(map.regions, map.image.width, map.image.height)) {
        const pa = byId.get(a)
        const pb = byId.get(b)
        if (pa && pb) link(pa, pb)
      }
    }
    for (const road of map.sketch?.roads ?? []) link(road.from, road.to)
  }
  return Object.fromEntries([...out].map(([k, v]) => [k, [...v]]))
}

/** Signed area of a ring (positive or negative by winding). */
function ringArea(ring: Point[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
  }
  return a / 2
}

/** A point well inside the region, for its label (the outline's centroid, or the nearest inside point). */
export function labelPoint(region: Pick<MapRegion, 'rings'>): Point {
  const ring = region.rings[0]!
  const area = ringArea(ring)
  let cx = 0
  let cy = 0
  if (Math.abs(area) > 1e-9) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
      cx += (ring[j]![0] + ring[i]![0]) * f
      cy += (ring[j]![1] + ring[i]![1]) * f
    }
    cx /= 6 * area
    cy /= 6 * area
  } else {
    cx = ring.reduce((s, p) => s + p[0], 0) / ring.length
    cy = ring.reduce((s, p) => s + p[1], 0) / ring.length
  }
  if (pointInRegion([cx, cy], region)) return [cx, cy]
  // An odd shape (a crescent): use the middle of the widest run across its middle row.
  const ys = ring.map((p) => p[1])
  const y = (Math.min(...ys) + Math.max(...ys)) / 2
  const xs: number[] = []
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i]!
    const [x2, y2] = ring[j]!
    if (y1 > y !== y2 > y) xs.push(x1 + ((y - y1) * (x2 - x1)) / (y2 - y1))
  }
  xs.sort((a, b) => a - b)
  let best: Point = ring[0]!
  let widest = -1
  for (let k = 0; k + 1 < xs.length; k += 2) {
    if (xs[k + 1]! - xs[k]! > widest) {
      widest = xs[k + 1]! - xs[k]!
      best = [(xs[k]! + xs[k + 1]!) / 2, y]
    }
  }
  return best
}

/** Even-odd test against all rings (so holes are outside). */
export function pointInRegion(point: Point, region: Pick<MapRegion, 'rings'>): boolean {
  const [x, y] = point
  let inside = false
  for (const ring of region.rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[i]!
      const [x2, y2] = ring[j]!
      if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside
    }
  }
  return inside
}

/** SVG path data for a region (rings closed; holes cut out with the even-odd rule). */
export function regionPath(region: Pick<MapRegion, 'rings'>): string {
  return region.rings
    .map((ring) => `M${ring.map(([x, y]) => `${round(x)},${round(y)}`).join('L')}Z`)
    .join('')
}

const round = (n: number) => Math.round(n * 10) / 10

/** The likeliest kind of place for a new region on a map, from what the map shows. */
export function regionTemplate(parentTemplate: string | null): string {
  switch (parentTemplate) {
    case null:
      return 'kingdom'
    case 'continent':
      return 'kingdom'
    case 'kingdom':
      return 'city'
    case 'city':
      return 'district'
    case 'district':
      return 'landmark'
    default:
      return 'landmark'
  }
}
