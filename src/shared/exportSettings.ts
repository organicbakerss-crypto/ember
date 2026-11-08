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
  characterId: z.string().trim().max(100).catch('nora').default('nora'),
  worldChanges: z.enum(['apply', 'suggest']).catch('apply').default('apply'),
  autoWorld: z.boolean().catch(false).default(false),
  prompts: z.array(z.string().trim().min(1).max(1000)).max(20).catch([]).default([]),
  adaptive: z.boolean().catch(false).default(false),
  learned: z
    .record(z.string().max(100), z.array(z.string().trim().min(1).max(400)).max(100))
    .catch({})
    .default({}),
})

/** Voice settings as stored and as sent from a window (see VoiceSettings). */
export const voiceSettingsSchema = z.object({
  enabled: z.boolean(),
  systemVoice: z.string().max(200).catch('').default(''),
  rate: z.number().min(0.5).max(2).catch(1).default(1),
  useStudio: z.boolean().catch(true).default(true),
  studioUrl: z.string().trim().max(300).catch('').default(''),
  studioKey: z.string().trim().max(300).catch('').default(''),
  quality: z.enum(['fast', 'balanced', 'best']).catch('balanced').default('balanced'),
  language: z.string().trim().max(20).catch('en').default('en'),
})
