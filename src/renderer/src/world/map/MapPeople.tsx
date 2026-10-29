import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { MapPin, MapRegion, Point } from '@shared/schema'
import { worldImageUrl } from '@shared/media'
import { currentValue } from '@shared/world/facts'
import { labelPoint } from '@shared/world/maps'
import { initials } from '../model'
import type { WorldData } from '../useWorld'
import { eventsShown, isPerson, lastMove } from './mapModel'

/** How many portraits stand at one place before "+N". */
const SHOWN = 4

/**
 * Who's where on a map at the world's moment: portraits under each place's
 * label (or beside its pin), a faint trail behind anyone who just moved, and
 * markers for events that have happened there. Portraits keep their element
 * across moments, so with `glide` they move smoothly to their new place.
 */
export function MapPeople(props: {
  world: WorldData
  regions: MapRegion[]
  pins: MapPin[]
  /** 1% of the map, and the pin size, in image pixels. */
  unit: number
  s: number
  /** A place whose pin is being dragged (its people are hidden meanwhile). */
  hidePlace?: string
  glide: boolean
  trails: boolean
  /** A portrait being dragged, drawn under the pointer. */
  dragging?: { id: string; at: Point }
  /** Pressing on a portrait: a click opens the person, a drag moves them. */
  onPersonDown: (personId: string, e: ReactPointerEvent) => void
  onOpenEntry: (entryId: string) => void
}): ReactNode {
  const { world, unit, s } = props
  const worldId = world.view.world.id

  // Where people stand at each place: under a region's label, else beside its pin.
  const standAt = new Map<string, Point>()
  for (const r of props.regions) {
    if (!r.placeId || standAt.has(r.placeId)) continue
    const [x, y] = labelPoint(r)
    standAt.set(r.placeId, [x, y + unit * 1.8])
  }
  const pinAt = new Map<string, Point>()
  for (const pin of props.pins) {
    pinAt.set(pin.placeId, [pin.x, pin.y - s * 1.9])
    if (!standAt.has(pin.placeId)) standAt.set(pin.placeId, [pin.x + s * 2.6, pin.y - s * 1.9])
  }

  const byPlace = new Map<string, EntrySummary[]>()
  for (const e of world.view.entries) {
    if (!isPerson(world, e)) continue
    const placeId = currentValue(e.facts['location'], world.at, world.positions)?.link
    if (!placeId || !standAt.has(placeId) || placeId === props.hidePlace) continue
    byPlace.set(placeId, [...(byPlace.get(placeId) ?? []), e])
  }
  const placed: { person: EntrySummary; at: Point }[] = []
  const more: { placeId: string; count: number; at: Point }[] = []
  for (const [placeId, here] of byPlace) {
    const [x, y] = standAt.get(placeId)!
    const n = Math.min(here.length, SHOWN)
    here.slice(0, SHOWN).forEach((person, i) => {
      placed.push({ person, at: [x + (i - (n - 1) / 2) * unit * 2.6, y] })
    })
    if (here.length > SHOWN) more.push({ placeId, count: here.length - SHOWN, at: [x, y] })
  }

  const trails = props.trails
    ? placed.flatMap(({ person, at }) => {
        const move = lastMove(world, person)
        const from = move && standAt.get(move.from)
        return from ? [{ id: person.id, from, to: at }] : []
      })
    : []

  // Event markers sit above the place's label (or its pin), side by side.
  const eventsAt = new Map<string, EntrySummary[]>()
  for (const { event, placeId } of eventsShown(world)) {
    if (standAt.has(placeId)) eventsAt.set(placeId, [...(eventsAt.get(placeId) ?? []), event])
  }
  const d = unit * 0.9

  return (
    <g className={`map-people ${props.glide ? 'glide' : ''}`}>
      {trails.map((t) => (
        <line
          key={`trail-${t.id}`}
          className="map-trail"
          x1={t.from[0]}
          y1={t.from[1]}
          x2={t.to[0]}
          y2={t.to[1]}
          strokeWidth={unit * 0.35}
          strokeDasharray={`${unit} ${unit * 0.7}`}
        />
      ))}
      {[...eventsAt].flatMap(([placeId, events]) => {
        const [px, py] = pinAt.get(placeId) ?? standAt.get(placeId)!
        const y = py - unit * (pinAt.has(placeId) ? 2.8 : 4.6)
        return events.slice(0, 3).map((event, i) => {
          const x = px + (i - (Math.min(events.length, 3) - 1) / 2) * unit * 2.2
          const current = world.at !== null && world.positions.get(event.id) === world.at
          return (
            <g
              key={`event-${event.id}`}
              className={`map-event ${current ? 'current' : ''}`}
              role="button"
              aria-label={`Event: ${event.name}`}
              onClick={(e) => {
                e.stopPropagation()
                props.onOpenEntry(event.id)
              }}
            >
              <title>{event.name}</title>
              <path d={`M${x},${y - d} L${x + d},${y} L${x},${y + d} L${x - d},${y} Z`} />
            </g>
          )
        })
      })}
      {placed.map(({ person: p, at: home }) => {
        const dragged = props.dragging?.id === p.id
        const at = dragged ? props.dragging!.at : home
        return (
          <g
            key={p.id}
            className={`map-person ${dragged ? 'dragging' : ''}`}
            data-person={p.id}
            role="button"
            aria-label={p.name}
            style={{ transform: `translate(${at[0]}px, ${at[1]}px)` }}
            onPointerDown={(e) => props.onPersonDown(p.id, e)}
            onClick={(e) => e.stopPropagation()}
          >
            <title>{p.name}</title>
            <circle r={unit * 1.2} />
            {p.portrait ? (
              <image
                href={worldImageUrl(worldId, p.portrait.file)}
                x={-unit * 1.1}
                y={-unit * 1.1}
                width={unit * 2.2}
                height={unit * 2.2}
                clipPath="url(#map-portrait)"
                preserveAspectRatio="xMidYMid slice"
              />
            ) : (
              <text y={unit * 0.4} fontSize={unit * 1.1} textAnchor="middle">
                {initials(p.name)}
              </text>
            )}
          </g>
        )
      })}
      {more.map((m) => (
        <text
          key={`more-${m.placeId}`}
          x={m.at[0] + unit * 6}
          y={m.at[1] + unit * 0.4}
          fontSize={unit * 1.1}
          className="map-more"
        >
          +{m.count}
        </text>
      ))}
    </g>
  )
}
