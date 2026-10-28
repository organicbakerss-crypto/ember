/**
 * Region detection on map images, locally with OpenCV.js (no AI, no
 * internet). Works on a pixel copy of the image at a working size; outlines
 * come back in that copy's pixels and the caller scales them to the image.
 *
 * Every tool works on a smoothed copy first: paint texture, brush strokes and
 * noise are flattened while real edges (coastlines, borders) are kept.
 *
 * Detection methods:
 * - borders: areas enclosed by drawn border lines (political maps);
 * - landSea: each landmass, separated by sea (painted maps); the sea's colour
 *   is found automatically, or taken from a point clicked in the sea;
 * - colours: areas of one colour (countries coloured without border lines);
 * - auto: borders when that gives a clean result, else land and sea, else colours.
 *
 * Fix-up tools: magicWand (add to / cut from a shape), mergeOutlines, splitOutline.
 */
import type * as OpenCV from '@techstark/opencv-js'
import type { Point } from '@shared/schema'

export type CV = typeof OpenCV

/** RGBA pixels, like ImageData. */
export interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** One region: its outline, then any holes. */
export type Rings = Point[][]

export type Method = 'borders' | 'landSea' | 'colours'

/** Areas smaller than this share of the image are ignored (letters, specks). */
const MIN_AREA = 0.0006
/** Landmasses and colour areas smaller than this share of the image are ignored. */
const MIN_LAND = 0.003
/** Holes smaller than this share of their region are filled in (lettering, symbols). */
const MIN_HOLE = 0.02
/** Outlines are simplified to within this many pixels. */
const SIMPLIFY = 1.2
/** Most regions one detection may return (the largest are kept). */
const MAX_REGIONS = 200

/**
 * Turns the loaded OpenCV module into a ready `cv`. The module object is
 * "thenable", so it is always passed around wrapped: awaiting it (or a
 * promise resolving to it) would never finish.
 */
let loading: Promise<{ cv: CV }> | null = null
export function loadOpenCv(load: () => Promise<{ module: unknown }>): Promise<{ cv: CV }> {
  loading ??= load().then(async ({ module }) => {
    const mod = ((module as { default?: unknown }).default ?? module) as CV
    if (mod instanceof Promise) {
      const ready = await (mod as Promise<unknown>).then((cv) => ({ cv: cv as CV }))
      return ready
    }
    if (!(mod as { Mat?: unknown }).Mat) {
      await new Promise<void>((resolve) => {
        ;(mod as unknown as { onRuntimeInitialized: () => void }).onRuntimeInitialized = resolve
      })
    }
    return { cv: mod }
  })
  return loading
}

/** An image ready for detection: its size and a smoothed RGB copy. Delete when done. */
export interface Prepared {
  width: number
  height: number
  smooth: OpenCV.Mat
  delete(): void
}

const odd = (n: number) => Math.max(3, Math.round(n) | 1)

/** Flattens texture and noise, keeping edges (median, then two edge-preserving passes). */
export function prepare(cv: CV, px: Pixels): Prepared {
  const src = new cv.Mat(px.height, px.width, cv.CV_8UC4)
  src.data.set(px.data)
  const rgb = new cv.Mat()
  const median = new cv.Mat()
  const pass = new cv.Mat()
  const smooth = new cv.Mat()
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB)
    cv.medianBlur(rgb, median, odd(Math.max(px.width, px.height) / 300))
    cv.bilateralFilter(median, pass, 9, 60, 60)
    cv.bilateralFilter(pass, smooth, 9, 60, 60)
  } finally {
    src.delete()
    rgb.delete()
    median.delete()
    pass.delete()
  }
  return { width: px.width, height: px.height, smooth, delete: () => smooth.delete() }
}

