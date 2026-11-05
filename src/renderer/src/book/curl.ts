/**
 * The geometry of a page curl. Coordinates are relative to the spine (x = 0)
 * and the top of the page; a forward turn lifts the right page (x 0…W), a
 * backward one the left page (x −W…0). The corner held is pulled to the
 * pointer; the fold is the line halfway between them, at right angles. The
 * part of the page beyond the fold is lifted and shown from its back (the
 * next page), reflected across the fold.
 */
export interface Pt {
  x: number
  y: number
}

/** The part of a polygon on the side of a line where (p − m)·n ≥ 0. */
function clipHalf(poly: Pt[], m: Pt, n: Pt, keep: 1 | -1): Pt[] {
  const side = (p: Pt) => keep * ((p.x - m.x) * n.x + (p.y - m.y) * n.y)
  const out: Pt[] = []
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length]!
    const sa = side(a)
    const sb = side(b)
    if (sa >= 0) out.push(a)
    if (sa >= 0 !== sb >= 0) {
      const t = sa / (sa - sb)
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  })
  return out
}

/** Keeps the pulled corner where a page fixed at the spine could reach. */
export function reachable(p: Pt, corner: Pt, w: number, h: number): Pt {
  let q = { ...p }
  // The spine end of the held edge stays put: the corner is at most a page width from it.
  const spineEnd = { x: 0, y: corner.y }
  const limit = (centre: Pt, r: number) => {
    const dx = q.x - centre.x
    const dy = q.y - centre.y
    const d = Math.hypot(dx, dy)
    if (d > r) q = { x: centre.x + (dx * r) / d, y: centre.y + (dy * r) / d }
  }
  limit(spineEnd, w)
  // And the other end of the spine: at most the page's diagonal away.
  limit({ x: 0, y: h - corner.y }, Math.hypot(w, h))
  return q
}

export interface CurlShape {
  /** The page still flat (spine side of the fold), in spine coordinates. */
  flat: Pt[]
  /** The part lifted off (corner side of the fold), in spine coordinates. */
  lifted: Pt[]
  /** The back of the page: CSS matrix from its own box (0…W, 0…H) to spine coordinates. */
  backMatrix: [number, number, number, number, number, number]
  /** The back's visible part, in its own box. */
  backClip: Pt[]
  /** The fold: a point on it, and the unit normal pointing away from the corner. */
  fold: Pt
  normal: Pt
}

/** The curl for a page pulled from `corner` to `to`; null when it isn't lifted. */
export function curlShape(dir: 1 | -1, w: number, h: number, corner: Pt, to: Pt): CurlShape | null {
  const vx = to.x - corner.x
  const vy = to.y - corner.y
  const len = Math.hypot(vx, vy)
  if (len < 0.5) return null
  const n = { x: vx / len, y: vy / len }
  const m = { x: (corner.x + to.x) / 2, y: (corner.y + to.y) / 2 }
  const x0 = dir === 1 ? 0 : -w
  const page: Pt[] = [
    { x: x0, y: 0 },
    { x: x0 + w, y: 0 },
    { x: x0 + w, y: h },
    { x: x0, y: h },
  ]
  const flat = clipHalf(page, m, n, 1)
  const lifted = clipHalf(page, m, n, -1)
  // Reflection across the fold, after the back page is laid out where it ends
  // up once turned (mirrored about the spine).
  const a00 = 1 - 2 * n.x * n.x
  const a01 = -2 * n.x * n.y
  const a11 = 1 - 2 * n.y * n.y
  const k = dir === 1 ? w : 0
  const md = 2 * (m.x * n.x + m.y * n.y)
  const backMatrix: CurlShape['backMatrix'] = [
    -a00,
    -a01,
    a01,
    a11,
    a00 * k + md * n.x,
    a01 * k + md * n.y,
  ]
  const backClip = lifted.map((p) => ({ x: k - p.x, y: p.y }))
  return { flat, lifted, backMatrix, backClip, fold: m, normal: n }
}

/** A polygon as a CSS clip-path, moved by (dx, dy). */
export const polygon = (pts: Pt[], dx = 0, dy = 0) =>
  pts.length
    ? `polygon(${pts.map((p) => `${(p.x - dx).toFixed(1)}px ${(p.y - dy).toFixed(1)}px`).join(', ')})`
    : 'polygon(0 0)'

/**
 * A shadow along the fold for a box of w × h whose origin is at `origin` (spine
 * coordinates): dark at the fold, fading `spread` percent towards `dir`.
 */
export function foldShade(
  w: number,
  h: number,
  fold: Pt,
  dir: Pt,
  strength: number,
  spread: number,
  /** Maps a direction in spine coordinates to the box's own (the back is mirrored). */
  mirror = false,
  origin: Pt = { x: 0, y: 0 },
): string {
  const d = mirror ? { x: -dir.x, y: dir.y } : dir
  const f = mirror ? { x: origin.x - fold.x, y: fold.y } : { x: fold.x - origin.x, y: fold.y }
  const angle = (Math.atan2(d.x, -d.y) * 180) / Math.PI
  const length = Math.abs(w * d.x) + Math.abs(h * d.y)
  const at = (((f.x - w / 2) * d.x + (f.y - h / 2) * d.y) / length + 0.5) * 100
  return `linear-gradient(${angle.toFixed(1)}deg, rgba(0,0,0,0) ${(at - 0.5).toFixed(2)}%, rgba(0,0,0,${strength}) ${at.toFixed(2)}%, rgba(0,0,0,0) ${(at + spread).toFixed(2)}%)`
}
