/**
 * Safe writes: write a temp file beside the target, flush it to disk, then
 * rename it over the original. A crash at any point leaves either the old
 * file or the new one, never a half-written mix.
 */
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

const TEMP_SUFFIX = '.tmp'
const TEMP_PATTERN = /^\..+\.[0-9a-f]{12}\.tmp$/

/** Windows can briefly lock files (antivirus, indexer); retry renames there. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

export async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(target)
  const temp = join(dir, `.${basename(target)}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`)

  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(temp, 'wx')
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await renameWithRetry(temp, target)
  } catch (err) {
    await handle?.close().catch(() => {})
    await fs.promises.rm(temp, { force: true }).catch(() => {})
    throw err
  }
  await syncDirectory(dir)
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || !code || !RETRYABLE_RENAME.has(code) || attempt >= 5) {
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt))
    }
  }
}

/** Makes the rename itself durable. Not supported on Windows, where it is skipped. */
async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(dir, 'r')
    await handle.sync()
  } catch {
    // Some filesystems refuse fsync on directories. The data itself is already flushed.
  } finally {
    await handle?.close().catch(() => {})
  }
}

export function isTempFileName(name: string): boolean {
  return TEMP_PATTERN.test(name)
}

/**
 * Removes temp files left behind by a crash mid-write. The originals beside
 * them are intact, so these are always safe to delete. Returns removed paths.
 */
export async function removeStaleTempFiles(root: string): Promise<string[]> {
  const removed: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && isTempFileName(entry.name)) {
        await fs.promises.rm(full, { force: true })
        removed.push(full)
      }
    }
  }
  await walk(root)
  return removed
}
