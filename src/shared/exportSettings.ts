import { z } from 'zod'

/** Export settings as stored and as sent from a window (see ExportSettings). */
export const exportSettingsSchema = z.object({
  author: z.string().trim().max(200),
  headings: z.enum(['both', 'number', 'title']),
  sceneBreak: z.string().trim().min(1).max(40),
  paragraphs: z.enum(['spaced', 'indented']),
  paper: z.enum(['a4', 'letter', 'trade']),
})
