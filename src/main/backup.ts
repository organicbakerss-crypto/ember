/**
 * Backups: now and then, a zip of the whole library in a folder the writer
 * chooses (sync isn't a backup: a deletion syncs too). Everything but this
 * computer's own data folder goes in. The zip is written under a hidden
 * name and only renamed once it is complete, so a half-written backup never
 * looks like a good one. Old backups beyond the number to keep go to the
 * system trash.
 */
import fs from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import type { BackupInfo, BackupSettings } from '@shared/settings'

const NAME = /^library-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.zip$/
/** Already compressed: stored as they are. */
const STORED = /\.(png|jpe?g|webp|gif|zip|docx|epub|pdf|mp3|wav|ogg|webm)$/i

const pad = (n: number) => String(n).padStart(2, '0')
export const backupName = (d: Date) =>
  `library-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`

/** The backups in a folder, newest first (only files this app made). */
export async function listBackups(folder: string): Promise<BackupInfo[]> {
  let names: string[]
  try {
    names = await fs.promises.readdir(folder)
  } catch {
    return []
  }
  const out: BackupInfo[] = []
  for (const name of names) {
    const m = NAME.exec(name)
    if (!m) continue
    const [, y, mo, d, h, mi, s] = m.map(Number)
    const stat = await fs.promises.stat(join(folder, name)).catch(() => null)
    if (!stat?.isFile()) continue
    out.push({
      file: name,
      at: new Date(y!, mo! - 1, d!, h!, mi!, s!).toISOString(),
      size: stat.size,
    })
  }
  return out.sort((a, b) => b.file.localeCompare(a.file))
}

/** Every file under `root`, relative, skipping the folders in `skip`. */
async function filesUnder(root: string, skip: string[]): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (skip.some((s) => abs === s)) continue
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) out.push(relative(root, abs))
    }
  }
  await walk(root)
  return out.sort()
}

/**
 * Zips the library into the folder. Returns the new backup; on any failure
 * the half-written file is removed and nothing else changes.
 */
export async function makeBackup(input: {
  libraryRoot: string
  /** Folders inside the library to leave out (this computer's own data). */
  skip: string[]
  folder: string
  now?: Date
}): Promise<BackupInfo> {
  const root = resolve(input.libraryRoot)
  const folder = resolve(input.folder)
  if (folder === root || folder.startsWith(root + sep)) {
    throw new Error('The backup folder can’t be inside the library itself.')
  }
  await fs.promises.mkdir(folder, { recursive: true })
  const name = backupName(input.now ?? new Date())
  const partial = join(folder, `.${name}.partial`)
  const files = await filesUnder(
    root,
    input.skip.map((s) => resolve(s)),
  )
  const out = fs.createWriteStream(partial)
  try {
    await new Promise<void>((done, fail) => {
      out.on('error', fail)
      const zip = new Zip((err, chunk, final) => {
        if (err) return fail(err)
        out.write(chunk)
        if (final) out.end(() => done())
      })
      void (async () => {
        try {
          for (const rel of files) {
            const path = rel.split(sep).join('/')
            const entry = STORED.test(rel)
              ? new ZipPassThrough(path)
              : new ZipDeflate(path, { level: 6 })
            zip.add(entry)
            entry.push(new Uint8Array(await fs.promises.readFile(join(root, rel))), true)
          }
          zip.end()
        } catch (err) {
          fail(err as Error)
        }
      })()
    })
    // On disk for real before it gets its name.
    const handle = await fs.promises.open(partial, 'r+')
    await handle.sync()
    await handle.close()
    await fs.promises.rename(partial, join(folder, name))
  } catch (err) {
    out.destroy()
    await fs.promises.rm(partial, { force: true })
    throw err
  }
  const stat = await fs.promises.stat(join(folder, name))
  return { file: name, at: (input.now ?? new Date()).toISOString(), size: stat.size }
}

/** Moves backups beyond the newest `keep` to the trash. */
export async function pruneBackups(
  folder: string,
  keep: number,
  trash: (path: string) => Promise<void>,
): Promise<number> {
  const old = (await listBackups(folder)).slice(Math.max(1, keep))
  for (const b of old) await trash(join(folder, b.file))
  return old.length
}

/** Runs backups on a schedule, and on request. */
export class BackupService {
  private running: Promise<BackupInfo> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  lastError: string | null = null

  constructor(
    private readonly options: {
      settings: () => Promise<BackupSettings>
      /** The open library's root and its local data folder; null when none is open. */
      library: () => { root: string; localDir: string } | null
      trash: (path: string) => Promise<void>
      onDone?: (info: BackupInfo | null, error: string | null) => void
    },
  ) {}

  /** Checks now and then whether a backup is due. */
  start(checkEveryMs = 30 * 60_000, firstAfterMs = 60_000): void {
    setTimeout(() => void this.runIfDue(), firstAfterMs)
    this.timer = setInterval(() => void this.runIfDue(), checkEveryMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  get busy(): boolean {
    return this.running !== null
  }

  async runIfDue(now = new Date()): Promise<BackupInfo | null> {
    const s = await this.options.settings()
    if (!s.enabled || !s.folder || this.running) return null
    const [last] = await listBackups(s.folder)
    if (last && now.getTime() - Date.parse(last.at) < s.everyHours * 3_600_000) return null
    return this.runNow(now).catch(() => null)
  }

  /** A backup now (one at a time). */
  async runNow(now = new Date()): Promise<BackupInfo> {
    if (this.running) return this.running
    this.running = (async () => {
      const s = await this.options.settings()
      const lib = this.options.library()
      if (!lib) throw new Error('No library is open.')
      if (!s.folder) throw new Error('Choose a folder for backups first.')
      const info = await makeBackup({
        libraryRoot: lib.root,
        skip: [lib.localDir],
        folder: s.folder,
        now,
      })
      await pruneBackups(s.folder, s.keep, this.options.trash).catch(() => 0)
      return info
    })()
    try {
      const info = await this.running
      this.lastError = null
      this.options.onDone?.(info, null)
      return info
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.options.onDone?.(null, this.lastError)
      throw err
    } finally {
      this.running = null
    }
  }
}