/** Outlines of white areas in a binary mask, simplified, with holes (largest first). */
function outlines(cv: CV, mask: OpenCV.Mat, minArea: number, keepHoles = true): Rings[] {
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  cv.findContours(mask, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_SIMPLE)
  const h = hierarchy.data32S
  const ring = (i: number): Point[] => {
    const approx = new cv.Mat()
    cv.approxPolyDP(contours.get(i), approx, SIMPLIFY, true)
    const pts: Point[] = []
    for (let k = 0; k < approx.data32S.length; k += 2) {
      pts.push([approx.data32S[k]!, approx.data32S[k + 1]!])
    }
    approx.delete()
    return pts
  }
  const out: { area: number; rings: Rings }[] = []
  for (let i = 0; i < contours.size(); i++) {
    if (h[i * 4 + 3] !== -1) continue // a hole; collected with its outline
    const area = cv.contourArea(contours.get(i))
    if (area < minArea) continue
    const rings: Rings = [ring(i)]
    // Holes count only when they're a real feature (a lake), not lettering or specks.
    const minHole = Math.max(minArea, area * MIN_HOLE)
    for (let child = keepHoles ? h[i * 4 + 2]! : -1; child !== -1; child = h[child * 4]!) {
      if (cv.contourArea(contours.get(child)) >= minHole) rings.push(ring(child))
    }
    if (rings[0]!.length >= 3) out.push({ area, rings: rings.filter((r) => r.length >= 3) })
  }
  contours.delete()
  hierarchy.delete()
  return out.sort((a, b) => b.area - a.area).map((o) => o.rings)
}

const imageArea = (p: { width: number; height: number }) => p.width * p.height

/** Drops the frame-sized outline (usually the paper or the background) and small label boxes. */
function tidy(found: Rings[], p: Prepared, labelBoxes: boolean): Rings[] {
  const total = imageArea(p)
  return found
    .filter((rings) => {
      const area = Math.abs(polygonArea(rings[0]!))
      if (area >= total * 0.5) return false
      return !(labelBoxes && area < total * 0.03 && rectangularity(rings[0]!) > 0.8)
    })
    .slice(0, MAX_REGIONS)
}

/** Areas enclosed by border lines: edges between colours and dark ink, slightly thickened. */
function detectBorders(cv: CV, p: Prepared): Rings[] {
  const gray = new cv.Mat()
  const edges = new cv.Mat()
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
  try {
    cv.cvtColor(p.smooth, gray, cv.COLOR_RGB2GRAY)
    cv.Canny(gray, edges, 30, 90)
    cv.dilate(edges, edges, kernel)
    cv.bitwise_not(edges, edges)
    return tidy(outlines(cv, edges, imageArea(p) * MIN_AREA), p, false)
  } finally {
    gray.delete()
    edges.delete()
    kernel.delete()
  }
}

/** Groups the image's colours (k-means on a small copy), then labels every pixel. */
function colourClusters(
  cv: CV,
  p: Prepared,
  k: number,
): { labels: Int32Array; centres: number[][]; share: number[] } {
  const scale = Math.min(1, 500 / Math.max(p.width, p.height))
  const small = new cv.Mat()
  cv.resize(
    p.smooth,
    small,
    new cv.Size(
      Math.max(1, Math.round(p.width * scale)),
      Math.max(1, Math.round(p.height * scale)),
    ),
    0,
    0,
    cv.INTER_AREA,
  )
  const n = small.rows * small.cols
  const samples = new cv.Mat(n, 3, cv.CV_32F)
  for (let i = 0; i < n * 3; i++) samples.data32F[i] = small.data[i]!
  const sampleLabels = new cv.Mat()
  const centresMat = new cv.Mat()
  try {
    cv.kmeans(
      samples,
      k,
      sampleLabels,
      new cv.TermCriteria(cv.TermCriteria_EPS + cv.TermCriteria_MAX_ITER, 12, 1),
      2,
      // (Missing from the type definitions, present at run time.)
      (cv as unknown as { KMEANS_PP_CENTERS: number }).KMEANS_PP_CENTERS,
      centresMat,
    )
    const centres = Array.from({ length: k }, (_, i) =>
      [0, 1, 2].map((c) => centresMat.data32F[i * 3 + c]!),
    )
    // Every full-size pixel goes to its nearest colour group.
    const data = p.smooth.data
    const total = p.width * p.height
    const labels = new Int32Array(total)
    const share = new Array<number>(k).fill(0)
    for (let i = 0; i < total; i++) {
      const r = data[i * 3]!
      const g = data[i * 3 + 1]!
      const b = data[i * 3 + 2]!
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const ctr = centres[c]!
        const d = (r - ctr[0]!) ** 2 + (g - ctr[1]!) ** 2 + (b - ctr[2]!) ** 2
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      labels[i] = best
      share[best]!++
    }
    return { labels, centres, share: share.map((s) => s / total) }
  } finally {
    small.delete()
    samples.delete()
    sampleLabels.delete()
    centresMat.delete()
  }
}

