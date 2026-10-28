/**
 * What the manuscript says about the world, found by exact name matching
 * only (no guessing): which chapters mention each entry, and its POV chapters.
 * Derived data: rebuilt locally, never synced.
 */
import type { FactValue } from '../schema'
import { currentValue, type ChapterPositions } from './facts'
import { LEFT_STATUS } from './templates'

/** A chapter in reading order across every series that uses the world. */
export interface StoryChapter {
  id: string
  seriesId: string
  volumeId: string
  /** "Ch 4", or "Interlude". */
  label: string
  title: string
  volumeName: string
}

export interface EntryMentions {
  /** Positions (in `chapters`) where the entry is mentioned, ascending. */
  chapters: number[]
  /** Mentions in each of those chapters. */
  counts: number[]
  /** Positions of chapters told from the entry's point of view. */
  pov: number[]
}

export interface WorldIndex {
  chapters: StoryChapter[]
  mentions: Record<string, EntryMentions>
}

export const chapterPositions = (index: Pick<WorldIndex, 'chapters'>): ChapterPositions =>
  new Map(index.chapters.map((c, i) => [c.id, i]))

/** A chapter's name for lists: "Ch 4: The Crossing". */
export function chapterName(chapter: StoryChapter): string {
  return chapter.title ? `${chapter.label}: ${chapter.title}` : chapter.label
}

/** Chapter labels in one volume: chapters are numbered, interludes are not. */
export function chapterLabels(types: ('chapter' | 'interlude')[]): string[] {
  let n = 0
  return types.map((t) => (t === 'interlude' ? 'Interlude' : `Ch ${++n}`))
}

/* ---------- presence (the Cast view groups) ---------- */

export type Presence = 'story' | 'waiting' | 'quiet' | 'left'

export const PRESENCE_LABELS: Record<Presence, string> = {
  story: 'In the story',
  waiting: 'Waiting in the wings',
  quiet: 'Gone quiet',
  left: 'Left the story',
}

export const DEFAULT_QUIET_AFTER = 10

/**
 * Where an entry stands in the story, from certain data only: marked dead or
 * departed; never mentioned; not mentioned in the last `quietAfter` chapters;
 * or in the story.
 */
export function presence(
  facts: Record<string, readonly FactValue[]>,
  mentions: EntryMentions | undefined,
  index: Pick<WorldIndex, 'chapters'>,
  quietAfter: number,
  positions: ChapterPositions = chapterPositions(index),
): Presence {
  const status = currentValue(facts['status'], null, positions)?.text
  if (status && LEFT_STATUS.test(status)) return 'left'
  const seen = [...(mentions?.chapters ?? []), ...(mentions?.pov ?? [])]
  if (!seen.length) return 'waiting'
  const last = Math.max(...seen)
  return last < index.chapters.length - quietAfter ? 'quiet' : 'story'
}

/** The last chapter an entry was mentioned in (or told from), if any. */
export function lastSeen(mentions: EntryMentions | undefined): number | null {
  const seen = [...(mentions?.chapters ?? []), ...(mentions?.pov ?? [])]
  return seen.length ? Math.max(...seen) : null
}

export function firstSeen(mentions: EntryMentions | undefined): number | null {
  const seen = [...(mentions?.chapters ?? []), ...(mentions?.pov ?? [])]
  return seen.length ? Math.min(...seen) : null
}
