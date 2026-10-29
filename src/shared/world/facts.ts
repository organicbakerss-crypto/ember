/**
 * Facts that change over time. Each value says when it starts ("from chapter
 * 8", "from the Flood"); everything that shows a fact shows the value for a
 * chosen moment. Moments are positions on the timeline (see timeline.ts); a
 * value from an event that isn't on the timeline counts as already true.
 */
import type { FactAnchor, FactValue, TemplateField } from '../schema'

/**
 * A moment: a position on the timeline (chapters 0, 1, 2… in reading order;
 * history before the story is negative), or `null` for "now" (the latest chapter).
 */
export type Moment = number | null

/**
 * Positions on the timeline by id: chapters in reading order (across the
 * series that use the world), and eras and events once placed.
 */
export type ChapterPositions = ReadonlyMap<string, number>

/** Before everything: values "from the start", or from something not on the timeline. */
export const EARLIEST = -1e9

/** Where an anchor sits in time; one not on the timeline (or none) counts as the start. */
export function anchorPosition(anchor: FactAnchor | null, positions: ChapterPositions): number {
  if (!anchor) return EARLIEST
  return positions.get(anchor.kind === 'chapter' ? anchor.chapterId : anchor.entryId) ?? EARLIEST
}

/** Whether something anchored here has happened by a moment. */
export function reached(anchor: FactAnchor | null, at: Moment, positions: ChapterPositions) {
  return at === null || anchorPosition(anchor, positions) <= at
}

function applies(value: FactValue, at: Moment, positions: ChapterPositions): boolean {
  return reached(value.from, at, positions)
}

function start(value: FactValue, positions: ChapterPositions): number {
  return anchorPosition(value.from, positions)
}

/** The single value in effect at a moment: the latest one that has started. */
export function currentValue(
  values: readonly FactValue[] | undefined,
  at: Moment,
  positions: ChapterPositions,
): FactValue | undefined {
  let best: FactValue | undefined
  let bestStart = -Infinity
  for (const value of values ?? []) {
    if (!applies(value, at, positions)) continue
    const s = start(value, positions)
    if (s >= bestStart) {
      best = value
      bestStart = s
    }
  }
  return best
}

/** The values of a field at a moment: all that have started (multiple fields), or the current one. */
export function valuesAt(
  field: Pick<TemplateField, 'multiple'>,
  values: readonly FactValue[] | undefined,
  at: Moment,
  positions: ChapterPositions,
): FactValue[] {
  if (field.multiple) return (values ?? []).filter((v) => applies(v, at, positions))
  const current = currentValue(values, at, positions)
  return current ? [current] : []
}

/** Values in time order (stable for values from the start or from events). */
export function inTimeOrder(
  values: readonly FactValue[],
  positions: ChapterPositions,
): FactValue[] {
  return values
    .map((value, index) => ({ value, index, start: start(value, positions) }))
    .sort((a, b) => a.start - b.start || a.index - b.index)
    .map((v) => v.value)
}

export function isEmptyValue(value: FactValue): boolean {
  return !value.link && !value.text?.trim()
}

export function sameAnchor(a: FactAnchor | null, b: FactAnchor | null): boolean {
  if (!a || !b) return a === b
  if (a.kind === 'chapter' && b.kind === 'chapter') return a.chapterId === b.chapterId
  if (a.kind === 'event' && b.kind === 'event') return a.entryId === b.entryId
  return false
}

/** Every entry an entry's facts link to, by field. */
export function factLinks(
  facts: Record<string, readonly FactValue[]>,
): { field: string; to: string }[] {
  const out: { field: string; to: string }[] = []
  for (const [field, values] of Object.entries(facts)) {
    for (const v of values) if (v.link) out.push({ field, to: v.link })
  }
  return out
}