/** Sets rows and columns at the image's edges that are mostly "land" to sea: the map's frame. */
function clearFrame(mask: Uint8Array, width: number, height: number): void {
  const row = (y: number) => {
    let s = 0
    for (let x = 0; x < width; x++) s += mask[y * width + x] ? 1 : 0
    return s / width
  }
  const col = (x: number) => {
    let s = 0
    for (let y = 0; y < height; y++) s += mask[y * width + x] ? 1 : 0
    return s / height
  }
  let top = 0
  while (top < height * 0.15 && row(top) > 0.6) top++
  let bottom = height - 1
  while (bottom > height * 0.85 && row(bottom) > 0.6) bottom--
  let left = 0
  while (left < width * 0.15 && col(left) > 0.6) left++
  let right = width - 1
  while (right > width * 0.85 && col(right) > 0.6) right--
  const pad = Math.round(Math.max(width, height) * 0.004)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (y < top + pad || y > bottom - pad || x < left + pad || x > right - pad)
        mask[y * width + x] = 0
    }
  }
}

/**
 * Each landmass, separated by sea. The sea is the colour group(s) at a
 * clicked point, or else the blue ones. Grid lines, labels and the frame are
 * cleaned away; thin bridges between landmasses are cut.
 */
function detectLandSea(cv: CV, p: Prepared, seaPoint?: Point): Rings[] | null {
  const { labels, centres, share } = colourClusters(cv, p, 6)
  let sea: number[]
  if (seaPoint) {
    const x = Math.max(0, Math.min(p.width - 1, Math.round(seaPoint[0])))
    const y = Math.max(0, Math.min(p.height - 1, Math.round(seaPoint[1])))
    const picked = centres[labels[y * p.width + x]!]!
    sea = centres
      .map((c, i) => ({
        i,
        d: Math.hypot(c[0]! - picked[0]!, c[1]! - picked[1]!, c[2]! - picked[2]!),
      }))
      .filter((c) => c.d < 45)
      .map((c) => c.i)
  } else {
    sea = centres
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c[2]! > c[0]! + 20)
      .map((x) => x.i)
  }
  if (sea.reduce((s, i) => s + share[i]!, 0) < 0.1) return null
  const mask = new cv.Mat(p.height, p.width, cv.CV_8U)
  const big = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(odd(Math.max(p.width, p.height) * 0.02), odd(Math.max(p.width, p.height) * 0.02)),
  )
  const small = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5))
  try {
    const seaSet = new Set(sea)
    for (let i = 0; i < labels.length; i++) mask.data[i] = seaSet.has(labels[i]!) ? 0 : 255
    clearFrame(mask.data, p.width, p.height)
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, big) // grid lines, labels, thin bridges
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, small)
    // A lake (or a dark mountain range read as sea) still belongs to its land: no holes.
    return tidy(outlines(cv, mask, imageArea(p) * MIN_LAND, false), p, true)
  } finally {
    mask.delete()
    big.delete()
    small.delete()
  }
}

/** Areas of one colour (countries painted in different colours, without lines). */
function detectColours(cv: CV, p: Prepared): Rings[] {
  const { labels, share } = colourClusters(cv, p, 8)
  const mask = new cv.Mat(p.height, p.width, cv.CV_8U)
  const open = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(odd(Math.max(p.width, p.height) * 0.01), odd(Math.max(p.width, p.height) * 0.01)),
  )
  const found: Rings[] = []
  try {
    share.forEach((s, k) => {
      if (s < MIN_LAND) return
      for (let i = 0; i < labels.length; i++) mask.data[i] = labels[i] === k ? 255 : 0
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, open)
      found.push(...outlines(cv, mask, imageArea(p) * MIN_LAND))
    })
  } finally {
    mask.delete()
    open.delete()
  }
  found.sort((a, b) => Math.abs(polygonArea(b[0]!)) - Math.abs(polygonArea(a[0]!)))
  return tidy(found, p, true)
}

