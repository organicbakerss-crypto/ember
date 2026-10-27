import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
import { EditableText } from '../components/EditableText'
import { InlineCreate } from '../components/InlineCreate'
import { useOverlays, type MenuItem } from '../components/overlays'
import {
  chapterOrder,
  findContainer,
  fromContainers,
  isArcId,
  isChapterId,
  isListId,
  listId,
  moveChapterTo,
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
  /** The item being renamed inline (a chapter or arc id), shared so F2 can start it. */
  renamingId: string | null
  onRenamingChange: (id: string | null) => void
  onRenameChapter: (chapterId: string, title: string) => Promise<unknown>
  onTrashChapter: (chapterId: string) => void
  onDeleteArc: (arc: OutlineArc) => void
  /** Unfold this arc (e.g. clicked in the breadcrumb). */
  revealArcId: string | null
}

/** Arcs and chapters, reordered by drag-and-drop. Only outline.json changes. */
export function Binder(props: BinderProps) {
  const { view } = props
  const [containers, setContainers] = useState<Containers>(() => toContainers(view.outline))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [povFilter, setPovFilter] = useState<string>('')
  const collapsed = useCollapsed()
  const { openMenu } = useOverlays()

  const { revealArcId } = props
  const { setCollapsed } = collapsed
  useEffect(() => {
    if (revealArcId) setCollapsed(revealArcId, false)
  }, [revealArcId, setCollapsed])

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
  const saveArc = (arcId: string, patch: Partial<OutlineArc>) => {
    const items = view.outline.items.map((item) =>
      item.type === 'arc' && item.id === arcId ? { ...item, ...patch } : item,
    )
    void props.onSave({ ...view.outline, items })
  }
  const moveToArc = (chapterId: string, arcId: string | null) =>
    void props.onSave(fromContainers(view.outline, moveChapterTo(containers, chapterId, arcId)))

  const chapterMenu = (id: string): MenuItem[] => {
    const current = findContainer(containers, id)
    return [
      { label: 'Rename', hint: 'F2', onSelect: () => props.onRenamingChange(id) },
      {
        label: 'Move to arc',
        disabled: arcs.size === 0 && current === ROOT,
        submenu: [
          ...[...arcs.values()].map((arc) => ({
            label: arc.name,
            disabled: current === arc.id,
            onSelect: () => moveToArc(id, arc.id),
          })),
          {
            label: 'No arc (top level)',
            disabled: current === ROOT,
            onSelect: () => moveToArc(id, null),
          },
        ],
      },
      { label: 'Delete', danger: true, onSelect: () => props.onTrashChapter(id) },
    ]
  }
  const arcMenu = (arc: OutlineArc): MenuItem[] => [
    { label: 'Rename', hint: 'F2', onSelect: () => props.onRenamingChange(arc.id) },
    { label: 'Delete', danger: true, onSelect: () => props.onDeleteArc(arc) },
  ]
  const menu = (items: () => MenuItem[]) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openMenu(e, items())
  }

  const chapterRow = (id: string) => (
    <SortableChapter key={id} id={id} disabled={filtering} hidden={!visible(id)}>
      <ChapterRow
        meta={meta(id)}
        selected={id === props.selectedId}
        scenes={id === props.selectedId ? props.scenes : []}
        renaming={props.renamingId === id}
        onRenamingChange={(on) => props.onRenamingChange(on ? id : null)}
        onRename={(title) => props.onRenameChapter(id, title)}
        onSelect={() => props.onSelect(id)}
        onJump={props.onJump}
        onContextMenu={menu(() => chapterMenu(id))}
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
                        renaming={props.renamingId === id}
                        onRenamingChange={(on) => props.onRenamingChange(on ? id : null)}
                        onToggle={() => collapsed.setCollapsed(id, !folded)}
                        onRename={(name) => saveArc(id, { name })}
                        onFinished={(finished) => saveArc(id, { finished })}
                        onDelete={() => props.onDeleteArc(arc)}
                        onAddChapter={() => props.onCreateChapter(id)}
                        onContextMenu={menu(() => arcMenu(arc))}
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
  renaming: boolean
  onRenamingChange: (renaming: boolean) => void
  onToggle: () => void
  onRename: (name: string) => void
  onFinished: (finished: boolean) => void
  onDelete: () => void
  onAddChapter: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const { arc } = props
  return (
    <div
      className={`binder-arc-header ${arc.finished ? 'finished' : ''}`}
      onContextMenu={props.onContextMenu}
      data-arc-id={arc.id}
    >
      <button
        className="icon chevron"
        aria-label={props.folded ? 'Expand arc' : 'Collapse arc'}
        aria-expanded={!props.folded}
        onClick={props.onToggle}
      >
        {props.folded ? '▸' : '▾'}
      </button>
      <span
        className="binder-arc-name"
        title="Drag to move. Double-click to rename."
        {...(props.renaming ? {} : props.handle)}
      >
        {arc.finished && !props.renaming && <span aria-label="Finished">✓ </span>}
        <EditableText
          value={arc.name}
          editing={props.renaming}
          onEditingChange={props.onRenamingChange}
          onRename={props.onRename}
        />
        {props.folded && !props.renaming && <span className="muted small"> · {props.count}</span>}
      </span>
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
        <button className="icon" title="Delete arc" onClick={props.onDelete}>
          ✕
        </button>
      </span>
    </div>
  )
}

function ChapterRow(props: {
  meta: ChapterMeta
  selected: boolean
  scenes: Scene[]
  renaming: boolean
  onRenamingChange: (renaming: boolean) => void
  onRename: (title: string) => Promise<unknown>
  onSelect: () => void
  onJump: (pos: number) => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const { meta } = props
  return (
    <>
      <div
        className={`binder-row ${props.selected ? 'selected' : ''} ${meta.type}`}
        onClick={props.onSelect}
        onContextMenu={props.onContextMenu}
      >
        <EditableText
          className="binder-title"
          value={meta.title}
          placeholder="Untitled chapter"
          allowEmpty
          editing={props.renaming}
          onEditingChange={props.onRenamingChange}
          onRename={props.onRename}
        />
        {meta.type === 'interlude' && <span className="binder-tag">Interlude</span>}
        {meta.pov && <span className="binder-pov">{meta.pov}</span>}
      </div>
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
