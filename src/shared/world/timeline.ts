/**
 * The world's timeline: eras and events from its history, then the story's
 * chapters in reading order, with events placed during them. Every era,
 * event and chapter gets a position on one number line, so "from the Flood"
 * and "from Ch 8" can be compared, and the time scrubber can stop at each.
 *
 * History sits before the story (negative positions); chapters are 0, 1, 2…
 * in reading order; an event during a chapter shares that chapter's position.
 * Eras and events that aren't placed have no position (their facts count as
 * already true).
 */
import type { FactAnchor, TimelinePlace } from '../schema'
import type { ChapterPositions, Moment } from './facts'

export interface TimelineEntry {
  id: string
  template: string
  when: TimelinePlace | null
}

export interface TimelineStop {
  kind: 'chapter' | 'event' | 'era'
  /** A chapter id, or the era's or event's entry id. */
  id: string
  position: number
}

export interface Timeline {
  /** Chapters and placed eras and events, by id. */
  positions: ChapterPositions
  /** Every stop in time order: history first, then each chapter followed by its events. */
  stops: TimelineStop[]
  /** Each placed era, from its own position up to the next era (or past the end). */
  eras: { id: string; start: number; end: number }[]
  /** Eras and events before the story, in order. */
  history: string[]
  /** Eras and events placed during each chapter, by chapter id. */
  during: Map<string, string[]>
  /** Eras and events not on the timeline yet. */
  unplaced: string[]
}

export const isEra = (e: Pick<TimelineEntry, 'template'>) => e.template === 'era'

/**
 * Builds the timeline. `timed` are the entries that can be placed (eras and
 * events); `chapters` are in reading order.
 */
export function buildTimeline(
  timed: readonly TimelineEntry[],
  chapters: readonly { id: string }[],
): Timeline {
  const chapterAt = new Map(chapters.map((c, i) => [c.id, i]))
  const history = timed
    .filter((e) => e.when?.kind === 'history')
    .sort((a, b) => order(a) - order(b) || a.id.localeCompare(b.id))
  const during = new Map<string, string[]>()
  const unplaced: string[] = []
  for (const e of timed) {
    if (e.when?.kind === 'chapter' && chapterAt.has(e.when.chapterId)) {
      during.set(e.when.chapterId, [...(during.get(e.when.chapterId) ?? []), e.id])
    } else if (e.when?.kind !== 'history') unplaced.push(e.id)
  }
  const positions = new Map<string, number>()
  const stops: TimelineStop[] = []
  const kindOf = new Map(timed.map((e) => [e.id, isEra(e) ? ('era' as const) : ('event' as const)]))
  history.forEach((e, i) => {
    const position = i - history.length
    positions.set(e.id, position)
    stops.push({ kind: kindOf.get(e.id)!, id: e.id, position })
  })
  chapters.forEach((c, i) => {
    positions.set(c.id, i)
    stops.push({ kind: 'chapter', id: c.id, position: i })
    for (const id of during.get(c.id) ?? []) {
      positions.set(id, i)
      stops.push({ kind: kindOf.get(id)!, id, position: i })
    }
  })
  const last = stops.length ? stops[stops.length - 1]!.position : 0
  const eraStops = stops.filter((s) => s.kind === 'era')
  const eras = eraStops.map((s, i) => {
    const next = eraStops.slice(i + 1).find((n) => n.position > s.position)
    return { id: s.id, start: s.position, end: next ? next.position : last + 1 }
  })
  return { positions, stops, eras, history: history.map((e) => e.id), during, unplaced }
}

function order(e: TimelineEntry): number {
  return e.when?.kind === 'history' ? e.when.order : 0
}

/** An order that puts an item between two others in history (either may be missing). */
export function orderBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return 0
  if (before === undefined) return after! - 1
  if (after === undefined) return before + 1
  return (before + after) / 2
}

/** The anchor a fact or relationship gets when recorded at a stop ("from Ch 8", "from the Flood"). */
export function anchorOf(stop: TimelineStop): FactAnchor {
  return stop.kind === 'chapter'
    ? { kind: 'chapter', chapterId: stop.id }
    : { kind: 'event', entryId: stop.id }
}

/** The era a moment falls in, if any. */
export function eraAt(timeline: Pick<Timeline, 'eras'>, at: Moment): string | undefined {
  if (at === null) return timeline.eras[timeline.eras.length - 1]?.id
  return [...timeline.eras].reverse().find((e) => e.start <= at && at < e.end)?.id
}

/** Timeline positions for a world: its chapters, and the eras and events placed on it. */
export function timelinePositions(
  entries: readonly (Pick<TimelineEntry, 'id' | 'template'> & { when?: TimelinePlace | null })[],
  index: { chapters: readonly { id: string }[] },
): ChapterPositions {
  const timed = entries
    .filter((e) => e.when)
    .map((e) => ({ id: e.id, template: e.template, when: e.when ?? null }))
  return buildTimeline(timed, index.chapters).positions
}