/** A detection is clean when it finds a handful of areas that cover most of the map. */
function clean(found: Rings[], p: Prepared): boolean {
  const covered = found.reduce((s, r) => s + Math.abs(polygonArea(r[0]!)), 0) / imageArea(p)
  return found.length >= 2 && found.length <= 40 && covered >= 0.45
}

/** Finds regions with a method, or picks one ("auto"). Says which method was used. */
export function detect(
  cv: CV,
  p: Prepared,
  method: Method | 'auto',
  seaPoint?: Point,
): { method: Method; regions: Rings[] } {
  if (method === 'borders') return { method, regions: detectBorders(cv, p) }
  if (method === 'colours') return { method, regions: detectColours(cv, p) }
  if (method === 'landSea') return { method, regions: detectLandSea(cv, p, seaPoint) ?? [] }
  const borders = detectBorders(cv, p)
  if (clean(borders, p)) return { method: 'borders', regions: borders }
  const land = detectLandSea(cv, p)
  if (land?.length) return { method: 'landSea', regions: land }
  return { method: 'colours', regions: detectColours(cv, p) }
}

function fillRings(cv: CV, mask: OpenCV.Mat, rings: Rings, value: number) {
  rings.forEach((ring, i) => {
    const pts = cv.matFromArray(
      ring.length,
      1,
      cv.CV_32SC2,
      ring.flatMap(([x, y]) => [Math.round(x), Math.round(y)]),
    )
    const vec = new cv.MatVector()
    vec.push_back(pts)
    // The outline fills; holes cut back out.
    cv.fillPoly(mask, vec, new cv.Scalar(i === 0 ? value : 255 - value))
    vec.delete()
    pts.delete()
  })
}

/** Keeps only the white area containing a point. */
function keepAt(cv: CV, mask: OpenCV.Mat, point: Point): void {
  const fill = cv.Mat.zeros(mask.rows + 2, mask.cols + 2, cv.CV_8U)
  const seed = new cv.Point(Math.round(point[0]), Math.round(point[1]))
  try {
    if (!mask.ucharAt(seed.y, seed.x)) return
    cv.floodFill(
      mask,
      fill,
      seed,
      new cv.Scalar(255),
      new cv.Rect(),
      new cv.Scalar(0),
      new cv.Scalar(0),
      4 | cv.FLOODFILL_MASK_ONLY | (255 << 8),
    )
    const inner = fill.roi(new cv.Rect(1, 1, mask.cols, mask.rows))
    inner.copyTo(mask)
    inner.delete()
  } finally {
    fill.delete()
  }
}

/**
 * The area around a point whose colour is within `tolerance` (0–100) of the
 * colour there, on the smoothed image. It only grows outwards from the point;
 * narrow leaks into neighbouring areas are cut and small holes filled. With
 * `base`, the result is added to or cut from that shape.
 */
