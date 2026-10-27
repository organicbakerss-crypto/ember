import { useMemo, useState, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { OutlineView } from '@shared/ipc'
import type { OutlineArc, OutlineFile } from '@shared/schema'
import type { ChapterMeta } from '../editor/ChapterEditor'
import type { Scene } from '../editor/scenes'
import { InlineCreate } from '../components/InlineCreate'
import {
  chapterOrder,
  findContainer,
  fromContainers,
  isArcId,
  isChapterId,
  isListId,
  listId,
  moveItem,
  ROOT,
  toContainers,
  type Containers,
} from './model'
import { useCollapsed } from './useCollapsed'

interface BinderProps {
  volumeName: string
  view: OutlineView
  /** Live title/type/POV of the open chapter, ahead of what's on disk. */
  liveMeta: Record<string, ChapterMeta>
  selectedId: string | null
  scenes: Scene[]
  onSelect: (chapterId: string) => void
  onJump: (pos: number) => void
  onSave: (outline: OutlineFile) => Promise<void>
  onCreateChapter: (arcId?: string) => void
  onCreateArc: (name: string) => Promise<unknown>
}

/** Arcs and chapters, reordered by drag-and-drop. Only outline.json changes. */
export function Binder(props: BinderProps) {
  const { view } = props
  const [containers, setContainers] = useState<Containers>(() => toContainers(view.outline))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [povFilter, setPovFilter] = useState<string>('')
  const collapsed = useCollapsed()

  // Follow saved changes, except mid-drag (adjusting state while rendering, not in an effect).
  const [syncedOutline, setSyncedOutline] = useState(view.outline)
  if (syncedOutline !== view.outline && !activeId) {
    setSyncedOutline(view.outline)
    setContainers(toContainers(view.outline))
  }

  const meta = (id: string): ChapterMeta => {
    const live = props.liveMeta[id]
    const stored = view.chapters[id]
    return (
      live ?? {
        title: stored?.title ?? '',
        type: stored?.type ?? 'chapter',
        pov: stored?.pov ?? null,
      }
    )
  }
  const povs = useMemo(() => {
    const all = Object.keys(view.chapters).map((id) => meta(id).pov)
    return [...new Set(all.filter((p): p is string => !!p))].sort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.chapters, props.liveMeta])
  const filtering = povFilter !== ''
  const visible = (id: string) => !filtering || meta(id).pov === povFilter

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const rootIds = useMemo(() => new Set(containers[ROOT]), [containers])
  const collision: CollisionDetection = (args) => {
    const id = String(args.active.id)
    const candidates = args.droppableContainers.filter(
      (c) => c.id !== id && (!isArcId(id) || rootIds.has(String(c.id))),
    )
    if (isArcId(id)) return closestCenter({ ...args, droppableContainers: candidates })
    // For chapters, prefer the most specific thing under the pointer.
    const hits = pointerWithin({ ...args, droppableContainers: candidates })
    if (hits.length) {
      const rank = (hit: UniqueIdentifier) =>
        isChapterId(String(hit)) ? 0 : isListId(String(hit)) ? 1 : 2
      return [...hits].sort((a, b) => rank(a.id) - rank(b.id)).slice(0, 1)
    }
    return closestCenter({ ...args, droppableContainers: candidates })
  }

  const onDragStart = (e: DragStartEvent) => setActiveId(String(e.active.id))
  const onDragOver = (e: DragOverEvent) => {
    if (!e.over) return
    const active = String(e.active.id)
    const over = String(e.over.id)
    const from = findContainer(containers, active)
    const to = isListId(over)
      ? over.slice(5)
      : isArcId(over)
        ? ROOT
        : findContainer(containers, over)
    // Moves between containers happen live; reordering inside one happens on drop.
    if (from && to && from !== to) setContainers((c) => moveItem(c, active, over))
  }
  const onDragEnd = (e: DragEndEvent) => {
    const active = String(e.active.id)
    const final = e.over ? moveItem(containers, active, String(e.over.id)) : containers
    setActiveId(null)
    const before = toContainers(view.outline)
    if (sameLayout(before, final)) {
      setContainers(before)
      return
    }
    setContainers(final)
    void props.onSave(fromContainers(view.outline, final))
  }
  const onDragCancel = () => {
    setActiveId(null)
    setContainers(toContainers(view.outline))
  }

  const arcs = new Map<string, OutlineArc>()
  for (const item of view.outline.items) if (item.type === 'arc') arcs.set(item.id, item)
  const saveArc = (arcId: string, patch: Partial<OutlineArc> | null) => {
    const items: OutlineFile['items'] = []
    for (const item of view.outline.items) {
      if (item.type !== 'arc' || item.id !== arcId) items.push(item)
      else if (patch !== null) items.push({ ...item, ...patch })
    }
    void props.onSave({ ...view.outline, items })
  }

  const chapterRow = (id: string) => (
    <SortableChapter key={id} id={id} disabled={filtering} hidden={!visible(id)}>
      <ChapterRow
        meta={meta(id)}
        selected={id === props.selectedId}
        scenes={id === props.selectedId ? props.scenes : []}
        onSelect={() => props.onSelect(id)}
        onJump={props.onJump}
      />
    </SortableChapter>
  )

  return (
    <div className="binder">
      <header className="binder-header">
        <h2 title={props.volumeName}>{props.volumeName}</h2>
        {povs.length > 0 && (
          <select
            aria-label="Filter by POV"
            className="small"
            value={povFilter}
            onChange={(e) => setPovFilter(e.target.value)}
          >
            <option value="">All POVs</option>
            {povs.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
      </header>
      {filtering && <p className="muted small">Clear the POV filter to rearrange chapters.</p>}

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <SortableContext items={containers[ROOT] ?? []} strategy={verticalListSortingStrategy}>
          <ul className="binder-list">
            {(containers[ROOT] ?? []).map((id) => {
              const arc = arcs.get(id)
              if (!arc) return chapterRow(id)
              const folded = collapsed.isCollapsed(id, arc.finished) && activeId !== id
              const chapterIds = containers[id] ?? []
              return (
                <SortableArc key={id} id={id} disabled={filtering}>
                  {(handle) => (
                    <>
                      <ArcHeader
                        arc={arc}
                        count={chapterIds.length}
                        folded={folded}
                        handle={handle}
                        onToggle={() => collapsed.setCollapsed(id, !folded)}
                        onRename={(name) => saveArc(id, { name })}
                        onFinished={(finished) => saveArc(id, { finished })}
                        onDelete={chapterIds.length === 0 ? () => saveArc(id, null) : undefined}
                        onAddChapter={() => props.onCreateChapter(id)}
                      />
                      {!folded && (
                        <SortableContext items={chapterIds} strategy={verticalListSortingStrategy}>
                          <ArcList arcId={id} empty={chapterIds.length === 0}>
                            {chapterIds.map(chapterRow)}
                          </ArcList>
                        </SortableContext>
                      )}
                    </>
                  )}
                </SortableArc>
              )
            })}
          </ul>
        </SortableContext>
        <DragOverlay>
          {activeId && (
            <div className="binder-drag-preview">
              {isArcId(activeId)
                ? arcs.get(activeId)?.name
                : meta(activeId).title || 'Untitled chapter'}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {chapterOrder(containers).length === 0 && arcs.size === 0 && (
        <p className="muted small">No chapters yet.</p>
      )}
      <footer className="binder-footer">
        <button className="link" onClick={() => props.onCreateChapter()}>
          + Chapter
        </button>
        <InlineCreate label="Arc" placeholder="Arc name" onCreate={props.onCreateArc} />
      </footer>
    </div>
  )
}

function sameLayout(a: Containers, b: Containers): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].every((k) => (a[k] ?? []).join() === (b[k] ?? []).join())
}

/* ---------- rows ---------- */

type DragHandle = ReturnType<typeof useSortable>['listeners'] &
  ReturnType<typeof useSortable>['attributes']

function SortableArc(props: {
  id: string
  disabled: boolean
  children: (handle: DragHandle) => ReactNode
}) {
  const { setNodeRef, isDragging, transform, transition, attributes, listeners } = useSortable({
    id: props.id,
    disabled: props.disabled,
  })
  return (
    <li
      ref={setNodeRef}
      className={`binder-arc ${isDragging ? 'dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      {props.children({ ...attributes, ...listeners } as DragHandle)}
    </li>
  )
}

function SortableChapter(props: {
  id: string
  disabled: boolean
  hidden: boolean
  children: ReactNode
}) {
  const { setNodeRef, isDragging, transform, transition, attributes, listeners } = useSortable({
    id: props.id,
    disabled: props.disabled,
  })
  if (props.hidden) return null
  return (
    <li
      ref={setNodeRef}
      className={`binder-chapter ${isDragging ? 'dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      {props.children}
    </li>
  )
}

function ArcList(props: { arcId: string; empty: boolean; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: listId(props.arcId) })
  return (
    <ul ref={setNodeRef} className={`binder-arc-list ${isOver ? 'over' : ''}`}>
      {props.children}
      {props.empty && <li className="binder-empty muted small">Drop chapters here</li>}
    </ul>
  )
}

function ArcHeader(props: {
  arc: OutlineArc
  count: number
  folded: boolean
  handle: DragHandle
  onToggle: () => void
  onRename: (name: string) => void
  onFinished: (finished: boolean) => void
  onDelete?: () => void
  onAddChapter: () => void
}) {
  const { arc } = props
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(arc.name)

  const commit = () => {
    setRenaming(false)
    if (name.trim() && name.trim() !== arc.name) props.onRename(name.trim())
    else setName(arc.name)
  }

  return (
    <div className={`binder-arc-header ${arc.finished ? 'finished' : ''}`}>
      <button
        className="icon chevron"
        aria-label={props.folded ? 'Expand arc' : 'Collapse arc'}
        aria-expanded={!props.folded}
        onClick={props.onToggle}
      >
        {props.folded ? '▸' : '▾'}
      </button>
      {renaming ? (
        <input
          autoFocus
          className="binder-rename"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setName(arc.name)
              setRenaming(false)
            }
          }}
        />
      ) : (
        <span
          className="binder-arc-name"
          title="Drag to move. Double-click to rename."
          onDoubleClick={() => setRenaming(true)}
          {...props.handle}
        >
          {arc.finished && <span aria-label="Finished">✓ </span>}
          {arc.name}
          {props.folded && <span className="muted small"> · {props.count}</span>}
        </span>
      )}
      <span className="binder-arc-actions">
        <button className="icon" title="Add a chapter to this arc" onClick={props.onAddChapter}>
          +
        </button>
        <button
          className="icon"
          title={arc.finished ? 'Mark as not finished' : 'Mark as finished'}
          onClick={() => props.onFinished(!arc.finished)}
        >
          ✓
        </button>
        <button className="icon" title="Rename" onClick={() => setRenaming(true)}>
          ✎
        </button>
        {props.onDelete && (
          <button className="icon" title="Delete this empty arc" onClick={props.onDelete}>
            ✕
          </button>
        )}
      </span>
    </div>
  )
}

function ChapterRow(props: {
  meta: ChapterMeta
  selected: boolean
  scenes: Scene[]
  onSelect: () => void
  onJump: (pos: number) => void
}) {
  const { meta } = props
  return (
    <>
      <button
        className={`binder-row ${props.selected ? 'selected' : ''} ${meta.type}`}
        onClick={props.onSelect}
      >
        <span className="binder-title">{meta.title || 'Untitled chapter'}</span>
        {meta.type === 'interlude' && <span className="binder-tag">Interlude</span>}
        {meta.pov && <span className="binder-pov">{meta.pov}</span>}
      </button>
      {props.scenes.length > 1 && (
        <ol className="binder-scenes">
          {props.scenes.map((scene, i) => (
            <li key={scene.pos}>
              <button className="binder-scene" onClick={() => props.onJump(scene.pos)}>
                <span className="muted">§{i + 1}</span> {scene.label || 'Empty scene'}
              </button>
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
