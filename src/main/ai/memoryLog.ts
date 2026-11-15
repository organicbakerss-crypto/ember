/**
 * The memory's recent automatic changes, kept on this computer so each can
 * be undone: what every changed topic was like before (or that it was new).
 * Undo puts a topic back only if nothing changed it since; otherwise it's
 * left alone and the writer is told.
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import type { MemoryNodeFile } from '@shared/schema'
import { writeJsonFile } from '../fs/jsonFile'
import type { LibraryHost } from '../libraryHost'

export interface MemoryChangeSet {
  id: string
  at: string
  conversationId: string
  /** What changed, in words. */
  summary: string
  /** Each changed topic before (null: the change made it). */
  before: { id: string; node: MemoryNodeFile | null }[]
  /** Each changed topic's version right after (undo only if it's still this one). */
  after: { id: string; updatedAt: string }[]
}

/** How many change sets are kept per story. */
const KEEP = 60

export class MemoryLog {
  constructor(private readonly host: LibraryHost) {}

  private file(seriesId: string): string {
    return join(this.host.current.paths.localDir, 'memory-changes', `${seriesId}.json`)
  }

  async list(seriesId: string): Promise<MemoryChangeSet[]> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.file(seriesId), 'utf8')) as unknown
      return Array.isArray(raw) ? (raw as MemoryChangeSet[]) : []
    } catch {
      return []
    }
  }

  async add(seriesId: string, set: MemoryChangeSet): Promise<void> {
    const all = [...(await this.list(seriesId)), set].slice(-KEEP)
    await fs.promises.mkdir(dirname(this.file(seriesId)), { recursive: true })
    await writeJsonFile(this.file(seriesId), all)
  }

  /** Puts the topics back as they were before this change (those nothing changed since). */
  async undo(seriesId: string, id: string): Promise<{ undone: number; skipped: string[] }> {
    const all = await this.list(seriesId)
    const set = all.find((s) => s.id === id)
    if (!set) return { undone: 0, skipped: [] }
    const library = this.host.current
    const { nodes } = await library.listNodes(seriesId)
    const restore: MemoryNodeFile[] = []
    const remove: string[] = []
    const skipped: string[] = []
    for (const b of set.before) {
      const now = nodes.find((n) => n.id === b.id)
      const after = set.after.find((a) => a.id === b.id)
      if (!now) continue
      if (after && now.updatedAt !== after.updatedAt) {
        skipped.push(now.title)
        continue
      }
      if (b.node) restore.push(b.node)
      else remove.push(b.id)
    }
    await library.saveNodes(seriesId, restore)
    for (const r of remove) await library.deleteNode(seriesId, r)
    await fs.promises.mkdir(dirname(this.file(seriesId)), { recursive: true })
    await writeJsonFile(
      this.file(seriesId),
      all.filter((s) => s.id !== id),
    )
    return { undone: restore.length + remove.length, skipped }
  }
}
