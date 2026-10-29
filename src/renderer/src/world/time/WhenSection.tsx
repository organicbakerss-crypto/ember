import { useRef } from 'react'
import type { MapFile, TimelinePlace } from '@shared/schema'
import { baseMaps, mapAt } from '@shared/world/maps'
import { orderBetween } from '@shared/world/timeline'
import { chapterName } from '@shared/world/story'
import { api, describeError } from '../../api'
import { useOverlays } from '../../components/overlays'
import { readMapImage } from '../map/WhereMap'
import type { UndoStep } from '../useUndo'
import type { WorldData } from '../useWorld'
import { useTime } from './TimeContext'

/**
 * Where an era or event sits on the timeline: in the world's history before
 * the story (moved earlier or later), or during a chapter. Events can also
 * change a map from here on ("the map changes here").
 */
export function WhenSection(props: {
  world: WorldData
  entryId: string
  record: (step: UndoStep) => void
  onOpenMap?: (mapId: string) => void
}) {
  const { world, record } = props
  const worldId = world.view.world.id
  const entry = world.byId.get(props.entryId)
  const { toast, choose } = useOverlays()
  const { setStop } = useTime()
  const imageInput = useRef<HTMLInputElement>(null)
  const pending = useRef<MapFile | null>(null)
  if (!entry) return null
  const isEra = entry.template === 'era'
  const chapters = world.index?.chapters ?? []
  const { history } = world.timeline
  const orderOf = (id: string) => {
    const w = world.byId.get(id)?.when
    return w?.kind === 'history' ? w.order : undefined
  }

  const place = async (when: TimelinePlace | null, label: string) => {
    const before = entry.when
    try {
      await api.invoke('entry:save', { worldId, entryId: entry.id, patch: { when } })
      record({
        label,
        undo: () =>
          api.invoke('entry:save', { worldId, entryId: entry.id, patch: { when: before } }),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const value = !entry.when
    ? ''
    : entry.when.kind === 'history'
      ? 'history'
      : chapters.some((c) => c.id === (entry.when as { chapterId: string }).chapterId)
        ? `ch:${entry.when.chapterId}`
        : ''
  const onChange = (next: string) => {
    if (next === '') return void place(null, `Took ${entry.name} off the timeline`)
    if (next === 'history') {
      // Placed last in history: just before the story starts.
      const lastOrder = history.length ? orderOf(history[history.length - 1]!) : undefined
      return void place(
        { kind: 'history', order: orderBetween(lastOrder, undefined) },
        `Put ${entry.name} before the story`,
      )
    }
    const chapterId = next.slice(3)
    const chapter = chapters.find((c) => c.id === chapterId)
    void place({ kind: 'chapter', chapterId }, `Put ${entry.name} during ${chapter?.label}`)
  }

  const h = history.indexOf(entry.id)
  const move = (by: -1 | 1) => {
    const target = h + by
    if (target < 0 || target >= history.length) return
    // Between the neighbours on the side it moves to.
    const a = by < 0 ? history[target - 1] : history[target]
    const b = by < 0 ? history[target] : history[target + 1]
    const order = orderBetween(a ? orderOf(a) : undefined, b ? orderOf(b) : undefined)
    void place({ kind: 'history', order }, `Moved ${entry.name} ${by < 0 ? 'earlier' : 'later'}`)
  }

  /* ----- map versions ----- */

  const maps = baseMaps(world.view.maps).filter((m) => m.image)
  const versionsHere = world.view.maps.filter(
    (m) => m.versionOf && m.from?.kind === 'event' && m.from.entryId === entry.id,
  )
  const changeMap = async () => {
    let base = maps[0]
    if (!base) return
    if (maps.length > 1) {
      const id = await choose(
        'Which map changes here?',
        maps.map((m) => ({ value: m.id, label: m.name })),
      )
      base = maps.find((m) => m.id === id)
      if (!base) return
    }
    const how = await choose(
      `How does ${base.name} change at ${entry.name}?`,
      [
        { value: 'redraw', label: 'Redraw its borders', primary: true },
        { value: 'image', label: 'Upload a new image…' },
      ],
      'Before this event the map stays as it was; from here on, the new version shows. Places keep their identity.',
    )
    if (how === 'redraw') await makeVersion(base, null)
    if (how === 'image') {
      pending.current = base
      imageInput.current?.click()
    }
  }
  const makeVersion = async (base: MapFile, file: File | null) => {
    // Start from the map as it was just before this event.
    const at = world.positions.get(entry.id)
    const source = mapAt(world.view.maps, base, at === undefined ? null : at - 0.5, world.positions)
    try {
      const created = await api.invoke('map:create', {
        worldId,
        name: base.name,
        placeId: base.placeId,
        image: file ? await readMapImage(file) : null,
        version: { of: base.id, copyFrom: source.id, from: { kind: 'event', entryId: entry.id } },
      })
      record({
        label: `${base.name} changes at ${entry.name}`,
        undo: () =>
          api.invoke('trash:add', { target: { kind: 'map', worldId, mapId: created.id } }),
      })
      const stop = world.timeline.stops.find((s) => s.id === entry.id)
      if (stop) setStop(stop)
      props.onOpenMap?.(base.id)
      toast(`This is ${base.name} from ${entry.name} on. Use “Edit regions” to redraw its borders.`)
    } catch (err) {
      toast(`Couldn’t change the map: ${describeError(err).message}`)
    }
  }

  return (
    <section className="entry-section" aria-label="When">
      <h3>When</h3>
      <div className="row when-row">
        <select
          aria-label="Place on the timeline"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Not on the timeline yet</option>
          <option value="history">Before the story</option>
          {chapters.length > 0 && (
            <optgroup label="During the story">
              {chapters.map((c) => (
                <option key={c.id} value={`ch:${c.id}`}>
                  During {chapterName(c)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {h >= 0 && (
          <>
            <span className="muted small">
              {h + 1} of {history.length} in the world’s history
            </span>
            <button className="small" disabled={h === 0} onClick={() => move(-1)}>
              ↑ Earlier
            </button>
            <button className="small" disabled={h === history.length - 1} onClick={() => move(1)}>
              ↓ Later
            </button>
          </>
        )}
      </div>
      {!entry.when && (
        <p className="muted small">
          Until it’s on the timeline, facts “from {entry.name}” count as already true.
        </p>
      )}
      {!isEra && maps.length > 0 && (
        <div className="row small">
          {versionsHere.map((m) => (
            <button
              key={m.id}
              className="link"
              onClick={() => {
                const stop = world.timeline.stops.find((s) => s.id === entry.id)
                if (stop) setStop(stop)
                props.onOpenMap?.(m.versionOf!)
              }}
            >
              {m.name} changes here: open it
            </button>
          ))}
          <button className="link" onClick={() => void changeMap()}>
            The map changes here…
          </button>
          <input
            ref={imageInput}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            aria-label="New map image"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file && pending.current) void makeVersion(pending.current, file)
            }}
          />
        </div>
      )}
    </section>
  )
}
