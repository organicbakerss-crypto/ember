import type { SeriesSummary, WorldSummary } from '@shared/ipc'
import { api, describeError } from '../api'
import type { MenuItem } from './overlays'

/** A story is a single book when it was made as one and has (at most) one volume. */
export const isBook = (series: SeriesSummary) =>
  series.kind === 'book' && series.volumes.length <= 1

/**
 * The world a story uses, as a menu: pick one, none, or make one. Unlinking
 * only removes the link; the world stays on the shelf with everything in it.
 */
export function worldLinkMenu(
  series: SeriesSummary,
  worlds: WorldSummary[],
  toast: (message: string) => void,
): MenuItem {
  const current = worlds.find((w) => w.id === series.worldId)
  const link = async (worldId: string | null) => {
    try {
      await api.invoke('series:setWorld', { seriesId: series.id, worldId })
      if (!worldId && current) {
        toast(`No world for “${series.name}” now. “${current.name}” is still on your shelf.`)
      }
    } catch (err) {
      toast(describeError(err).message)
    }
  }
  return {
    label: current ? `World: ${current.name}` : 'World: none',
    submenu: [
      { label: 'No world', checked: !current, onSelect: () => void link(null) },
      ...worlds.map((w) => ({
        label: w.name,
        checked: w.id === series.worldId,
        onSelect: () => void link(w.id),
      })),
      {
        label: 'Create a world for this',
        onSelect: async () => {
          try {
            const world = await api.invoke('world:create', { name: `${series.name} world` })
            await link(world.id)
          } catch (err) {
            toast(describeError(err).message)
          }
        },
      },
    ],
  }
}
