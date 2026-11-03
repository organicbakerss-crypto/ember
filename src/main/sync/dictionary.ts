/**
 * The personal dictionary is the one setting that syncs: a word added (or
 * removed) on one computer is added (or removed) on the others. Nothing
 * else about a computer's settings leaves it.
 *
 * In the cloud, `library/dictionary.json` holds each word with whether it's
 * in the dictionary and when that last changed; the latest change wins.
 * This computer remembers the list as of its last sync, to tell its own
 * additions and removals apart.
 */
import { join } from 'node:path'
import { z } from 'zod'
import { readJsonFile, serializeJson, writeJsonFile } from '../fs/jsonFile'
import { AppError } from '../errors'
import { PreconditionFailed, type CloudStore } from './cloud'
import { CLOUD_PREFIX } from './engine'

export const DICTIONARY_KEY = `${CLOUD_PREFIX}dictionary.json`

const entriesSchema = z.record(
  z.string().min(1).max(100),
  z.object({ on: z.boolean(), at: z.string() }),
)
type Entries = z.infer<typeof entriesSchema>
const fileSchema = z.looseObject({ words: entriesSchema })

/** Merges this computer's dictionary with the cloud's. The new list, or null when unchanged. */
export async function syncDictionary(
  cloud: CloudStore,
  stateDir: string,
  local: string[],
  now: Date = new Date(),
): Promise<string[] | null> {
  const record = join(stateDir, 'dictionary.json')
  let known: Entries = {}
  try {
    known = (await readJsonFile(record, fileSchema)).words
  } catch (err) {
    if (!(err instanceof AppError)) throw err
  }
  // What changed here since the last sync.
  const at = now.toISOString()
  const here = new Set(local)
  const mine: Entries = {}
  for (const w of here) if (!known[w]?.on) mine[w] = { on: true, at }
  for (const [w, e] of Object.entries(known)) if (e.on && !here.has(w)) mine[w] = { on: false, at }

  for (let attempt = 0; attempt < 5; attempt++) {
    const got = await cloud.get(DICTIONARY_KEY)
    let theirs: Entries = {}
    if (got) {
      try {
        theirs = fileSchema.parse(JSON.parse(new TextDecoder().decode(got.body))).words
      } catch {
        theirs = {}
      }
    }
    const merged: Entries = { ...theirs }
    for (const [w, e] of Object.entries(mine)) {
      if (!merged[w] || merged[w].at <= e.at) merged[w] = e
    }
    if (JSON.stringify(sorted(merged)) !== JSON.stringify(sorted(theirs)) || !got) {
      try {
        await cloud.put(
          DICTIONARY_KEY,
          new TextEncoder().encode(serializeJson({ formatVersion: 1, words: sorted(merged) })),
          got ? { ifMatch: got.etag } : { ifNoneMatch: '*' },
        )
      } catch (err) {
        if (err instanceof PreconditionFailed) continue
        throw err
      }
    }
    await writeJsonFile(record, { formatVersion: 1, words: sorted(merged) })
    const words = Object.entries(merged)
      .filter(([, e]) => e.on)
      .map(([w]) => w)
      .sort()
    return words.join('\n') === [...local].sort().join('\n') ? null : words
  }
  return null
}

const sorted = (e: Entries): Entries =>
  Object.fromEntries(Object.entries(e).sort(([a], [b]) => a.localeCompare(b)))
