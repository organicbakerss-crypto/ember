/** Map helpers for the views: which map is which, who is where, territory colours. */
import type { EntrySummary } from '@shared/ipc'
import type { MapFile } from '@shared/schema'
import {
  anchorPosition,
  currentValue,
  inTimeOrder,
  reached,
  type Moment,
} from '@shared/world/facts'
import { baseMaps, mapAt } from '@shared/world/maps'
import { lensOf } from '../model'
import type { WorldData } from '../useWorld'

/*
 * Maps here are "base" maps (the world map, maps of places); each may have
 * later versions from events onwards. Views show the version in effect at
 * the world's moment (`shownMap`).
 */

/** The world map: the first image map that isn't a map of a place. */
export function worldMapOf(world: WorldData): MapFile | undefined {
  return baseMaps(world.view.maps).find((m) => m.image && !m.placeId)
}

/** The travel sketch (one per world). */
export function sketchOf(world: WorldData): MapFile | undefined {
  return baseMaps(world.view.maps).find((m) => !m.image && !m.placeId)
}

/** A place's own map, if it has one. */
export function mapOfPlace(world: WorldData, placeId: string): MapFile | undefined {
  return baseMaps(world.view.maps).find((m) => m.image && m.placeId === placeId)
}

/** The version of a map in effect at the world's moment. */
export function shownMap(world: WorldData, base: MapFile): MapFile {
  return mapAt(world.view.maps, base, world.at, world.positions)
}

/** The map a version belongs to (itself when it isn't a version). */
export function baseOf(world: WorldData, map: MapFile): MapFile {
  return (map.versionOf && world.view.maps.find((m) => m.id === map.versionOf)) || map
}

/** The map that shows a place as one of its regions (for breadcrumbs). */
export function parentMapOf(world: WorldData, placeId: string): MapFile | undefined {
  return baseMaps(world.view.maps).find(
    (m) => m.image && shownMap(world, m).regions.some((r) => r.placeId === placeId),
  )
}

export function isPerson(world: WorldData, e: EntrySummary): boolean {
  return (
    lensOf(world, e) === 'who' &&
    (e.template === 'person' || !['faction', 'family'].includes(e.template))
  )
}

/** People whose location is this place at a moment (the world's, unless given). */
export function peopleAt(world: WorldData, placeId: string, at: Moment = world.at): EntrySummary[] {
  return world.view.entries.filter(
    (e) =>
      isPerson(world, e) &&
      currentValue(e.facts['location'], at, world.positions)?.link === placeId,
  )
}

/**
 * A person's latest move, if it just happened (at the world's moment or the
 * stop before): where from and where to. Drawn as a faint trail.
 */
export function lastMove(
  world: WorldData,
  person: EntrySummary,
): { from: string; to: string } | null {
  const applied = inTimeOrder(person.facts['location'] ?? [], world.positions).filter(
    (v) => v.link && reached(v.from, world.at, world.positions),
  )
  const current = applied[applied.length - 1]
  const previous = [...applied].reverse().find((v) => v.link !== current?.link)
  if (!current || !previous) return null
  const now = world.at ?? (world.index?.chapters.length ?? 1) - 1
  if (anchorPosition(current.from, world.positions) < now - 1) return null
  return { from: previous.link!, to: current.link! }
}

/** Events (with a "Where") that have happened by the world's moment; unplaced ones count. */
export function eventsShown(world: WorldData): { event: EntrySummary; placeId: string }[] {
  const out: { event: EntrySummary; placeId: string }[] = []
  for (const e of world.view.entries) {
    if (lensOf(world, e) !== 'when' || e.template === 'era') continue
    const position = world.positions.get(e.id)
    if (world.at !== null && position !== undefined && position > world.at) continue
    const where = currentValue(e.facts['where'], world.at, world.positions)?.link
    if (where) out.push({ event: e, placeId: where })
  }
  return out
}

/** People with no location yet (the unplaced tray). */
export function unplacedPeople(world: WorldData): EntrySummary[] {
  return world.view.entries.filter(
    (e) =>
      isPerson(world, e) &&
      e.template !== 'creature' &&
      !currentValue(e.facts['location'], world.at, world.positions)?.link,
  )
}

