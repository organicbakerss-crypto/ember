/**
 * Where a pane is: the writing view of a volume (at a chapter), or a world
 * (at an entry). Panes sit side by side in a window (split screen) or in a
 * window of their own (torn off); a torn-off window opens at its pane's
 * route, carried in the window's address.
 */
import { z } from 'zod'
import { id } from './schema'

export const paneRouteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('write'),
    seriesId: id('series'),
    volumeId: id('volume'),
    chapterId: id('chapter').optional(),
  }),
  z.object({
    kind: z.literal('world'),
    worldId: id('world'),
    entryId: id('entry').optional(),
  }),
  /** The AI, for a story (it reads from that story's writing view). */
  z.object({
    kind: z.literal('ai'),
    seriesId: id('series'),
    volumeId: id('volume'),
  }),
])
export type PaneRoute = z.infer<typeof paneRouteSchema>

const PANE_PREFIX = '#pane='

/** The address fragment that opens a window at a pane's route. */
export function paneHash(route: PaneRoute): string {
  return `${PANE_PREFIX}${encodeURIComponent(JSON.stringify(route))}`
}

/** The pane route in a window's address, if it was opened as a torn-off pane. */
export function paneFromHash(hash: string): PaneRoute | null {
  if (!hash.startsWith(PANE_PREFIX)) return null
  try {
    const parsed = paneRouteSchema.safeParse(
      JSON.parse(decodeURIComponent(hash.slice(PANE_PREFIX.length))),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * A document only one place may edit at a time (a chapter, an entry's page).
 * Other places show it read-only, kept live, with a way to take it over.
 */
export const docKeySchema = z.string().regex(/^(chapter|entry):[a-z]{2,8}_[0-9a-z]{4,40}$/)
export type DocKey = z.infer<typeof docKeySchema>
