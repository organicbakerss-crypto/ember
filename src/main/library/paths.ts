import { join } from 'node:path'
import { appConfig } from '../../../app.config'

/**
 * Where everything lives inside a library folder.
 *
 *   library.json
 *   series/<series-id>/series.json
 *   series/<series-id>/volumes/<volume-id>/{volume,outline,manifest}.json
 *   series/<series-id>/volumes/<volume-id>/chapters/<chapter-id>.json
 *   series/<series-id>/volumes/<volume-id>/summaries/<chapter-id>.json   (AI summaries)
 *   worlds/<world-id>/{world,manifest}.json
 *   worlds/<world-id>/{templates,rejected}.json         (only once used)
 *   worlds/<world-id>/inbox/<item-id>.json              (one per item: captured, or from the AI)
 *   worlds/<world-id>/answers/<answer-id>.json          (the writer's answers to the AI's questions)
 *   worlds/<world-id>/entries/<entry-id>.json
 *   worlds/<world-id>/images/<sha256>.<ext>             (portraits and maps, stored once)
 *   worlds/<world-id>/maps/<map-id>.json                (region outlines or a travel sketch)
 *   worlds/<world-id>/relationships/<rel-id>.json       (one per relationship)
 *   worlds/<world-id>/{board,relationship-types}.json   (board layout; the world's own types)
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
  map: (mapId: string) => `maps/${mapId}.json`,
  relationship: (relId: string) => `relationships/${relId}.json`,
  inboxItem: (itemId: string) => `inbox/${itemId}.json`,
  answer: (answerId: string) => `answers/${answerId}.json`,
  summary: (chapterId: string) => `summaries/${chapterId}.json`,
  speakers: (chapterId: string) => `speakers/${chapterId}.json`,
  aiCharacter: (characterId: string) => `ai-characters/${characterId}.json`,
  /** The old single inbox file, moved to `inbox/` when the inbox next changes. */
  oldInbox: 'inbox.json',
  manifest: 'manifest.json',
} as const
