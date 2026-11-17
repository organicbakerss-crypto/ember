/** Notes left on the phone reader (kept in the sync bucket, outside what sync touches). */
import { z } from 'zod'

/** Archived notes are deleted this long after they were ticked. */
export const ARCHIVE_DAYS = 3

export const phoneNoteSchema = z.looseObject({
  formatVersion: z.number().int().positive(),
  id: z.string().regex(/^pn-[a-z0-9-]{6,60}$/),
  from: z.string().catch('iphone'),
  seriesId: z.string().max(80),
  volumeId: z.string().max(80),
  chapterId: z.string().max(80),
  chapterTitle: z.string().max(200).catch(''),
  /** The passage it's on ("" for the whole chapter). */
  quote: z.string().max(2000).catch(''),
  paragraph: z.number().int().nullable().catch(null).default(null),
  text: z.string().max(8000),
  createdAt: z.string(),
  updatedAt: z.string().catch(''),
  /** Ticked on the computer (deleted ARCHIVE_DAYS later); null while open. */
  archivedAt: z.string().nullable().catch(null).default(null),
})
export type PhoneNote = z.infer<typeof phoneNoteSchema>

/** The phone reader, as Settings shows it. */
export interface PhoneReaderStatus {
  syncConnected: boolean
  url: string | null
  setUpAt: string | null
  /** A Cloudflare token is kept on this computer. */
  hasToken: boolean
  /** A sign-in phrase is kept on this computer (updates go up by themselves). */
  hasPhrase: boolean
}
