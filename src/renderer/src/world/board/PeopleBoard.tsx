import { useRef, useState } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { BoardFile, RelationshipFile } from '@shared/schema'
import { worldImageUrl } from '@shared/media'
import { valuesAt } from '@shared/world/facts'
import { bandStops, boardLines, describeLine, type BoardLine } from '@shared/world/relationships'
import { api, describeError } from '../../api'
import { useOverlays } from '../../components/overlays'
import { loadLocal, saveLocal } from '../../storage'
import { useSettings } from '../../useTheme'
import { initials, lensOf } from '../model'
import type { UndoStep } from '../useUndo'
import type { WorldData } from '../useWorld'
import { RelationshipEditor } from './RelationshipEditor'
import { RelationshipTypesDialog } from './RelationshipTypesDialog'
import { useRelationships } from './useRelationships'

const W = 1600
const H = 1000
const R = 34 // portrait radius
const FRAME_PAD = 64

type Positions = BoardFile['positions']

/** Groups (factions and families) are frames on the board; everyone else is a portrait. */
export function isGroup(e: Pick<EntrySummary, 'template'>): boolean {
  return e.template === 'faction' || e.template === 'family'
}

/** Positions for people not placed yet: around a circle, in name order. */
function withDefaults(people: EntrySummary[], placed: Positions): Positions {
  const out: Positions = { ...placed }
  const waiting = people.filter((p) => !placed[p.id]).sort((a, b) => a.name.localeCompare(b.name))
  waiting.forEach((p, i) => {
    const angle = (i / Math.max(1, waiting.length)) * Math.PI * 2 - Math.PI / 2
    const ring = 0.32 + (i % 2) * 0.06
    out[p.id] = { x: 0.5 + Math.cos(angle) * ring * 0.9, y: 0.5 + Math.sin(angle) * ring }
  })
  return out
}

/**
 * The people board: portraits, with factions and families as frames around
 * their members. Drag a portrait to move it (layout only, saved apart from
 * the people), or onto someone to link them. Lines are coloured by type,
 * blend along the line when there are several, and are dashed when over.
 */
