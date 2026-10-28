/**
 * Region detection on map images, locally with OpenCV.js (no AI, no
 * internet). Works on a pixel copy of the image at a working size; outlines
 * come back in that copy's pixels and the caller scales them to the image.
 *
 * - detectAll: every area enclosed by border lines (best on clean, flat-colour maps).
 * - magicWand: the area around a point, within a colour tolerance.
 * - mergeOutlines / splitOutline: fix-up tools for regions already found.
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

/** Areas smaller than this share of the image are ignored (letters, specks). */
const MIN_AREA = 0.0006
/** Holes smaller than this share of their region are filled in (lettering, symbols). */
const MIN_HOLE = 0.02
/** Outlines are simplified to within this many pixels. */
const SIMPLIFY = 1.2

/**
 * Turns the loaded OpenCV module into a ready `cv`. The module object is
 * "thenable", so it is always passed around wrapped: awaiting it (or a
 * promise resolving to it) would never finish.
 */
let loading: Promise<{ cv: CV }> | null = null
export function loadOpenCv(load: () => Promise<{ module: unknown }>): Promise<{ cv: CV }> {
  loading ??= load().then(async ({ module }) => {
    const mod = ((module as { default?: unknown }).default ?? module) as CV
    if (mod instanceof Promise) return { cv: (await mod) as CV }
    if (!(mod as { Mat?: unknown }).Mat) {
      await new Promise<void>((resolve) => {
        ;(mod as unknown as { onRuntimeInitialized: () => void }).onRuntimeInitialized = resolve
      })
    }
    return { cv: mod }
  })
  return loading
}

function toMat(cv: CV, px: Pixels): OpenCV.Mat {
  const mat = new cv.Mat(px.height, px.width, cv.CV_8UC4)
  mat.data.set(px.data)
  return mat
}

/** Outlines of white areas in a binary mask, simplified, with holes. */
function outlines(cv: CV, mask: OpenCV.Mat, minArea: number): Rings[] {
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
    for (let child = h[i * 4 + 2]!; child !== -1; child = h[child * 4]!) {
      if (cv.contourArea(contours.get(child)) >= minHole) rings.push(ring(child))
    }
    if (rings[0]!.length >= 3) out.push({ area, rings: rings.filter((r) => r.length >= 3) })
  }
  contours.delete()
  hierarchy.delete()
  return out.sort((a, b) => b.area - a.area).map((o) => o.rings)
}

/**
 * Every area enclosed by border lines. Lines are found as edges between
 * colours (and dark ink), slightly thickened to close small gaps. Areas over
 * half the image (usually the background) are left out.
 */
export function detectAll(cv: CV, px: Pixels): Rings[] {
  const src = toMat(cv, px)
  const gray = new cv.Mat()
  const edges = new cv.Mat()
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0)
    cv.Canny(gray, edges, 30, 90)
    cv.dilate(edges, edges, kernel)
    cv.bitwise_not(edges, edges)
    const total = px.width * px.height
    return outlines(cv, edges, total * MIN_AREA).filter(
      (rings) => Math.abs(polygonArea(rings[0]!)) < total * 0.5,
    )
  } finally {
    src.delete()
    gray.delete()
    edges.delete()
    kernel.delete()
  }
}

/** The area around a point whose colour is within `tolerance` (0–100) of the colour there. */
export function magicWand(cv: CV, px: Pixels, point: Point, tolerance: number): Rings | null {
  const src = toMat(cv, px)
  const rgb = new cv.Mat()
  const mask = cv.Mat.zeros(px.height + 2, px.width + 2, cv.CV_8U)
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U)
  try {
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB)
    const t = Math.round((Math.max(0, Math.min(100, tolerance)) / 100) * 255)
    const diff = new cv.Scalar(t, t, t, 0)
    const flags = 4 | cv.FLOODFILL_MASK_ONLY | cv.FLOODFILL_FIXED_RANGE | (255 << 8)
    const seed = new cv.Point(
      Math.max(0, Math.min(px.width - 1, Math.round(point[0]))),
      Math.max(0, Math.min(px.height - 1, Math.round(point[1]))),
    )
    cv.floodFill(rgb, mask, seed, new cv.Scalar(0, 0, 0, 0), new cv.Rect(), diff, diff, flags)
    const inner = mask.roi(new cv.Rect(1, 1, px.width, px.height))
    // Close pinholes left by anti-aliasing and lettering.
    cv.morphologyEx(inner, inner, cv.MORPH_CLOSE, kernel)
    const found = outlines(cv, inner, 9)
    inner.delete()
    return found[0] ?? null
  } finally {
    src.delete()
    rgb.delete()
    mask.delete()
    kernel.delete()
  }
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
    for (let i = 1; i < line.length; i++) {
      const [x1, y1] = line[i - 1]!
      const [x2, y2] = line[i]!
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
