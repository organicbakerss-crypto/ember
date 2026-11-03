/**
 * Version history in the cloud: upload-only, and lean. For each chapter,
 * one version per day goes up (the last of the day, once the day is over).
 * Versions come down only when asked for, from a chapter's History panel.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { z } from 'zod'
import { SNAPSHOT_ID } from '@shared/ipc'
import { writeFileAtomic } from '../fs/atomicWrite'
import { readJsonFile, writeJsonFile } from '../fs/jsonFile'
import { AppError } from '../errors'
import { PreconditionFailed, type CloudStore } from './cloud'
import { CLOUD_PREFIX } from './engine'

export const HISTORY_PREFIX = `${CLOUD_PREFIX}history/`
const ID = /^[A-Za-z0-9_-]{1,64}$/

const uploadedSchema = z.looseObject({ uploaded: z.array(z.string()) })

async function dirs(dir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && ID.test(e.name))
      .map((e) => e.name)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** The local calendar day a snapshot was taken (snapshot ids start with their UTC time). */
function snapshotDay(id: string): string {
  const [, date, h, m, s, ms] = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id)!
  return localDay(new Date(`${date}T${h}:${m}:${s}.${ms}Z`))
}

function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Uploads each chapter's last version of every finished day. Returns how many went up. */
export async function uploadHistory(
  cloud: CloudStore,
  historyDir: string,
  stateDir: string,
  now: Date = new Date(),
): Promise<number> {
  const record = join(stateDir, 'history.json')
  let uploaded: Set<string>
  try {
    uploaded = new Set((await readJsonFile(record, uploadedSchema)).uploaded)
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    uploaded = new Set()
  }
  const today = localDay(now)
  let sent = 0
  try {
    for (const volumeId of await dirs(historyDir)) {
      for (const chapterId of await dirs(join(historyDir, volumeId))) {
        const names = (await fs.promises.readdir(join(historyDir, volumeId, chapterId)))
          .filter((n) => n.endsWith('.json') && SNAPSHOT_ID.test(n.slice(0, -5)))
          .map((n) => n.slice(0, -5))
          .sort()
        const lastOfDay = new Map<string, string>()
        for (const id of names) lastOfDay.set(snapshotDay(id), id)
        for (const [day, id] of lastOfDay) {
          const key = `${volumeId}/${chapterId}/${id}`
          if (day >= today || uploaded.has(key)) continue
          const bytes = await fs.promises.readFile(
            join(historyDir, volumeId, chapterId, `${id}.json`),
          )
          try {
            await cloud.put(`${HISTORY_PREFIX}${key}.json.gz`, gzipSync(bytes), {
              ifNoneMatch: '*',
            })
          } catch (err) {
            if (!(err instanceof PreconditionFailed)) throw err
          }
          uploaded.add(key)
          sent++
        }
      }
    }
  } finally {
    if (sent) {
      await fs.promises.mkdir(stateDir, { recursive: true })
      await writeJsonFile(record, { formatVersion: 1, uploaded: [...uploaded].sort() })
    }
  }
  return sent
}

/** Brings a chapter's versions from the cloud into its local history. Returns how many were new. */
export async function fetchHistory(
  cloud: CloudStore,
  historyDir: string,
  volumeId: string,
  chapterId: string,
): Promise<number> {
  if (!ID.test(volumeId) || !ID.test(chapterId)) return 0
  const prefix = `${HISTORY_PREFIX}${volumeId}/${chapterId}/`
  const dir = join(historyDir, volumeId, chapterId)
  let added = 0
  for (const o of await cloud.list(prefix)) {
    const id = o.key.slice(prefix.length).replace(/\.json\.gz$/, '')
    if (!SNAPSHOT_ID.test(id)) continue
    const path = join(dir, `${id}.json`)
    if (fs.existsSync(path)) continue
    const got = await cloud.get(o.key)
    if (!got) continue
    let bytes: Buffer
    try {
      bytes = gunzipSync(got.body)
      JSON.parse(bytes.toString('utf8'))
    } catch {
      continue
    }
    await fs.promises.mkdir(dir, { recursive: true })
    await writeFileAtomic(path, bytes)
    added++
  }
  return added
}