export function magicWand(
  cv: CV,
  p: Prepared,
  point: Point,
  tolerance: number,
  base?: { rings: Rings; mode: 'add' | 'subtract' },
): Rings | null {
  const mask = cv.Mat.zeros(p.height + 2, p.width + 2, cv.CV_8U)
  const close = cv.Mat.ones(3, 3, cv.CV_8U)
  const cut = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(odd(Math.max(p.width, p.height) * 0.006), odd(Math.max(p.width, p.height) * 0.006)),
  )
  const seed: Point = [
    Math.max(0, Math.min(p.width - 1, Math.round(point[0]))),
    Math.max(0, Math.min(p.height - 1, Math.round(point[1]))),
  ]
  let area: OpenCV.Mat | null = null
  let shape: OpenCV.Mat | null = null
  try {
    const t = Math.round((Math.max(0, Math.min(100, tolerance)) / 100) * 255)
    const diff = new cv.Scalar(t, t, t, 0)
    const flags = 4 | cv.FLOODFILL_MASK_ONLY | cv.FLOODFILL_FIXED_RANGE | (255 << 8)
    const smooth = p.smooth.clone()
    cv.floodFill(
      smooth,
      mask,
      new cv.Point(seed[0], seed[1]),
      new cv.Scalar(0, 0, 0, 0),
      new cv.Rect(),
      diff,
      diff,
      flags,
    )
    smooth.delete()
    area = mask.roi(new cv.Rect(1, 1, p.width, p.height)).clone()
    // Cut narrow leaks, then keep only the part that was clicked.
    const opened = new cv.Mat()
    cv.morphologyEx(area, opened, cv.MORPH_OPEN, cut)
    if (opened.ucharAt(seed[1], seed[0])) opened.copyTo(area)
    opened.delete()
    keepAt(cv, area, seed)
    cv.morphologyEx(area, area, cv.MORPH_CLOSE, close)
    if (base) {
      shape = cv.Mat.zeros(p.height, p.width, cv.CV_8U)
      fillRings(cv, shape, base.rings, 255)
      if (base.mode === 'add') {
        cv.bitwise_or(shape, area, shape)
        // Bridge a thin border line between the shape and the new area, as Merge does.
        const bridge = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9))
        cv.morphologyEx(shape, shape, cv.MORPH_CLOSE, bridge)
        bridge.delete()
      } else {
        cv.bitwise_not(area, area)
        cv.bitwise_and(shape, area, shape)
      }
      // Slivers left by a cut (under 1% of the shape) count as nothing.
      const minArea = Math.max(9, Math.abs(polygonArea(base.rings[0]!)) * 0.01)
      return outlines(cv, shape, minArea)[0] ?? null
    }
    return outlines(cv, area, 9)[0] ?? null
  } finally {
    mask.delete()
    close.delete()
    cut.delete()
    area?.delete()
    shape?.delete()
  }
}

/**
 * Joins regions into one, bridging the border lines between them (up to
 * `gap` pixels wide).
 */
export function mergeOutlines(
  cv: CV,
  regions: Rings[],
  width: number,
  height: number,
  gap = 9,
): Rings | null {
  const mask = cv.Mat.zeros(height, width, cv.CV_8U)
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(gap, gap))
  try {
    for (const rings of regions) fillRings(cv, mask, rings, 255)
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel)
    return outlines(cv, mask, 9)[0] ?? null
  } finally {
    mask.delete()
    kernel.delete()
  }
}

/** Cuts a region along a drawn line. Returns the pieces (largest first), or null if it didn't cut. */
export function splitOutline(
  cv: CV,
  rings: Rings,
  line: Point[],
  width: number,
  height: number,
): Rings[] | null {
  const mask = cv.Mat.zeros(height, width, cv.CV_8U)
  try {
    fillRings(cv, mask, rings, 255)
    // A cut drawn edge to edge usually stops just short of the edges: carry both ends on a little.
    const reach = Math.max(width, height) * 0.03
    const extend = (from: Point, to: Point): Point => {
      const len = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1
      return [to[0] + ((to[0] - from[0]) / len) * reach, to[1] + ((to[1] - from[1]) / len) * reach]
    }
    const cut: Point[] =
      line.length >= 2
        ? [extend(line[1]!, line[0]!), ...line.slice(1, -1), extend(line.at(-2)!, line.at(-1)!)]
        : line
    for (let i = 1; i < cut.length; i++) {
      const [x1, y1] = cut[i - 1]!
      const [x2, y2] = cut[i]!
      cv.line(
        mask,
        new cv.Point(Math.round(x1), Math.round(y1)),
        new cv.Point(Math.round(x2), Math.round(y2)),
        new cv.Scalar(0),
        3,
      )
    }
    const pieces = outlines(cv, mask, Math.max(9, Math.abs(polygonArea(rings[0]!)) * 0.01))
    return pieces.length >= 2 ? pieces : null
  } finally {
    mask.delete()
  }
}

export function polygonArea(ring: Point[]): number {
  let a = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1]
  }
  return a / 2
}

/** How rectangular an outline is: its area over its bounding box's (1 for an upright box). */
function rectangularity(ring: Point[]): number {
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  const box = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
  return box > 0 ? Math.abs(polygonArea(ring)) / box : 0
}