export function PeopleBoard(props: {
  world: WorldData
  record: (step: UndoStep) => void
  onOpenEntry: (entryId: string) => void
}) {
  const { world, record } = props
  const worldId = world.view.world.id
  const { settings } = useSettings()
  const { toast } = useOverlays()
  const relationships = useRelationships(world, record)
  const svg = useRef<SVGSVGElement>(null)
  const hiddenKey = `world.hiddenTypes.${worldId}`
  const [hidden, setHiddenState] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(loadLocal(hiddenKey) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const setHidden = (next: Set<string>) => {
    setHiddenState(next)
    saveLocal(hiddenKey, JSON.stringify([...next]))
  }
  const [drag, setDrag] = useState<{
    ids: string[]
    from: { x: number; y: number }
    at: { x: number; y: number }
    moved: boolean
  } | null>(null)
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<
    | { kind: 'new'; from: string; to: string }
    | { kind: 'pair'; line: BoardLine }
    | { kind: 'edit'; rel: RelationshipFile }
    | null
  >(null)
  const [typesOpen, setTypesOpen] = useState(false)

  const who = world.view.entries.filter((e) => lensOf(world, e) === 'who')
  const people = who.filter((e) => !isGroup(e))
  const groups = who.filter(isGroup)
  const positions = withDefaults(people, world.view.board)
  const onBoard = new Set(people.map((p) => p.id))

  // Where something is drawn, in board units, following a drag in progress.
  const pos = (id: string) => {
    const p = positions[id]!
    if (drag?.moved && drag.ids.includes(id)) {
      return { x: (p.x + drag.at.x - drag.from.x) * W, y: (p.y + drag.at.y - drag.from.y) * H }
    }
    return { x: p.x * W, y: p.y * H }
  }

  const members = (group: EntrySummary) =>
    people.filter((p) =>
      valuesAt({ multiple: true }, p.facts['memberOf'], null, world.positions).some(
        (v) => v.link === group.id,
      ),
    )
  const frames = groups
    .map((g) => {
      const ms = members(g)
      if (!ms.length) return null
      const pts = ms.map((m) => pos(m.id))
      const x1 = Math.min(...pts.map((p) => p.x)) - FRAME_PAD
      const y1 = Math.min(...pts.map((p) => p.y)) - FRAME_PAD
      const x2 = Math.max(...pts.map((p) => p.x)) + FRAME_PAD
      const y2 = Math.max(...pts.map((p) => p.y)) + FRAME_PAD + 18
      return { group: g, members: ms, x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    })
    .filter((f) => !!f)

  const lines = boardLines(
    world.view.relationships.filter((r) => onBoard.has(r.from) && onBoard.has(r.to)),
    world.view.relationshipTypes,
    { at: null, positions: world.positions, hidden, blend: settings.world.blendLines },
  )

  const toBoard = (e: { clientX: number; clientY: number }) => {
    const box = svg.current!.getBoundingClientRect()
    return { x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height }
  }

  const savePositions = async (next: Positions, label: string) => {
    const before = world.view.board
    try {
      await api.invoke('board:save', { worldId, positions: next })
      record({ label, undo: () => api.invoke('board:save', { worldId, positions: before }) })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const startDrag = (e: React.PointerEvent, ids: string[]) => {
    if (e.button !== 0) return
    e.stopPropagation()
    svg.current?.setPointerCapture(e.pointerId)
    const p = toBoard(e)
    setDrag({ ids, from: p, at: p, moved: false })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return
    const at = toBoard(e)
    const moved = drag.moved || Math.hypot((at.x - drag.from.x) * W, (at.y - drag.from.y) * H) > 5
    setDrag({ ...drag, at, moved })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return
    const { ids, from, at, moved } = drag
    setDrag(null)
    if (!moved) {
      if (ids.length === 1) props.onOpenEntry(ids[0]!)
      return
    }
    // Dropped one portrait on another: link them (the portrait goes back where it was).
    if (ids.length === 1) {
      const dropAt = toBoard(e)
      const target = people.find(
        (p) =>
          p.id !== ids[0] &&
          Math.hypot((positions[p.id]!.x - dropAt.x) * W, (positions[p.id]!.y - dropAt.y) * H) <
            R * 1.4,
      )
      if (target) {
        setEditing({ kind: 'new', from: ids[0]!, to: target.id })
        return
      }
    }
    const clamp = (n: number) => Math.min(0.98, Math.max(0.02, n))
    const next: Positions = { ...positions }
    for (const id of ids) {
      next[id] = {
        x: clamp(positions[id]!.x + at.x - from.x),
        y: clamp(positions[id]!.y + at.y - from.y),
      }
    }
    const what =
      ids.length === 1 ? (world.resolve(ids[0]!)?.name ?? 'someone') : `${ids.length} people`
    void savePositions(next, `Moved ${what} on the board`)
  }

  const toggleType = (id: string) => {
    const next = new Set(hidden)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setHidden(next)
  }

  return (
    <div className="people-board">
      <ul className="board-legend small" aria-label="Relationship types">
        {world.view.relationshipTypes.map((t) => (
          <li key={t.id}>
            <button
              className={`legend-item ${hidden.has(t.id) ? 'off' : ''}`}
              aria-pressed={!hidden.has(t.id)}
              title={hidden.has(t.id) ? 'Show these lines' : 'Hide these lines'}
              onClick={() => toggleType(t.id)}
            >
              <span className="swatch" style={{ background: t.colour }} />
              {t.label}
            </button>
          </li>
        ))}
        <li className="legend-note muted">Solid: current · dashed: over</li>
        <li>
          <button className="link small" onClick={() => setTypesOpen(true)}>
            Edit types…
          </button>
        </li>
      </ul>
      {people.length === 0 ? (
        <p className="muted">
          No one yet. Add people (Who → + New person or group) and they appear here.
        </p>
      ) : (
        <p className="muted small board-help">
          Drag someone onto another person to link them. Drag to move; click a line to change it.
        </p>
      )}
      <div className="board-scroll">
        <svg
          ref={svg}
          className="board-svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="People board"
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id="board-portrait" clipPathUnits="objectBoundingBox">
              <circle cx="0.5" cy="0.5" r="0.5" />
            </clipPath>
            {lines
              .filter((l) => l.colours.length > 1)
              .map((l) => {
                const a = pos(l.a)
                const b = pos(l.b)
                return (
                  <linearGradient
                    key={`g-${l.a}-${l.b}`}
                    id={`line-${l.a}-${l.b}`}
                    gradientUnits="userSpaceOnUse"
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                  >
                    {bandStops(l.colours).map((s, i) => (
                      <stop key={i} offset={s.offset} stopColor={s.colour} />
                    ))}
                  </linearGradient>
                )
              })}
          </defs>
          {frames.map((f) => (
            <g key={f.group.id} className="board-frame">
              <rect x={f.x} y={f.y} width={f.w} height={f.h} rx={22} />
              <text
                x={f.x + 16}
                y={f.y + 26}
                className="board-frame-label"
                role="button"
                aria-label={`${f.group.name}: drag to move everyone in it`}
                onPointerDown={(e) =>
                  startDrag(
                    e,
                    f.members.map((m) => m.id),
                  )
                }
              >
                {f.group.name}
              </text>
            </g>
          ))}
          {lines.map((l) => {
            const a = pos(l.a)
            const b = pos(l.b)
            const stroke = l.colours.length > 1 ? `url(#line-${l.a}-${l.b})` : l.colours[0]
            return (
              <g
                key={`${l.a}-${l.b}`}
                className="board-line"
                data-pair={`${world.resolve(l.a)?.name}|${world.resolve(l.b)?.name}`}
                onClick={() => setEditing({ kind: 'pair', line: l })}
                onMouseMove={(e) =>
                  setHover({
                    text: `${world.resolve(l.a)?.name} and ${world.resolve(l.b)?.name}: ${describeLine(l, world.view.relationshipTypes, world.positions)}`,
                    x: e.clientX,
                    y: e.clientY,
                  })
                }
                onMouseLeave={() => setHover(null)}
              >
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="board-line-hit" />
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={stroke}
                  strokeWidth={5}
                  strokeLinecap="round"
                  strokeDasharray={l.over ? '14 10' : undefined}
                  className="board-line-stroke"
                />
              </g>
            )
          })}
          {people.map((p) => {
            const { x, y } = pos(p.id)
            return (
              <g
                key={p.id}
                className={`board-person ${drag?.ids.includes(p.id) && drag.moved ? 'dragging' : ''}`}
                transform={`translate(${x} ${y})`}
                role="button"
                aria-label={p.name}
                onPointerDown={(e) => startDrag(e, [p.id])}
              >
                <circle r={R} className="board-portrait-ring" />
                {p.portrait ? (
                  <image
                    href={worldImageUrl(worldId, p.portrait.file)}
                    x={-R + 3}
                    y={-R + 3}
                    width={(R - 3) * 2}
                    height={(R - 3) * 2}
                    clipPath="url(#board-portrait)"
                    preserveAspectRatio="xMidYMid slice"
                  />
                ) : (
                  <text y={8} textAnchor="middle" className="board-initials">
                    {initials(p.name)}
                  </text>
                )}
                <text y={R + 22} textAnchor="middle" className="board-name">
                  {p.name}
                </text>
              </g>
            )
          })}
        </svg>
      </div>
      {hover && (
        <div className="map-tooltip small" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          {hover.text}
        </div>
      )}

      {editing?.kind === 'new' && (
        <RelationshipEditor
          world={world}
          from={editing.from}
          to={editing.to}
          onSave={(draft) => void relationships.save(draft).then(() => setEditing(null))}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'edit' && (
        <RelationshipEditor
          world={world}
          relationship={editing.rel}
          onSave={(draft) => void relationships.save(draft).then(() => setEditing(null))}
          onDelete={() => void relationships.remove(editing.rel).then(() => setEditing(null))}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing?.kind === 'pair' && (
        <PairDialog
          world={world}
          line={editing.line}
          onEdit={(rel) => setEditing({ kind: 'edit', rel })}
          onAdd={() => setEditing({ kind: 'new', from: editing.line.a, to: editing.line.b })}
          onClose={() => setEditing(null)}
        />
      )}
      {typesOpen && <RelationshipTypesDialog world={world} onClose={() => setTypesOpen(false)} />}
    </div>
  )
}

/** Everything linking two people, from a click on their line. */
function PairDialog(props: {
  world: WorldData
  line: BoardLine
  onEdit: (rel: RelationshipFile) => void
  onAdd: () => void
  onClose: () => void
}) {
  const { world, line } = props
  const name = (id: string) => world.resolve(id)?.name ?? '(missing)'
  const type = (id: string) => world.view.relationshipTypes.find((t) => t.id === id)
  // All of the pair's relationships, including hidden or "met" ones.
  const all = world.view.relationships.filter(
    (r) => (r.from === line.a && r.to === line.b) || (r.from === line.b && r.to === line.a),
  )
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card stack dialog"
        role="dialog"
        aria-label="Links"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h3>
          {name(line.a)} <span className="muted">and</span> {name(line.b)}
        </h3>
        <ul className="pair-list">
          {all.map((r) => (
            <li key={r.id}>
              <button className="pair-item" onClick={() => props.onEdit(r)}>
                <span className="swatch" style={{ background: type(r.type)?.colour }} />
                <span>
                  {name(r.from)} — {r.label || type(r.type)?.label.toLowerCase()} → {name(r.to)}
                  {(r.over || r.end) && <span className="muted"> (over)</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="dialog-choices">
          <button onClick={props.onAdd}>+ Another link</button>
          <button className="primary" autoFocus onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
