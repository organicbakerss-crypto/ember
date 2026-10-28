/** Map helpers for the views: which map is which, who is where, territory colours. */
import type { EntrySummary } from '@shared/ipc'
import type { MapFile } from '@shared/schema'
import { currentValue, type Moment } from '@shared/world/facts'
import { lensOf } from '../model'
import type { WorldData } from '../useWorld'

/** The world map: the first image map that isn't a map of a place. */
export function worldMapOf(world: WorldData): MapFile | undefined {
  return world.view.maps.find((m) => m.image && !m.placeId)
}

/** The travel sketch (one per world). */
export function sketchOf(world: WorldData): MapFile | undefined {
  return world.view.maps.find((m) => !m.image && !m.placeId)
}

/** A place's own map, if it has one. */
export function mapOfPlace(world: WorldData, placeId: string): MapFile | undefined {
  return world.view.maps.find((m) => m.image && m.placeId === placeId)
}

/** The map that shows a place as one of its regions (for breadcrumbs). */
export function parentMapOf(world: WorldData, placeId: string): MapFile | undefined {
  return world.view.maps.find((m) => m.image && m.regions.some((r) => r.placeId === placeId))
}

export function isPerson(world: WorldData, e: EntrySummary): boolean {
  return (
    lensOf(world, e) === 'who' &&
    (e.template === 'person' || !['faction', 'family'].includes(e.template))
  )
}

/** People whose location is this place at a moment. */
export function peopleAt(world: WorldData, placeId: string, at: Moment = null): EntrySummary[] {
  return world.view.entries.filter(
    (e) =>
      isPerson(world, e) &&
      currentValue(e.facts['location'], at, world.positions)?.link === placeId,
  )
}

/** People with no location yet (the unplaced tray). */
export function unplacedPeople(world: WorldData): EntrySummary[] {
  return world.view.entries.filter(
    (e) =>
      isPerson(world, e) &&
      e.template !== 'creature' &&
      !currentValue(e.facts['location'], null, world.positions)?.link,
  )
}

/** Who rules a place now (its "Ruled by"), for territory colours. */
export function rulerOf(world: WorldData, placeId: string): EntrySummary | undefined {
  const place = world.byId.get(placeId)
  const link = place && currentValue(place.facts['ruledBy'], null, world.positions)?.link
  return link ? world.resolve(link) : undefined
}

/** A stable colour per ruler, from the theme's cover palette. */
export function rulerColour(rulerId: string): string {
  let h = 0
  for (const ch of rulerId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `var(--cover-${h % 8})`
}
