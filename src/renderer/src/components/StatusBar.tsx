import { useState, type FormEvent, type ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { VolumeSummary } from '@shared/ipc'
import type { TextStats } from '@shared/analysis'
import { STATUS_ITEMS, type StatusItem } from '@shared/settings'
import { api, describeError } from '../api'
import { STATUS_LABELS, STATUS_SHORT, formatWords, type StatKey } from '../analysisFormat'
import type { SaveState } from '../editor/useChapterSaver'
import { useSettings } from '../useTheme'
import { useOverlays } from './overlays'

/**
 * The status bar. Right-click to choose what it shows; drag items to
 * reorder them. It is the only place save (and later sync) status appears.
 */
export function StatusBar(props: {
  seriesId: string
  volume: VolumeSummary
  chapterWords: number | null
  sessionWords: number
  projectWords: number
  /** Current chapter's statistics (for the optional stat items). */
  chapterStats: TextStats | null
  saveState: SaveState
  saveError: string | null
  onOpenDiagnostics: () => void
}) {
  const { settings, update } = useSettings()
  const { openMenu } = useOverlays()
  const items = settings.statusBar
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const toggle = (item: StatusItem) =>
    update(({ statusBar }) => ({
      statusBar: statusBar.includes(item)
        ? statusBar.filter((i) => i !== item)
        : [...statusBar, item],
    }))

  const menu = (e: React.MouseEvent) => {
    e.preventDefault()
    openMenu(e, [
      ...STATUS_ITEMS.map((item) => ({
        label: STATUS_LABELS[item],
        checked: items.includes(item),
        keepOpen: true,
        onSelect: () => toggle(item),
      })),
      { label: 'Open Diagnostics', onSelect: props.onOpenDiagnostics },
    ])
  }

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = items.indexOf(e.active.id as StatusItem)
    const to = items.indexOf(e.over.id as StatusItem)
    update({ statusBar: arrayMove(items, from, to) })
  }

  const render = (item: StatusItem): ReactNode => {
    switch (item) {
      case 'chapterWords':
        return props.chapterWords === null ? null : `Chapter ${formatWords(props.chapterWords)}`
      case 'sessionWords':
        return `Session ${props.sessionWords > 0 ? '+' : ''}${formatWords(props.sessionWords)}`
      case 'projectWords':
        return `Project ${formatWords(props.projectWords)}`
      case 'goals':
        return <Goals {...props} />
      case 'sync':
        return (
          <span className={props.saveState === 'error' ? 'error' : 'muted'} role="status">
            {props.saveState === 'error'
              ? `Not saved: ${props.saveError} (retrying)`
              : SAVE_LABELS[props.saveState]}
          </span>
        )
      default:
        return props.chapterStats ? (
          <button
            className="link status-stat"
            title="Open Diagnostics"
            onClick={props.onOpenDiagnostics}
          >
            {STATUS_SHORT[item as StatKey](props.chapterStats)}
          </button>
        ) : null
    }
  }

  return (
    <footer
      className="status-bar small"
      onContextMenu={menu}
      title="Right-click to choose what shows here"
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items} strategy={horizontalListSortingStrategy}>
          {items.map((item) => (
            <SortableItem key={item} id={item} push={item === 'sync'}>
              {render(item)}
            </SortableItem>
          ))}
        </SortableContext>
      </DndContext>
      {items.length === 0 && <span className="muted">Right-click to choose what shows here.</span>}
    </footer>
  )
}

const SAVE_LABELS: Record<Exclude<SaveState, 'error'>, string> = {
  saved: 'Saved',
  unsaved: 'Editing…',
  saving: 'Saving…',
}

function SortableItem(props: { id: string; push: boolean; children: ReactNode }) {
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id: props.id,
  })
  return (
    <span
      ref={setNodeRef}
      className={`status-item ${props.push ? 'push' : ''} ${isDragging ? 'dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      tabIndex={-1}
      role="presentation"
    >
      {props.children}
    </span>
  )
}

function Goals(props: {
  seriesId: string
  volume: VolumeSummary
  sessionWords: number
  projectWords: number
}) {
  const { goals } = props.volume
  const [editing, setEditing] = useState(false)
  return (
    <span className="goal-anchor">
      {goals.sessionWords ? (
        <Progress label="Session" value={props.sessionWords} goal={goals.sessionWords} />
      ) : null}
      {goals.projectWords ? (
        <Progress label="Project" value={props.projectWords} goal={goals.projectWords} />
      ) : null}
      <button className="link small" onClick={() => setEditing((v) => !v)}>
        {goals.sessionWords || goals.projectWords ? 'Goals' : 'Set goals'}
      </button>
      {editing && (
        <GoalsForm
          seriesId={props.seriesId}
          volume={props.volume}
          onDone={() => setEditing(false)}
        />
      )}
    </span>
  )
}

function Progress(props: { label: string; value: number; goal: number }) {
  const ratio = Math.max(0, Math.min(1, props.value / props.goal))
  return (
    <span
      className={`progress ${ratio >= 1 ? 'done' : ''}`}
      title={`${props.label} goal: ${Math.round(ratio * 100)}%`}
    >
      {props.label} {Math.max(0, props.value).toLocaleString()} / {formatWords(props.goal)}
      <span className="progress-track" aria-hidden>
        <span className="progress-fill" style={{ width: `${ratio * 100}%` }} />
      </span>
    </span>
  )
}

function GoalsForm(props: { seriesId: string; volume: VolumeSummary; onDone: () => void }) {
  const { goals } = props.volume
  const [session, setSession] = useState(goals.sessionWords?.toString() ?? '')
  const [project, setProject] = useState(goals.projectWords?.toString() ?? '')
  const [error, setError] = useState<string | null>(null)

  const parse = (value: string) => {
    const v = Number.parseInt(value.replace(/[^\d]/g, ''), 10)
    return Number.isFinite(v) && v > 0 ? v : null
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    try {
      await api.invoke('volume:update', {
        seriesId: props.seriesId,
        volumeId: props.volume.id,
        goals: { sessionWords: parse(session), projectWords: parse(project) },
      })
      props.onDone()
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <form
      className="goals-form card stack"
      onSubmit={(e) => void submit(e)}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <label>
        Session goal (words)
        <input
          inputMode="numeric"
          value={session}
          placeholder="None"
          onChange={(e) => setSession(e.target.value)}
        />
      </label>
      <label>
        Project goal for {props.volume.name} (words)
        <input
          inputMode="numeric"
          value={project}
          placeholder="None"
          onChange={(e) => setProject(e.target.value)}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" type="submit">
          Save
        </button>
        <button type="button" onClick={props.onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}
