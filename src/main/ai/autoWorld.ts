/**
 * "Keep the world up to date by itself": a chapter that changed is read for
 * the world once it has been left alone for a few minutes (one chapter at a
 * time, only when the setting is on, and only if its summary is out of date,
 * so reading it again never repeats work). The reading itself is the same
 * background job as "Update the world from this chapter".
 */
import type { LibraryChange } from '@shared/ipc'
import type { AiSettings } from '@shared/settings'
import type { LibraryHost } from '../libraryHost'

export interface ChapterRef {
  seriesId: string
  volumeId: string
  chapterId: string
}

const QUIET_MS = 3 * 60_000
const EVERY_MS = 30_000

export class AutoWorld {
  private readonly dirty = new Map<string, ChapterRef & { at: number }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private busy = false

  constructor(
    private readonly options: {
      settings: () => Promise<AiSettings>
      host: LibraryHost
      /** Reads a chapter for the world (as a background job). */
      run: (ref: ChapterRef) => Promise<unknown>
      quietMs?: number
      now?: () => number
    },
  ) {}

  /** Library changes: an edited chapter waits until it's been left alone a while. */
  changed(change: LibraryChange): void {
    if (change.kind === 'library') this.dirty.clear()
    if (change.kind !== 'chapter') return
    const { seriesId, volumeId, chapterId } = change
    this.dirty.set(chapterId, { seriesId, volumeId, chapterId, at: this.now() })
  }

  start(everyMs = EVERY_MS): void {
    this.stop()
    this.timer = setInterval(() => void this.tick(), everyMs)
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Reads the one chapter that's due, if any. Returns whether it read one. */
  async tick(): Promise<boolean> {
    if (this.busy || !this.dirty.size) return false
    const settings = await this.options.settings()
    if (!settings.enabled || !settings.autoWorld) return false
    const quiet = this.options.quietMs ?? QUIET_MS
    const due = [...this.dirty.values()].find((d) => this.now() - d.at >= quiet)
    if (!due) return false
    this.dirty.delete(due.chapterId)
    this.busy = true
    try {
      const library = this.options.host.current
      const series = await library.getSeries(due.seriesId)
      if (!series.worldId) return false
      const summary = (await library.storySummaries(due.seriesId)).find(
        (s) => s.chapter.id === due.chapterId,
      )
      // Gone, empty, or already read as it is now.
      if (!summary || summary.current || !summary.paragraphs.some((p) => p.trim())) return false
      const { seriesId, volumeId, chapterId } = due
      await this.options.run({ seriesId, volumeId, chapterId })
      return true
    } catch {
      // Not now (no AI, a damaged file): it's tried again after its next change.
      return false
    } finally {
      this.busy = false
    }
  }

  private now() {
    return (this.options.now ?? Date.now)()
  }
}
