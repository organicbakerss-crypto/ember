/**
 * Where the memory map's circles go. Circles the writer placed stay put; the
 * others are arranged around them: connected topics pull together, all of
 * them push apart, nothing overlaps. Worked out once (not animated), and the
 * same topics always land in the same places.
 */
import type { MemoryNodeFile } from '../schema'

export const MAP_W = 1600
export const MAP_H = 1100

/** Bigger topics are bigger circles (within limits). */
export function radiusOf(node: Pick<MemoryNodeFile, 'points' | 'loose'>): number {
  const n = node.points.length
  return Math.round(Math.min(64, 20 + 7 * Math.sqrt(n)))
}

/** The lines between topics: related (solid) and "grew out of" (dotted). */
export function mapLinks(
  nodes: MemoryNodeFile[],
): { a: string; b: string; kind: 'related' | 'grew' }[] {
  const ids = new Set(nodes.map((n) => n.id))
  const seen = new Set<string>()
  const out: { a: string; b: string; kind: 'related' | 'grew' }[] = []
  for (const n of nodes) {
    if (n.parentId && ids.has(n.parentId)) out.push({ a: n.parentId, b: n.id, kind: 'grew' })
    for (const l of n.links) {
      if (!ids.has(l) || l === n.id) continue
      const key = [n.id, l].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ a: n.id, b: l, kind: 'related' })
    }
  }
  return out
}

/** A number from an id, so the arrangement is the same every time. */
function seed(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 0) / 4294967296
}

/** Positions for every topic (placed ones as they are). */
export function layout(nodes: MemoryNodeFile[]): Map<string, { x: number; y: number }> {
  const links = mapLinks(nodes)
  const pts = nodes.map((n, i) => {
    const placed = n.pos
    const angle = seed(n.id) * Math.PI * 2
    const ring = 120 + (i % 7) * 60 + seed(`${n.id}r`) * 140
    return {
      id: n.id,
      r: radiusOf(n),
      fixed: !!placed,
      x: placed?.x ?? MAP_W / 2 + Math.cos(angle) * ring,
      y: placed?.y ?? MAP_H / 2 + Math.sin(angle) * ring,
    }
  })
  const at = new Map(pts.map((p) => [p.id, p]))
  const free = pts.filter((p) => !p.fixed)
  if (free.length) {
    const rounds = Math.max(60, Math.min(300, Math.round(30000 / pts.length)))
    for (let k = 0; k < rounds; k++) {
      const cool = 1 - k / rounds
      // Push apart (and never overlap).
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i]!
          const b = pts[j]!
          let dx = b.x - a.x
          let dy = b.y - a.y
          let d = Math.hypot(dx, dy)
          if (d < 0.01) {
            dx = seed(a.id + b.id) - 0.5
            dy = 0.5 - seed(b.id + a.id)
            d = Math.hypot(dx, dy)
          }
          // Room for the circles and the names under them.
          const room = a.r + b.r + 70
          const push = (d < room ? (room - d) * 0.5 : 0) + (2600 / (d * d)) * cool * 6
          const ux = dx / d
          const uy = dy / d
          if (!a.fixed) {
            a.x -= ux * push * (b.fixed ? 1 : 0.5)
            a.y -= uy * push * (b.fixed ? 1 : 0.5)
          }
          if (!b.fixed) {
            b.x += ux * push * (a.fixed ? 1 : 0.5)
            b.y += uy * push * (a.fixed ? 1 : 0.5)
          }
        }
      }
      // Linked topics pull together.
      for (const l of links) {
        const a = at.get(l.a)!
        const b = at.get(l.b)!
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.hypot(dx, dy) || 1
        const want = a.r + b.r + 70
        const pull = ((d - want) / d) * 0.08 * cool
        if (!a.fixed) {
          a.x += dx * pull
          a.y += dy * pull
        }
        if (!b.fixed) {
          b.x -= dx * pull
          b.y -= dy * pull
        }
      }
      // A gentle pull to the middle, and the edges of the board.
      for (const p of free) {
        p.x += (MAP_W / 2 - p.x) * 0.01 * cool
        p.y += (MAP_H / 2 - p.y) * 0.01 * cool
        p.x = Math.min(MAP_W - p.r - 10, Math.max(p.r + 10, p.x))
        p.y = Math.min(MAP_H - p.r - 10, Math.max(p.r + 10, p.y))
      }
    }
  }
  return new Map(pts.map((p) => [p.id, { x: Math.round(p.x), y: Math.round(p.y) }]))
}

/** A title as the map shows it (short). */
export function shortTitle(title: string, max = 22): string {
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title
}

/**
 * Which circles show their name at a zoom: names stay the same size on screen,
 * so zoomed out there's room for fewer. Bigger (and wanted) topics go first;
 * a name that would cover another name or a circle is left off (it shows on
 * hover).
 */
export function visibleLabels(
  items: { id: string; title: string; r: number; x: number; y: number; first?: boolean }[],
  zoom: number,
  fontPx = 12.5,
): Set<string> {
  const scale = 1 / zoom
  const h = fontPx * 1.3 * scale
  const boxes: { x1: number; y1: number; x2: number; y2: number }[] = []
  const circles = items.map((i) => ({ x: i.x, y: i.y, r: i.r }))
  const shown = new Set<string>()
  const order = [...items].sort((a, b) => Number(!!b.first) - Number(!!a.first) || b.r - a.r)
  for (const i of order) {
    const w = shortTitle(i.title).length * fontPx * 0.58 * scale
    const top = i.y + i.r + 4 * scale
    const box = { x1: i.x - w / 2, y1: top, x2: i.x + w / 2, y2: top + h }
    const hitsLabel = boxes.some(
      (b) => box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1,
    )
    const hitsCircle = circles.some((c) => {
      const nx = Math.max(box.x1, Math.min(c.x, box.x2))
      const ny = Math.max(box.y1, Math.min(c.y, box.y2))
      return Math.hypot(c.x - nx, c.y - ny) < c.r - 1
    })
    if (hitsLabel || hitsCircle) continue
    boxes.push(box)
    shown.add(i.id)
  }
  return shown
}
