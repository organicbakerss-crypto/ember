/**
 * The phone reader's notes, as the computer sees them: read from the sync
 * bucket (under library/phone/notes/, which sync itself never touches),
 * ticked off (archived) or put back, and deleted ARCHIVE_DAYS after they
 * were ticked. A note that can't be read is left where it is.
 */
import { ARCHIVE_DAYS, phoneNoteSchema, type PhoneNote } from '@shared/phone'
import { AppError } from '../errors'
import type { CloudStore } from '../sync/cloud'

export const NOTES_PREFIX = 'library/phone/notes/'
const DAY = 24 * 60 * 60 * 1000

export class PhoneNotes {
  /** Notes already read, by key and version (only changed ones are fetched again). */
  private readonly seen = new Map<string, { etag: string; note: PhoneNote | null }>()

  constructor(private readonly cloud: () => CloudStore | null) {}

  /** All notes (newest first). Archived ones past their time are deleted on the way. */
  async list(now = Date.now()): Promise<PhoneNote[]> {
    const cloud = this.cloud()
    if (!cloud) return []
    const objects = await cloud.list(NOTES_PREFIX)
    const out: PhoneNote[] = []
    for (const o of objects) {
      let hit = this.seen.get(o.key)
      if (!hit || hit.etag !== o.etag) {
        const got = await cloud.get(o.key)
        if (!got) continue
        let note: PhoneNote | null
        try {
          const r = phoneNoteSchema.safeParse(JSON.parse(new TextDecoder().decode(got.body)))
          note = r.success ? r.data : null
        } catch {
          note = null
        }
        hit = { etag: got.etag, note }
        this.seen.set(o.key, hit)
      }
      const note = hit.note
      if (!note) continue
      if (note.archivedAt && now - Date.parse(note.archivedAt) > ARCHIVE_DAYS * DAY) {
        await cloud.delete(o.key)
        this.seen.delete(o.key)
        continue
      }
      out.push(note)
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Ticks a note off (or puts it back). */
  async archive(id: string, archived: boolean): Promise<PhoneNote> {
    const cloud = this.cloud()
    if (!cloud) throw new AppError('invalid-input', 'Sync isn’t connected.')
    if (!phoneNoteSchema.shape.id.safeParse(id).success)
      throw new AppError('not-found', 'No such note.')
    const key = `${NOTES_PREFIX}${id}.json`
    const got = await cloud.get(key)
    if (!got) throw new AppError('not-found', 'That note is gone (deleted on the phone).')
    const r = phoneNoteSchema.safeParse(JSON.parse(new TextDecoder().decode(got.body)))
    if (!r.success)
      throw new AppError('corrupt', 'That note can’t be read, so it was left as it is.')
    const note: PhoneNote = {
      ...r.data,
      archivedAt: archived ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    }
    // Only if the phone didn't change it meanwhile.
    const put = await cloud.put(key, new TextEncoder().encode(JSON.stringify(note)), {
      ifMatch: got.etag,
    })
    this.seen.set(key, { etag: put.etag, note })
    return note
  }
}
