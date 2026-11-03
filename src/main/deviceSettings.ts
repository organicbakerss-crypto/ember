/**
 * Device-only settings that must exist before a library is open (like where
 * the library is). Stored in the OS's per-app data folder, never synced.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from './fs/atomicWrite'
import { serializeJson } from './fs/jsonFile'
import { paneRouteSchema } from '@shared/panes'

const boundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
})
export type WindowBounds = z.infer<typeof boundsSchema>

const NO_WINDOWS = { main: null, panes: [] }

const deviceSettingsSchema = z.looseObject({
  libraryPath: z.string().nullable().default(null),
  /** Where the windows were, and which panes were torn off (restored on the next start). */
  windows: z
    .looseObject({
      main: boundsSchema.nullable().default(null),
      panes: z
        .array(z.object({ route: paneRouteSchema, bounds: boundsSchema.nullable() }))
        .max(20)
        .default([]),
    })
    .catch(NO_WINDOWS)
    .default(NO_WINDOWS),
})
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>

export class DeviceSettingsStore {
  private readonly file: string

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'device.json')
  }

  async read(): Promise<DeviceSettings> {
    try {
      const raw: unknown = JSON.parse(await fs.promises.readFile(this.file, 'utf8'))
      const parsed = deviceSettingsSchema.safeParse(raw)
      if (parsed.success) return parsed.data
    } catch {
      // Missing or unreadable: fall through to defaults. Nothing here is user writing.
    }
    return deviceSettingsSchema.parse({})
  }

  async update(patch: Partial<DeviceSettings>): Promise<DeviceSettings> {
    const next = { ...(await this.read()), ...patch }
    await fs.promises.mkdir(join(this.file, '..'), { recursive: true })
    await writeFileAtomic(this.file, serializeJson(next))
    return next
  }
}
