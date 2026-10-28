import { join } from 'node:path'
import { appConfig } from '../../../app.config'

/**
 * Where everything lives inside a library folder.
 *
 *   library.json
 *   series/<series-id>/series.json
 *   series/<series-id>/volumes/<volume-id>/{volume,outline,manifest}.json
 *   series/<series-id>/volumes/<volume-id>/chapters/<chapter-id>.json
 *   worlds/<world-id>/{world,manifest}.json
 *   worlds/<world-id>/{templates,inbox,rejected}.json   (only once used)
 *   worlds/<world-id>/entries/<entry-id>.json
 *   worlds/<world-id>/images/<sha256>.<ext>             (portraits, stored once)
 *   <local data folder>/          device-only, never synced
 */
export class LibraryPaths {
  constructor(readonly root: string) {}

  get libraryFile(): string {
    return join(this.root, 'library.json')
  }
  get localDir(): string {
    return join(this.root, appConfig.localDataFolder)
  }
  get seriesRoot(): string {
    return join(this.root, 'series')
  }
  get worldsRoot(): string {
    return join(this.root, 'worlds')
  }

  seriesDir(seriesId: string): string {
    return join(this.seriesRoot, seriesId)
  }
  seriesFile(seriesId: string): string {
    return join(this.seriesDir(seriesId), 'series.json')
  }
  volumesDir(seriesId: string): string {
    return join(this.seriesDir(seriesId), 'volumes')
  }
  volumeDir(seriesId: string, volumeId: string): string {
    return join(this.volumesDir(seriesId), volumeId)
  }
  chaptersDir(seriesId: string, volumeId: string): string {
    return join(this.volumeDir(seriesId, volumeId), 'chapters')
  }

  worldDir(worldId: string): string {
    return join(this.worldsRoot, worldId)
  }
  worldFile(worldId: string): string {
    return join(this.worldDir(worldId), 'world.json')
  }
}

/** Paths inside a sync unit (volume or world), relative and with forward slashes. */
export const unitPaths = {
  volume: 'volume.json',
  outline: 'outline.json',
  chapter: (chapterId: string) => `chapters/${chapterId}.json`,
  world: 'world.json',
  entry: (entryId: string) => `entries/${entryId}.json`,
  manifest: 'manifest.json',
} as const
