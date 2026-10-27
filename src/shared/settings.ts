/** App settings: types and defaults, free of runtime dependencies so the renderer can import them. */
import { DEFAULT_FILLER_WORDS } from './analysis/fillers'

/** Things the status bar can show, in the order the user picks. */
export const STATUS_ITEMS = [
  'chapterWords',
  'sessionWords',
  'projectWords',
  'goals',
  'sync',
  'pages',
  'readingTime',
  'sentences',
  'avgSentence',
  'longestSentence',
  'paragraphs',
  'avgParagraph',
  'longestParagraph',
  'dialogue',
  'variety',
  'lyAdverbs',
] as const
export type StatusItem = (typeof STATUS_ITEMS)[number]

/** Writing analysis (Diagnostics, Rhythm, Echo). All computed locally. */
export interface AnalysisSettings {
  /** Filler words left out of "repeated words" and Echo. */
  fillerWords: string[]
  /** Count character and place names from the world as words to compare. */
  includeNames: boolean
  /** Echo: repeats within this many words of each other. */
  echoRange: number
  /** Rhythm: sentences of at least this many words are "medium" (yellow)... */
  rhythmMediumFrom: number
  /** ...and at least this many are "long" (red). */
  rhythmLongFrom: number
  /** Rhythm colours; null uses the theme's. */
  rhythmColors: { short: string | null; medium: string | null; long: string | null }
}

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
  analysis: AnalysisSettings
  statusBar: StatusItem[]
}

export const PAGE_WIDTH = { default: 660, min: 480, max: 1000 } as const

export const DEFAULT_ANALYSIS: AnalysisSettings = {
  fillerWords: [...DEFAULT_FILLER_WORDS],
  includeNames: false,
  echoRange: 50,
  rhythmMediumFrom: 10,
  rhythmLongFrom: 20,
  rhythmColors: { short: null, medium: null, long: null },
}

export const DEFAULT_STATUS_BAR: StatusItem[] = ['chapterWords', 'sessionWords', 'goals', 'sync']

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'system',
  pageWidth: PAGE_WIDTH.default,
  spellcheck: true,
  spellLanguages: [],
  dictionary: [],
  analysis: DEFAULT_ANALYSIS,
  statusBar: DEFAULT_STATUS_BAR,
}
