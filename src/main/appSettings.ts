/**
 * App-wide settings such as the theme. Stored in the OS's per-app data folder.
 * They never sync automatically; manual settings sync comes in a later milestone.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { PAGE_WIDTH, type AppSettings } from '@shared/ipc'
import { writeFileAtomic } from './fs/atomicWrite'
import { serializeJson } from './fs/jsonFile'

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
