import { useState } from 'react'
import type { MapFile } from '@shared/schema'
import { loadLocal, saveLocal } from '../../storage'
import { templateName } from '../model'
import type { WorldData } from '../useWorld'
import { pinBarGroups, pinColour } from './mapModel'

/** The drag type for a place dragged out of the pin bar. */
export const PLACE_PIN_DRAG = 'application/x-place-pin'

/**
 * Places that belong on this map but aren't on it yet, grouped under the
 * region they are within. Drag one onto the map to pin it (it leaves the
 * bar); drag a pin back here to take it off the map.
 */
export function PinBar(props: {
  world: WorldData
  map: MapFile
  onOpenEntry: (entryId: string) => void
  onAcceptSuggestion: (placeId: string, regionPlaceId: string) => void
}) {
  const { world } = props
  const [open, setOpenState] = useState(() => loadLocal('world.pinBar') !== 'closed')
  const setOpen = (next: boolean) => {
    setOpenState(next)
    saveLocal('world.pinBar', next ? 'open' : 'closed')
  }
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()

  const groups = pinBarGroups(world, props.map)
    .map((g) => ({
      ...g,
      entries: q
        ? g.entries.filter(
            (e) =>
              e.entry.name.toLowerCase().includes(q) ||
              (g.region?.name.toLowerCase().includes(q) ?? false),
          )
        : g.entries,
    }))
    .filter((g) => g.entries.length > 0)
  const count = groups.reduce((n, g) => n + g.entries.length, 0)
  const toggle = (key: string) =>
    setClosed((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (!open) {
    return (
      <aside className="pin-bar collapsed" aria-label="Pin bar">
        <button className="pin-bar-toggle" onClick={() => setOpen(true)} title="Show the pin bar">
          Pins{count ? ` (${count})` : ''} ‹
        </button>
      </aside>
    )
  }

  return (
    <aside className="pin-bar" aria-label="Pin bar">
      <div className="pin-bar-head">
        <h3 className="panel-heading small muted">Not on the map yet</h3>
        <button className="icon" aria-label="Hide the pin bar" onClick={() => setOpen(false)}>
          ›
        </button>
      </div>
      <input
        type="search"
        aria-label="Search places"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {count === 0 ? (
        <p className="muted small">{q ? 'No match.' : 'Everything is on the map.'}</p>
      ) : (
        <p className="muted small">Drag a place onto the map to pin it.</p>
      )}
      {groups.map((g) => {
        const key = g.region?.id ?? 'unsorted'
        const name = g.region?.name ?? 'Unsorted'
        const shut = closed.has(key) && !q
        return (
          <section key={key} className="pin-group" aria-label={name}>
            <button
              className="pin-group-head"
              aria-expanded={!shut}
              title={name}
              onClick={() => toggle(key)}
            >
              <span className="pin-group-name">{name}</span>
              <span className="muted small">{g.entries.length}</span>
            </button>
            {!shut && (
              <ul>
                {g.entries.map(({ entry, suggest }) => (
                  <li key={entry.id}>
                    <div
                      className="pin-item"
                      draggable
                      title={`${entry.name} (${templateName(world, entry.template)}): drag onto the map`}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(PLACE_PIN_DRAG, entry.id)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      onDoubleClick={() => props.onOpenEntry(entry.id)}
                    >
                      <span className="pin-dot" style={{ background: pinColour(entry.template) }} />
                      <span className="pin-item-name">{entry.name}</span>
                    </div>
                    {suggest && (
                      <button
                        className="link small pin-suggest"
                        onClick={() => props.onAcceptSuggestion(entry.id, suggest.id)}
                      >
                        Page mentions {suggest.name}: put it there?
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </aside>
  )
}
