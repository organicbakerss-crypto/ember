import { useEffect, useMemo, useRef, useState } from 'react'
import type { MemoryNodeFile, MemoryState } from '@shared/schema'
import { MAP_H, MAP_W, layout, mapLinks, radiusOf } from '@shared/memory/layout'

type Pt = { x: number; y: number }
const STATE_LABEL: Record<MemoryState, string> = {
  fixed: 'Fixed',
  unfixed: 'Unfixed',
  whim: 'Whim',
  rejected: 'Rejected',
}

/**
 * The story's memory as a map: each topic a circle (colour = state, size =
 * how much is in it), lines between related topics (dotted: grew out of).
 * Drag a circle to move it (kept where you put it), drop it on another to
 * link or unlink them, click to open it. Dragging, panning and zooming move
 * the drawing directly (no redraw), so it stays smooth; nothing is saved
 * until a circle is let go, and moving is never an undo step.
 */
export function MemoryMap(props: {
  nodes: MemoryNodeFile[]
  books: { id: string; name: string }[]
  /** Topics the last answer read: they glow for a few seconds. */
  glow: string[]
  onOpen: (id: string) => void
  /**
   * A circle was moved: save its place, and (the first time) every other
   * circle's place as it is now, so nothing else moves when it's let go.
   */
  onMove: (id: string, pos: Pt, all: Map<string, Pt>) => void
  /** A circle was dropped on another: link them (or unlink if they were). */
  onLink: (a: string, b: string) => void
  /** Forget every circle's place and lay the map out fresh. */
  onArrange: () => void
}) {
  const [query, setQuery] = useState('')
  const [book, setBook] = useState('')
  const [showRejected, setShowRejected] = useState(false)
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)

  const nodes = useMemo(
    () =>
      props.nodes.filter(
        (n) =>
          (showRejected || n.state !== 'rejected') &&
          (!book || n.loose || n.volumeId === book || n.volumeId === null),
      ),
    [props.nodes, showRejected, book],
  )
  const placed = useMemo(() => layout(nodes), [nodes])
  const links = useMemo(() => mapLinks(nodes), [nodes])
  const q = query.trim().toLowerCase()
  const matches = useMemo(
    () =>
      q
        ? new Set(
            nodes
              .filter(
                (n) =>
                  n.title.toLowerCase().includes(q) ||
                  n.summary.toLowerCase().includes(q) ||
                  n.points.some((p) => p.text.toLowerCase().includes(q)),
              )
              .map((n) => n.id),
          )
        : null,
    [nodes, q],
  )

  // The drawing's own state, changed directly while dragging (React redraws only when it's done).
  const svg = useRef<SVGSVGElement>(null)
  const viewport = useRef<SVGGElement>(null)
  const circles = useRef(new Map<string, SVGGElement>())
  const lines = useRef(new Map<string, SVGLineElement>())
  const where = useRef(new Map<string, Pt>())
  useEffect(() => {
    where.current = new Map(placed)
  }, [placed])
  const view = useRef({ x: 0, y: 0, k: 1 })
  const applyView = () => {
    const v = view.current
    viewport.current?.setAttribute('transform', `translate(${v.x} ${v.y}) scale(${v.k})`)
  }
  // Until the writer pans or zooms, the map keeps everything in view (also as the pane settles its size).
  const touched = useRef(false)
  const fit = () => {
    const box = svg.current?.getBoundingClientRect()
    if (!box || box.width < 50 || box.height < 50 || !where.current.size) return
    const all = [...where.current.values()]
    const xs = all.map((p) => p.x)
    const ys = all.map((p) => p.y)
    const pad = 90
    const w = Math.max(...xs) - Math.min(...xs) + pad * 2
    const h = Math.max(...ys) - Math.min(...ys) + pad * 2
    const k = Math.min(2.2, Math.max(0.2, Math.min(box.width / w, box.height / h)))
    view.current = {
      k,
      x: box.width / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * k,
      y: box.height / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * k,
    }
    applyView()
  }
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const watch = new ResizeObserver(() => {
      if (!touched.current) fit()
    })
    watch.observe(el)
    return () => watch.disconnect()
    // fit only reads refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Fit when the map first has topics, or is laid out fresh.
  const fresh = !nodes.some((n) => n.pos)
  const fitted = useRef(false)
  useEffect(() => {
    // Pinning circles on the first move isn't a fresh layout: the view stays.
    if (fitted.current && !fresh) return
    touched.current = false
    where.current = new Map(placed)
    fit()
    fitted.current = where.current.size > 0
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed.size > 0, fresh])

  const toMap = (e: { clientX: number; clientY: number }): Pt => {
    const box = svg.current!.getBoundingClientRect()
    const v = view.current
    return { x: (e.clientX - box.left - v.x) / v.k, y: (e.clientY - box.top - v.y) / v.k }
  }

  /** Moves a circle and the ends of its lines on screen. */
  const drawAt = (id: string, p: Pt) => {
    where.current.set(id, p)
    circles.current.get(id)?.setAttribute('transform', `translate(${p.x} ${p.y})`)
    for (const l of links) {
      if (l.a !== id && l.b !== id) continue
      const el = lines.current.get(`${l.a}|${l.b}`)
      if (!el) continue
      const end = l.a === id ? '1' : '2'
      el.setAttribute(`x${end}`, String(p.x))
      el.setAttribute(`y${end}`, String(p.y))
    }
  }

  const gesture = useRef<
    | { kind: 'move'; id: string; from: Pt; start: Pt; moved: boolean }
    | { kind: 'pan'; from: { x: number; y: number }; start: { x: number; y: number } }
    | null
  >(null)
  const frame = useRef(0)
  const pending = useRef<{ clientX: number; clientY: number } | null>(null)

  const onCircleDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    svg.current?.setPointerCapture(e.pointerId)
    gesture.current = {
      kind: 'move',
      id,
      from: toMap(e),
      start: where.current.get(id)!,
      moved: false,
    }
    setHover(null)
  }
  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    touched.current = true
    svg.current?.setPointerCapture(e.pointerId)
    gesture.current = {
      kind: 'pan',
      from: { x: e.clientX, y: e.clientY },
      start: { x: view.current.x, y: view.current.y },
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!gesture.current) return
    // At most one change per screen frame.
    pending.current = { clientX: e.clientX, clientY: e.clientY }
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const g = gesture.current
      const at = pending.current
      if (!g || !at) return
      if (g.kind === 'pan') {
        view.current.x = g.start.x + at.clientX - g.from.x
        view.current.y = g.start.y + at.clientY - g.from.y
        applyView()
        return
      }
      const p = toMap(at)
      const dx = p.x - g.from.x
      const dy = p.y - g.from.y
      if (!g.moved && Math.hypot(dx, dy) * view.current.k < 4) return
      g.moved = true
      drawAt(g.id, { x: g.start.x + dx, y: g.start.y + dy })
    })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    cancelAnimationFrame(frame.current)
    frame.current = 0
    if (!g || g.kind === 'pan') return
    if (!g.moved) {
      props.onOpen(g.id)
      return
    }
    const p = toMap(e)
    const end = { x: g.start.x + p.x - g.from.x, y: g.start.y + p.y - g.from.y }
    // Dropped on another topic: link them, and this one goes back where it was.
    const target = nodes.find((n) => {
      if (n.id === g.id) return false
      const c = where.current.get(n.id)
      return !!c && Math.hypot(c.x - end.x, c.y - end.y) < radiusOf(n)
    })
    if (target) {
      drawAt(g.id, g.start)
      props.onLink(g.id, target.id)
      return
    }
    drawAt(g.id, end)
    props.onMove(g.id, { x: Math.round(end.x), y: Math.round(end.y) }, new Map(where.current))
  }
  const onWheel = (e: React.WheelEvent) => {
    touched.current = true
    const box = svg.current!.getBoundingClientRect()
    const v = view.current
    const k = Math.min(3, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)))
    const mx = e.clientX - box.left
    const my = e.clientY - box.top
    view.current = { k, x: mx - ((mx - v.x) / v.k) * k, y: my - ((my - v.y) / v.k) * k }
    applyView()
  }
  // Wheel without scrolling the page.
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const stop = (e: WheelEvent) => e.preventDefault()
    el.addEventListener('wheel', stop, { passive: false })
    return () => el.removeEventListener('wheel', stop)
  }, [])

  const glowKey = props.glow.join(',')
  // The circles and lines, drawn again only when they change (not when the hover card does).
  const drawing = useMemo(() => {
    const glow = new Set(glowKey ? glowKey.split(',') : [])
    return (
      <g ref={viewport}>
        <rect className="memory-map-bounds" x={0} y={0} width={MAP_W} height={MAP_H} />
        {links.map((l) => {
          const a = placed.get(l.a)!
          const b = placed.get(l.b)!
          const dim = matches && !(matches.has(l.a) && matches.has(l.b))
          return (
            <line
              key={`${l.a}|${l.b}`}
              ref={(el) => {
                if (el) lines.current.set(`${l.a}|${l.b}`, el)
                else lines.current.delete(`${l.a}|${l.b}`)
              }}
              className={`memory-link ${l.kind} ${dim ? 'dim' : ''}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
            />
          )
        })}
        {nodes.map((n) => {
          const p = placed.get(n.id)!
          const r = radiusOf(n)
          const dim = matches && !matches.has(n.id)
          return (
            <g
              key={n.id}
              ref={(el) => {
                if (el) circles.current.set(n.id, el)
                else circles.current.delete(n.id)
              }}
              className={`memory-circle state-${n.state} ${n.loose ? 'loose' : ''} ${dim ? 'dim' : ''} ${glow.has(n.id) ? 'glow' : ''}`}
              transform={`translate(${p.x} ${p.y})`}
              role="button"
              aria-label={`${n.title}: ${n.loose ? 'loose ends' : STATE_LABEL[n.state]}, ${n.points.length} points`}
              onPointerDown={(e) => onCircleDown(e, n.id)}
              onPointerEnter={(e) => setHover({ id: n.id, x: e.clientX, y: e.clientY })}
              onPointerLeave={() => setHover((h) => (h?.id === n.id ? null : h))}
            >
              <circle r={r} />
              <text className="memory-circle-count" y={-r * 0.22} style={{ fontSize: r * 0.42 }}>
                {n.points.length}
              </text>
              {/* The name inside, under the number: it grows and shrinks with everything else. */}
              <text className="memory-circle-title" style={{ fontSize: Math.max(5, r * 0.24) }}>
                {titleLines(n.title, r).map((line, i) => (
                  <tspan key={i} x={0} y={r * 0.2 + i * Math.max(5, r * 0.24) * 1.15}>
                    {line}
                  </tspan>
                ))}
              </text>
            </g>
          )
        })}
      </g>
    )
    // onCircleDown and setHover are stable enough: they only read refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, placed, links, matches, glowKey])

  const hovered = hover ? nodes.find((n) => n.id === hover.id) : null
  const count = (n: MemoryNodeFile, s: MemoryState) => n.points.filter((p) => p.state === s).length

  return (
    <div className="memory-map">
      <div className="memory-map-bar">
        <input
          type="search"
          aria-label="Find on the map"
          placeholder="Find…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {props.books.length > 1 && (
          <select aria-label="Book" value={book} onChange={(e) => setBook(e.target.value)}>
            <option value="">All books</option>
            {props.books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <label className="radio small">
          <input
            type="checkbox"
            checked={showRejected}
            onChange={(e) => setShowRejected(e.target.checked)}
          />
          Show rejected
        </label>
        <button
          className="link small"
          title="Lay the map out fresh (your own placements are forgotten)"
          onClick={props.onArrange}
        >
          Arrange again
        </button>
        <span className="memory-map-key small">
          <i className="state-fixed" /> Fixed <i className="state-unfixed" /> Unfixed{' '}
          <i className="state-whim" /> Whim
        </span>
      </div>
      <svg
        ref={svg}
        className="memory-map-svg"
        role="img"
        aria-label="Memory map"
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <defs>
          <marker
            id="memory-arrow"
            viewBox="0 0 10 10"
            refX="10"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" className="memory-arrow" />
          </marker>
        </defs>
        {drawing}
      </svg>
      {hovered && hover && (
        <div
          className="memory-map-card"
          style={{ left: hover.x + 14, top: hover.y + 14, position: 'fixed' }}
        >
          <strong>{hovered.title}</strong>
          <div className="small muted">
            {hovered.loose ? 'Loose ends' : STATE_LABEL[hovered.state]} ·{' '}
            {(['fixed', 'unfixed', 'whim'] as MemoryState[])
              .map((s) => `${count(hovered, s)} ${STATE_LABEL[s].toLowerCase()}`)
              .join(' · ')}
          </div>
          {hovered.summary && <p className="small">{hovered.summary}</p>}
        </div>
      )}
      <p className="muted small memory-map-help">
        Click a circle to open it · drag to move it · drop it on another to link or unlink them ·
        drag the background to move around · scroll to zoom
      </p>
    </div>
  )
}

/** A title in up to two lines that fit inside a circle (shortened if it must be). */
function titleLines(title: string, r: number): string[] {
  const size = Math.max(5, r * 0.24)
  const per = Math.max(4, Math.floor((r * 1.6) / (size * 0.56)))
  const lines: string[] = []
  let line = ''
  for (const word of title.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (next.length <= per) line = next
    else {
      if (line) lines.push(line)
      line = word
    }
    if (lines.length === 2) break
  }
  if (lines.length < 2 && line) lines.push(line)
  const used = lines.join(' ').length
  const out = lines.slice(0, 2).map((l) => (l.length > per ? `${l.slice(0, per - 1)}…` : l))
  if (used < title.length && out.length) {
    const last = out[out.length - 1]!
    out[out.length - 1] = last.endsWith('…') ? last : `${last.slice(0, Math.max(1, per - 1))}…`
  }
  return out
}
