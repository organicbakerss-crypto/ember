/** Words for moments on the timeline, for the scrubber and notes. */
import type { TimelineStop } from '@shared/world/timeline'
import { chapterName } from '@shared/world/story'
import type { WorldData } from '../useWorld'

/** "Ch 8: The Crossing", "The Flood", "Age of Ash begins". */
export function stopLabel(world: WorldData, stop: TimelineStop): string {
  if (stop.kind === 'chapter') {
    const chapter = world.index?.chapters.find((c) => c.id === stop.id)
    return chapter ? chapterName(chapter) : 'A chapter'
  }
  const name = world.resolve(stop.id)?.name ?? 'An event'
  return stop.kind === 'era' ? `${name} begins` : name
}

/** Short words for a stop, for "from …" and notices: "Ch 8", "the Flood". */
export function stopShort(world: WorldData, stop: TimelineStop): string {
  if (stop.kind === 'chapter') {
    return world.index?.chapters.find((c) => c.id === stop.id)?.label ?? 'that chapter'
  }
  return world.resolve(stop.id)?.name ?? 'that event'
}

/** "Now (Ch 12)": the latest chapter, which "now" stands for (a skin may say "Live"). */
export function nowLabel(world: WorldData, now = 'Now'): string {
  const last = world.index?.chapters[world.index.chapters.length - 1]
  return last ? `${now} (${last.label})` : now
}

/** Whether portraits should glide and leave trails (setting, lighter mode, reduced motion). */
export function motionAllowed(settings: { trails: boolean; lighter: boolean }): boolean {
  if (!settings.trails || settings.lighter) return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}
