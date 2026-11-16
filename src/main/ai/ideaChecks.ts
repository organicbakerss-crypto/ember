/**
 * Idea suggestions waiting for the writer (from checking chapters against
 * General ideas), kept on this computer per story. A file that can't be read
 * is reported and never written over.
 */
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { ideaChecksFileSchema, sameCheck, type IdeaCheck } from '@shared/memory/check'
import { AppError } from '../errors'
import { writeJsonFile } from '../fs/jsonFile'
import type { LibraryHost } from '../libraryHost'

/** The most waiting at once (the oldest go first). */
const KEEP = 300

export class IdeaChecks {
  constructor(private readonly host: LibraryHost) {}

  private file(seriesId: string): string {
    return join(this.host.current.paths.localDir, 'idea-checks', `${seriesId}.json`)
  }

  async list(seriesId: string): Promise<IdeaCheck[]> {
    let raw: string
    try {
      raw = await fs.promises.readFile(this.file(seriesId), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      data = null
    }
    const parsed = ideaChecksFileSchema.safeParse(data)
    if (!parsed.success)
      throw new AppError(
        'corrupt',
        `The waiting idea suggestions can’t be read (${this.file(seriesId)}); it was left as it is.`,
      )
    return parsed.data.checks as unknown as IdeaCheck[]
  }

  /** Adds new suggestions (one already waiting counts once). Returns how many were new. */
  async add(seriesId: string, found: IdeaCheck[]): Promise<number> {
    if (!found.length) return 0
    const all = await this.list(seriesId)
    // Once per idea: the same one from several chapters (or checking again) counts once.
    const fresh: IdeaCheck[] = []
    for (const c of found)
      if (!all.some((x) => sameCheck(x, c)) && !fresh.some((x) => sameCheck(x, c))) fresh.push(c)
    if (!fresh.length) return 0
    await this.save(seriesId, [...all, ...fresh].slice(-KEEP))
    return fresh.length
  }

  /** Takes these off the list (applied or dismissed). */
  async remove(seriesId: string, ids: string[]): Promise<void> {
    const all = await this.list(seriesId)
    const left = all.filter((c) => !ids.includes(c.id))
    if (left.length !== all.length) await this.save(seriesId, left)
  }

  private async save(seriesId: string, checks: IdeaCheck[]): Promise<void> {
    await fs.promises.mkdir(dirname(this.file(seriesId)), { recursive: true })
    await writeJsonFile(this.file(seriesId), { formatVersion: 1, checks })
  }
}