/** Who rules a place at the world's moment (its "Ruled by"), for territory colours. */
export function rulerOf(world: WorldData, placeId: string): EntrySummary | undefined {
  const place = world.byId.get(placeId)
  const link = place && currentValue(place.facts['ruledBy'], world.at, world.positions)?.link
  return link ? world.resolve(link) : undefined
}

/** A stable colour per ruler, from the theme's cover palette. */
export function rulerColour(rulerId: string): string {
  let h = 0
  for (const ch of rulerId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `var(--cover-${h % 8})`
}

/** The place a place is within at the world's moment (its "Within"), if any. */
function parentOf(world: WorldData, placeId: string): string | undefined {
  const place = world.resolve(placeId)
  return place ? currentValue(place.facts['within'], world.at, world.positions)?.link : undefined
}

/** A place and everything it is within, nearest first (stops at loops). */
export function withinChain(world: WorldData, placeId: string): string[] {
  const chain: string[] = []
  for (
    let id = parentOf(world, placeId);
    id && !chain.includes(id) && id !== placeId;
    id = parentOf(world, id)
  ) {
    chain.push(id)
  }
  return chain
}

export interface PinBarGroup {
  /** The region (its place) these places are within; null for "Unsorted". */
  region: EntrySummary | null
  entries: { entry: EntrySummary; suggest?: EntrySummary }[]
}

/**
 * Places that belong on a map but aren't on it yet, grouped by the region of
 * this map they are within. Places already on the map (as a region or a
 * pin), on a map of one of its regions, or the map's own place are left out.
 * An unsorted place whose page mentions one of the map's regions gets that
 * region as a suggestion (never applied on its own).
 */
export function pinBarGroups(world: WorldData, map: MapFile): PinBarGroup[] {
  const regionPlaces = new Set(map.regions.map((r) => r.placeId).filter((id): id is string => !!id))
  const onThisMap = new Set([...regionPlaces, ...map.pins.map((p) => p.placeId)])
  // Places already on a map inside this one (a region's own map).
  const onInnerMaps = new Set(
    baseMaps(world.view.maps)
      .filter((m) => m.placeId && regionPlaces.has(m.placeId))
      .map((m) => shownMap(world, m))
      .flatMap((m) => [...m.regions.map((r) => r.placeId), ...m.pins.map((p) => p.placeId)])
      .filter((id): id is string => !!id),
  )
  const groups = new Map<string | null, PinBarGroup>()
  for (const entry of world.view.entries) {
    if (lensOf(world, entry) !== 'where') continue
    if (entry.id === map.placeId || onThisMap.has(entry.id) || onInnerMaps.has(entry.id)) continue
    const chain = withinChain(world, entry.id)
    // A map of a place only shows what is within that place.
    if (map.placeId && !chain.includes(map.placeId)) continue
    const regionId = chain.find((id) => regionPlaces.has(id)) ?? null
    const region = regionId ? (world.resolve(regionId) ?? null) : null
    const key = region?.id ?? null
    const group = groups.get(key) ?? { region, entries: [] }
    const suggestId =
      !region && !parentOf(world, entry.id)
        ? entry.links.find((id) => regionPlaces.has(id))
        : undefined
    group.entries.push({ entry, suggest: suggestId ? world.resolve(suggestId) : undefined })
    groups.set(key, group)
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      entries: g.entries.sort((a, b) => a.entry.name.localeCompare(b.entry.name)),
    }))
    .sort((a, b) => (!a.region ? 1 : !b.region ? -1 : a.region.name.localeCompare(b.region.name)))
}

/** A pin's colour by the kind of place. */
export function pinColour(template: string): string {
  switch (template) {
    case 'city':
      return 'var(--accent)'
    case 'district':
      return 'var(--cover-2)'
    case 'landmark':
      return 'var(--cover-4)'
    case 'wilds':
      return 'var(--cover-1)'
    default:
      return 'var(--cover-7)'
  }
}
