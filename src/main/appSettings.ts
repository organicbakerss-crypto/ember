/**
 * App-wide settings such as the theme. Stored in the OS's per-app data folder.
 * They never sync automatically; manual settings sync comes in a later milestone.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  DEFAULT_ANALYSIS,
  DEFAULT_STATUS_BAR,
  PAGE_WIDTH,
  STATUS_ITEMS,
  type AppSettings,
} from '@shared/settings'
import { writeFileAtomic } from './fs/atomicWrite'
import { serializeJson } from './fs/jsonFile'

const color = z
  .string()
  .regex(/^#[0-9a-f]{6}$/i)
  .nullable()

export const analysisSettingsSchema = z.object({
  fillerWords: z.array(z.string().trim().toLowerCase().min(1).max(50)).max(2000),
  includeNames: z.boolean(),
  echoRange: z.number().int().min(5).max(500),
  rhythmMediumFrom: z.number().int().min(2).max(100),
  rhythmLongFrom: z.number().int().min(3).max(200),
  rhythmColors: z.object({ short: color, medium: color, long: color }),
})

const appSettingsSchema = z.looseObject({
  theme: z.string().min(1).catch('system').default('system'),
  pageWidth: z
    .number()
    .int()
    .min(PAGE_WIDTH.min)
    .max(PAGE_WIDTH.max)
    .catch(PAGE_WIDTH.default)
    .default(PAGE_WIDTH.default),
  spellcheck: z.boolean().catch(true).default(true),
  spellLanguages: z.array(z.string()).catch([]).default([]),
  dictionary: z.array(z.string()).catch([]).default([]),
  analysis: analysisSettingsSchema.catch(DEFAULT_ANALYSIS).default(DEFAULT_ANALYSIS),
  statusBar: z.array(z.enum(STATUS_ITEMS)).catch(DEFAULT_STATUS_BAR).default(DEFAULT_STATUS_BAR),
})

export class AppSettingsStore {
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'settings.json')
  }

  async read(): Promise<AppSettings> {
    try {
      const raw: unknown = JSON.parse(await fs.promises.readFile(this.file, 'utf8'))
      const parsed = appSettingsSchema.safeParse(raw)
      if (parsed.success) return parsed.data
    } catch {
      // Missing or unreadable: use defaults.
    }
    return appSettingsSchema.parse({})
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    const next = { ...(await this.read()), ...defined }
    await fs.promises.mkdir(join(this.file, '..'), { recursive: true })
    await writeFileAtomic(this.file, serializeJson(next))
    return next
  }
}
