import { useState } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { TimelinePlace } from '@shared/schema'
import { currentValue } from '@shared/world/facts'
import { chapterName } from '@shared/world/story'
import { orderBetween, type TimelineStop } from '@shared/world/timeline'
import { api, describeError } from '../../api'
import { useOverlays } from '../../components/overlays'
import type { UndoStep } from '../useUndo'
import type { WorldData } from '../useWorld'
import { lensOf, valueLabel } from '../model'
import { useTime } from './TimeContext'
import { TimeScrubber } from './TimeScrubber'

const DRAG = 'application/x-timeline-item'

/**
 * The world's timeline as a list: its history (eras and events in order,
 * dragged or nudged to reorder), the story's chapters with the events
 * during them, and what isn't on the timeline yet. Clicking a moment's
 * marker sets the scrubber there.
 */
export function TimelineView(props: {
  world: WorldData
  record: (step: UndoStep) => void
  onOpenEntry: (entryId: string) => void
}) {
  const { world, record } = props
  const worldId = world.view.world.id
  const { toast } = useOverlays()
  const { stop, setStop } = useTime()
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const { history, during, unplaced, stops } = world.timeline
  const chapters = world.index?.chapters ?? []
  const entry = (id: string) => world.byId.get(id)
  const orderOf = (id: string) => {
    const w = entry(id)?.when
    return w?.kind === 'history' ? w.order : undefined
  }

  const place = async (e: EntrySummary, when: TimelinePlace | null, label: string) => {
    const before = e.when
    try {
      await api.invoke('entry:save', { worldId, entryId: e.id, patch: { when } })
      record({
        label,
        undo: () => api.invoke('entry:save', { worldId, entryId: e.id, patch: { when: before } }),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  /** Puts an item into history just before another (or last, before the story). */
  const putBefore = (id: string, beforeId: string | null) => {
    const e = entry(id)
    if (!e || id === beforeId) return
    const rest = history.filter((x) => x !== id)
    const at = beforeId ? rest.indexOf(beforeId) : rest.length
    const prev = at > 0 ? rest[at - 1] : undefined
    const next = at < rest.length ? rest[at] : undefined
    const order = orderBetween(prev ? orderOf(prev) : undefined, next ? orderOf(next) : undefined)
    void place(e, { kind: 'history', order }, `Moved ${e.name} in the world’s history`)
  }

  const marker = (s: TimelineStop | undefined, kind: string) =>
    s && (
      <button
        className={`timeline-marker ${kind} ${stop?.id === s.id ? 'current' : ''}`}
        aria-label={`Go to this moment`}
        title="Show the world at this moment"
        onClick={() => setStop(stop?.id === s.id ? null : s)}
      />
    )
  const stopOf = (id: string) => stops.find((s) => s.id === id)
  const where = (e: EntrySummary) => {
    const v = currentValue(e.facts['where'], null, world.positions)
    return v ? ` · ${valueLabel(world, v)}` : ''
  }
  const row = (id: string, draggable: boolean) => {
    const e = entry(id)
    if (!e) return null
    const era = e.template === 'era'
    const h = history.indexOf(id)
    return (
      <li
        key={id}
        className={`timeline-item ${era ? 'era' : 'event'} ${dropBefore === id ? 'drop-before' : ''}`}
        draggable={draggable}
        onDragStart={(ev) => {
          ev.dataTransfer.setData(DRAG, id)
          ev.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(ev) => {
          if (!ev.dataTransfer.types.includes(DRAG)) return
          ev.preventDefault()
          setDropBefore(id)
        }}
        onDragLeave={() => setDropBefore(null)}
        onDrop={(ev) => {
          const moved = ev.dataTransfer.getData(DRAG)
          setDropBefore(null)
          if (!moved) return
          ev.preventDefault()
          ev.stopPropagation()
          putBefore(moved, id)
        }}
      >
        {marker(stopOf(id), era ? 'era' : 'event')}
        <button className="link timeline-name" onClick={() => props.onOpenEntry(id)}>
          {e.name}
        </button>
        <span className="muted small">
          {era ? 'Era' : 'Event'}
          {where(e)}
        </span>
        {h >= 0 && (
          <span className="timeline-nudge">
            <button
              className="icon small"
              aria-label={`Move ${e.name} earlier`}
              disabled={h === 0}
              onClick={() => putBefore(id, history[h - 1]!)}
            >
              ↑
            </button>
            <button
              className="icon small"
              aria-label={`Move ${e.name} later`}
              disabled={h === history.length - 1}
              onClick={() => putBefore(id, history[h + 2] ?? null)}
            >
              ↓
            </button>
          </span>
        )}
      </li>
    )
  }

  const timedCount = world.view.entries.filter((e) => lensOf(world, e) === 'when').length
  if (!timedCount) {
    return (
      <p className="muted">
        No eras or events yet. Add one with “+ New era or event”, then place it here: before the
        story, or during a chapter.
      </p>
    )
  }
  const storyRows = chapters.filter((c) => during.get(c.id)?.length)

  return (
    <div className="timeline-view">
      <TimeScrubber world={world} />
      <section aria-label="Before the story">
        <h2>Before the story</h2>
        <ol
          className="timeline-list"
          onDragOver={(ev) => {
            if (ev.dataTransfer.types.includes(DRAG)) ev.preventDefault()
          }}
          onDrop={(ev) => {
            const moved = ev.dataTransfer.getData(DRAG)
            setDropBefore(null)
            if (moved) putBefore(moved, null)
          }}
        >
          {history.map((id) => row(id, true))}
          <li className="timeline-drop muted small">
            {history.length
              ? 'Drag to reorder; drop here to put something last, just before the story.'
              : 'Drag an era or event here to put it in the world’s history.'}
          </li>
        </ol>
      </section>
      <section aria-label="During the story">
        <h2>During the story</h2>
        {storyRows.length ? (
          <ol className="timeline-list">
            {storyRows.map((c) => (
              <li key={c.id} className="timeline-chapter">
                {marker(stopOf(c.id), 'chapter')}
                <span className="timeline-chapter-name">{chapterName(c)}</span>
                <ul>{during.get(c.id)!.map((id) => row(id, false))}</ul>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted small">
            Nothing placed in the story yet. On an event’s page, choose “During” a chapter.
          </p>
        )}
      </section>
      {unplaced.length > 0 && (
        <section aria-label="Not on the timeline yet">
          <h2>Not on the timeline yet</h2>
          <ul className="timeline-list">
            {unplaced.map((id) => {
              const e = entry(id)
              if (!e) return null
              return (
                <li
                  key={id}
                  className="timeline-item"
                  draggable
                  onDragStart={(ev) => ev.dataTransfer.setData(DRAG, id)}
                >
                  <button className="link timeline-name" onClick={() => props.onOpenEntry(id)}>
                    {e.name}
                  </button>
                  <select
                    aria-label={`Place ${e.name}`}
                    value=""
                    onChange={(ev) => {
                      const v = ev.target.value
                      if (v === 'history') putBefore(id, null)
                      else if (v) {
                        const c = chapters.find((x) => x.id === v)
                        void place(
                          e,
                          { kind: 'chapter', chapterId: v },
                          `Put ${e.name} during ${c?.label}`,
                        )
                      }
                    }}
                  >
                    <option value="">Place it…</option>
                    <option value="history">Before the story</option>
                    {chapters.map((c) => (
                      <option key={c.id} value={c.id}>
                        During {chapterName(c)}
                      </option>
                    ))}
                  </select>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}
