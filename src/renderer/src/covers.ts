import type { SeriesSummary, VolumeSummary, WorldSummary } from '@shared/ipc'
import type { CoverSource } from './components/Cover'

/** A volume's cover. Without its own image it shows the series cover, then a placeholder. */
export function volumeCover(series: SeriesSummary, volume: VolumeSummary): CoverSource {
  const own = { kind: 'volume' as const, seriesId: series.id, volumeId: volume.id }
  const subtitle = volume.name === series.name ? undefined : series.name
  const base = { title: volume.name, subtitle, seed: volume.id }
  if (volume.cover) return { ...base, target: own, cover: volume.cover }
  if (series.cover) {
    return { ...base, target: { kind: 'series', seriesId: series.id }, cover: series.cover }
  }
  return { ...base, target: own, cover: null }
}

export function seriesCover(series: SeriesSummary): CoverSource {
  return {
    target: { kind: 'series', seriesId: series.id },
    cover: series.cover,
    title: series.name,
    seed: series.id,
  }
}

/** The deck shown on the bookshelf: latest volume on top. */
export function seriesStack(series: SeriesSummary): CoverSource[] {
  if (series.volumes.length === 0) return [seriesCover(series)]
  return [...series.volumes].reverse().map((volume) => volumeCover(series, volume))
}

export function worldCover(world: WorldSummary): CoverSource {
  return {
    target: { kind: 'world', worldId: world.id },
    cover: world.cover,
    title: world.name,
    seed: world.id,
  }
}

export function formatWords(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}`
}

export function formatVolumes(count: number): string {
  if (count === 0) return 'No volumes yet'
  return `${count} ${count === 1 ? 'volume' : 'volumes'}`
}
