/** App settings: types and defaults, free of runtime dependencies so the renderer can import them. */

/** App-wide settings (synced only by hand, later). */
export interface AppSettings {
  /** `system`, or the id of a theme file. */
  theme: string
  /** Width of the text column on the page, in CSS pixels (about 60–75 characters at the default). */
  pageWidth: number
  spellcheck: boolean
  /** Spellcheck languages (e.g. `en-GB`). Empty means the system language. Ignored on macOS. */
  spellLanguages: string[]
  /** Words added to the personal dictionary. */
  dictionary: string[]
}

export const PAGE_WIDTH = { default: 660, min: 480, max: 1000 } as const

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  pageWidth: PAGE_WIDTH.default,
  spellcheck: true,
  spellLanguages: [],
  dictionary: [],
}
