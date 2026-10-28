import { useRef, useState } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { Sketch } from '@shared/schema'
import { useOverlays } from '../../components/overlays'
import { lensOf, templateName } from '../model'
import type { WorldData } from '../useWorld'
import { peopleAt } from './mapModel'

const W = 1000
const H = 640

/**
 * No map yet: a travel sketch. Places are dots you drag into position and
 * join with roads; joined places count as nearby. A real map can replace it
 * later (it stays as the fallback when maps are turned off).
 */
export function TravelSketch(props: {
  world: WorldData
  sketch: Sketch | null
  editing: boolean
  onSave: (sketch: Sketch, label: string) => Promise<void>
  onOpenEntry: (entryId: string) => void
  onDropPerson: (personId: string, placeId: string) => void
}) {
  const { world } = props
  const sketch = props.sketch ?? { nodes: [], roads: [] }
  const svg = useRef<SVGSVGElement>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [drag, setDrag] = useState<{
    placeId: string
    x: number
    y: number
    /** Where the press started, in screen pixels; it's a drag only once it moves. */
    from: { x: number; y: number }
    moved: boolean
  } | null>(null)
  const { toast } = useOverlays()

  const places = world.view.entries.filter((e) => lensOf(world, e) === 'where')
  const pos = new Map(sketch.nodes.map((n) => [n.placeId, n]))
  const placed = places.filter((p) => pos.has(p.id))
  const waiting = places.filter((p) => !pos.has(p.id))

  const toSketch = (e: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect()
    return {
      x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
    }
  }
  const at = (id: string) => (drag?.placeId === id ? drag : (pos.get(id) ?? { x: 0.5, y: 0.5 }))

  const place = (placeId: string, x: number, y: number) =>
    props.onSave(
      {
        ...sketch,
        nodes: [...sketch.nodes.filter((n) => n.placeId !== placeId), { placeId, x, y }],
      },
      `Moved ${world.resolve(placeId)?.name ?? 'a place'} on the sketch`,
    )

  const placeAll = () => {
    const n = waiting.length
    const nodes = waiting.map((p, i) => {
      const angle = (i / Math.max(1, n)) * Math.PI * 2
      return { placeId: p.id, x: 0.5 + Math.cos(angle) * 0.35, y: 0.5 + Math.sin(angle) * 0.35 }
    })
    void props.onSave({ ...sketch, nodes: [...sketch.nodes, ...nodes] }, 'Put places on the sketch')
  }

  const toggleRoad = (a: string, b: string) => {
    if (a === b) return
    const exists = sketch.roads.some(
      (r) => (r.from === a && r.to === b) || (r.from === b && r.to === a),
    )
    const names = `${world.resolve(a)?.name} and ${world.resolve(b)?.name}`
    void props.onSave(
      {
        ...sketch,
        roads: exists
          ? sketch.roads.filter(
              (r) => !((r.from === a && r.to === b) || (r.from === b && r.to === a)),
            )
          : [...sketch.roads, { from: a, to: b }],
      },
      exists ? `Removed the road between ${names}` : `Joined ${names} by road`,
    )
  }

  const onNodeClick = (p: EntrySummary) => {
    if (!props.editing) return props.onOpenEntry(p.id)
    if (!connecting) setConnecting(p.id)
    else {
      toggleRoad(connecting, p.id)
      setConnecting(null)
    }
  }

  return (
    <div className="sketch">
      {props.editing ? (
        <p className="muted small map-help">
          Drag places into position. Click one place and then another to join them by road (or
          remove the road). Joined places count as nearby.
        </p>
      ) : (
        placed.length === 0 && (
          <p className="muted small map-help">
            No map yet. Edit the sketch to lay out your places, or import a map image.
          </p>
        )
      )}
      <svg
        ref={svg}
        className={`sketch-svg ${props.editing ? 'editing' : ''}`}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Travel sketch"
        onPointerMove={(e) => {
          if (!drag) return
          const moved =
            drag.moved || Math.hypot(e.clientX - drag.from.x, e.clientY - drag.from.y) > 4
          setDrag({ ...drag, ...(moved ? toSketch(e) : {}), moved })
        }}
        onPointerUp={() => {
          if (!drag) return
          const { placeId, x, y, moved } = drag
          setDrag(null)
          if (moved) void place(placeId, x, y)
          else {
            const p = world.resolve(placeId)
            if (p) onNodeClick(p)
          }
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const placeId = e.dataTransfer.getData('application/x-place')
          if (!placeId) return
          e.preventDefault()
          const { x, y } = toSketch(e)
          void place(placeId, x, y)
        }}
      >
        <rect className="sketch-paper" x={0} y={0} width={W} height={H} rx={12} />
        {sketch.roads.map((r) => {
          if (!pos.has(r.from) || !pos.has(r.to)) return null
          const a = at(r.from)
          const b = at(r.to)
          return (
            <line
              key={`${r.from}-${r.to}`}
              className="sketch-road"
              x1={a.x * W}
              y1={a.y * H}
              x2={b.x * W}
              y2={b.y * H}
            />
          )
        })}
        {placed.map((p) => {
          const { x, y } = at(p.id)
          const here = peopleAt(world, p.id)
          return (
            <g
              key={p.id}
              className={`sketch-node ${connecting === p.id ? 'selected' : ''}`}
              role="button"
              aria-label={p.name}
              transform={`translate(${x * W} ${y * H})`}
              onPointerDown={(e) => {
                if (!props.editing) return
                e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId)
                setDrag({ placeId: p.id, x, y, from: { x: e.clientX, y: e.clientY }, moved: false })
              }}
              onClick={() => !props.editing && onNodeClick(p)}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-entry')) e.preventDefault()
              }}
              onDrop={(e) => {
                const personId = e.dataTransfer.getData('application/x-entry')
                if (!personId) return
                e.preventDefault()
                e.stopPropagation()
                props.onDropPerson(personId, p.id)
              }}
            >
              <title>{`${p.name} · ${templateName(world, p.template)}`}</title>
              <circle r={11} />
              <text y={-18} textAnchor="middle">
                {p.name}
              </text>
              {here.length > 0 && (
                <text y={30} textAnchor="middle" className="sketch-people">
                  {here
                    .slice(0, 3)
                    .map((h) => h.name)
                    .join(', ')}
                  {here.length > 3 ? ` +${here.length - 3}` : ''}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {props.editing && waiting.length > 0 && (
        <div className="sketch-waiting small">
          <span className="muted">Not on the sketch yet (drag on):</span>
          {waiting.map((p) => (
            <span
              key={p.id}
              className="chip"
              draggable
              onDragStart={(e) => e.dataTransfer.setData('application/x-place', p.id)}
            >
              {p.name}
            </span>
          ))}
          <button className="link small" onClick={placeAll}>
            Place them all
          </button>
        </div>
      )}
      {!props.editing && waiting.length > 0 && placed.length > 0 && (
        <p className="muted small">
          {waiting.length} {waiting.length === 1 ? 'place isn’t' : 'places aren’t'} on the sketch
          yet.{' '}
          <button className="link small" onClick={() => toast('Choose “Edit sketch” to add them.')}>
            How?
          </button>
        </p>
      )}
    </div>
  )
}
