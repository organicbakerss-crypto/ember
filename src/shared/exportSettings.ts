import { z } from 'zod'

/** Export settings as stored and as sent from a window (see ExportSettings). */
export const exportSettingsSchema = z.object({
  author: z.string().trim().max(200),
  headings: z.enum(['both', 'number', 'title']),
  sceneBreak: z.string().trim().min(1).max(40),
  paragraphs: z.enum(['spaced', 'indented']),
  paper: z.enum(['a4', 'letter', 'trade']),
})

/** AI settings as stored and as sent from a window (see AiSettings). */
export const aiSettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['ollama', 'chatgpt']).catch('ollama').default('ollama'),
  host: z.string().trim().min(1).max(300),
  model: z.string().trim().max(200),
  chatgptModel: z.string().trim().max(200).catch('').default(''),
  codexPath: z.string().trim().max(1000).catch('').default(''),
})
