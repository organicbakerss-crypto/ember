import fs from 'node:fs'
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { AppError } from '../errors'
import { writeFileAtomic } from './atomicWrite'

/** Reads and validates a JSON file. Throws `not-found` or `corrupt`, never returns bad data. */
export async function readJsonFile<S extends z.ZodType>(
  path: string,
  schema: S,
): Promise<z.output<S>> {
  let text: string
  try {
    text = await fs.promises.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError('not-found', `File not found: ${path}`, { cause: err })
    }
    throw err
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new AppError('corrupt', `Not valid JSON: ${path}`, { cause: err })
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` at ${issue.path.join('.')}` : ''
    throw new AppError('corrupt', `Unexpected contents in ${path}${where}: ${issue?.message}`)
  }
  return parsed.data
}

export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Writes JSON safely and returns what was written, for manifest bookkeeping. */
export async function writeJsonFile(
  path: string,
  value: unknown,
): Promise<{ hash: string; size: number }> {
  const bytes = Buffer.from(serializeJson(value), 'utf8')
  await writeFileAtomic(path, bytes)
  return { hash: sha256(bytes), size: bytes.byteLength }
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.promises.access(path)
    return true
  } catch {
    return false
  }
}
