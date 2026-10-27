/**
 * The binder's drag-and-drop model. The outline is treated as containers:
 * `root` holds arcs and loose chapters in order, and each arc holds its
 * chapters. Arcs only live in `root`; chapters can move anywhere.
 */
import type { OutlineArc, OutlineFile } from '@shared/schema'

export const ROOT = 'root'
export type Containers = Record<string, string[]>

/** Droppable id for an arc's chapter list (so empty arcs accept drops). */
export const listId = (arcId: string) => `list:${arcId}`
export const isListId = (id: string) => id.startsWith('list:')
export const isArcId = (id: string) => id.startsWith('arc_')
export const isChapterId = (id: string) => id.startsWith('chp_')

export function toContainers(outline: OutlineFile): Containers {
  const containers: Containers = { [ROOT]: [] }
  for (const item of outline.items) {
    containers[ROOT]!.push(item.id)
    if (item.type === 'arc') containers[item.id] = [...item.chapterIds]
  }
  return containers
}

/** Builds outline items back from containers, keeping every arc's other fields. */
export function fromContainers(outline: OutlineFile, containers: Containers): OutlineFile {
  const arcs = new Map<string, OutlineArc>()
  for (const item of outline.items) if (item.type === 'arc') arcs.set(item.id, item)
  const items: OutlineFile['items'] = (containers[ROOT] ?? []).map((id) => {
    const arc = arcs.get(id)
    return arc
      ? { ...arc, chapterIds: [...(containers[id] ?? [])] }
      : { type: 'chapter' as const, id }
  })
  return { ...outline, items }
}

export function findContainer(containers: Containers, id: string): string | undefined {
  if (id === ROOT || id in containers) return isArcId(id) ? ROOT : id
  if (isListId(id)) return id.slice('list:'.length)
  return Object.keys(containers).find((key) => containers[key]!.includes(id))
}

/**
 * Where an item would land if dropped over `overId`: the container and the
 * index in it. Returns null if the move isn't allowed (an arc into an arc).
 */
export function dropTarget(
  containers: Containers,
  activeId: string,
  overId: string,
): { container: string; index: number } | null {
  if (isArcId(activeId)) {
    // Arcs reorder within the root only; hovering inside an arc means "at that arc".
    const overRoot = isListId(overId)
      ? overId.slice('list:'.length)
      : isArcId(overId) || containers[ROOT]!.includes(overId)
        ? overId
        : findContainer(containers, overId)
    if (!overRoot) return null
    const index = containers[ROOT]!.indexOf(overRoot === ROOT ? activeId : overRoot)
    return index < 0 ? null : { container: ROOT, index }
  }
  if (isListId(overId)) {
    const arcId = overId.slice('list:'.length)
    return { container: arcId, index: containers[arcId]?.length ?? 0 }
  }
  if (isArcId(overId)) {
    // Over an arc's header: the chapter sits at the root, where the arc is.
    return { container: ROOT, index: containers[ROOT]!.indexOf(overId) }
  }
  const container = findContainer(containers, overId)
  if (!container) return null
  return { container, index: containers[container]!.indexOf(overId) }
}

/** Moves an item; returns the same object when nothing changes. */
export function moveItem(containers: Containers, activeId: string, overId: string): Containers {
  if (activeId === overId) return containers
  const from = findContainer(containers, activeId)
  const target = dropTarget(containers, activeId, overId)
  if (!from || !target || target.index < 0) return containers
  const fromIndex = containers[from]!.indexOf(activeId)
  if (from === target.container && fromIndex === target.index) return containers

  const next: Containers = { ...containers }
  next[from] = containers[from]!.filter((id) => id !== activeId)
  const list = from === target.container ? next[from]! : [...containers[target.container]!]
  list.splice(target.index, 0, activeId)
  next[target.container] = list
  return next
}

/** Every chapter id in reading order. */
export function chapterOrder(containers: Containers): string[] {
  return (containers[ROOT] ?? []).flatMap((id) => (isArcId(id) ? (containers[id] ?? []) : [id]))
}

/** Moves a chapter to the end of an arc, or to the end of the top level when `arcId` is null. */
export function moveChapterTo(
  containers: Containers,
  chapterId: string,
  arcId: string | null,
): Containers {
  const from = findContainer(containers, chapterId)
  const to = arcId ?? ROOT
  if (!from || !(to in containers) || from === to) return containers
  return {
    ...containers,
    [from]: containers[from]!.filter((id) => id !== chapterId),
    [to]: [...containers[to]!, chapterId],
  }
}
