/**
 * When a file changed on two computers, both versions are kept. A chapter
 * or a world entry from the other computer becomes a copy beside this one
 * (a new chapter at the end of the volume, a new entry), named so it's easy
 * to spot. Other files keep this computer's version; the other one is saved
 * in the device folder.
 */
import { newId } from '@shared/ids'

export interface ConflictCopy {
  rel: string
  bytes: Uint8Array
  /** What it's called, for the notice. */
  name: string
  /** What the original is called. */
  original: string
}

function when(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A copy to keep beside the file, or null when this kind of file has none. */
export function conflictCopy(
  rel: string,
  theirs: Uint8Array,
  from: { device: string; at: Date },
): ConflictCopy | null {
  const kind = /^(chapters|entries)\/[A-Za-z0-9_-]+\.json$/.exec(rel)?.[1]
  if (!kind) return null
  let data: Record<string, unknown>
  try {
    data = JSON.parse(new TextDecoder().decode(theirs)) as Record<string, unknown>
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  } catch {
    return null
  }
  const label = `copy from ${from.device || 'another computer'}, ${when(from.at)}`
  if (kind === 'chapters') {
    const id = newId('chapter')
    const title = typeof data['title'] === 'string' && data['title'] ? data['title'] : 'Untitled'
    const name = `${title} (${label})`.slice(0, 200)
    const copy = { ...data, id, title: name }
    return { rel: `chapters/${id}.json`, bytes: encode(copy), name, original: title }
  }
  const id = newId('entry')
  const original = typeof data['name'] === 'string' && data['name'] ? data['name'] : 'Untitled'
  const name = `${original} (${label})`.slice(0, 200)
  // No aliases: the copy shouldn't catch the original's names in the text.
  const copy = { ...data, id, name, aliases: [] }
  return { rel: `entries/${id}.json`, bytes: encode(copy), name, original }
}

const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
