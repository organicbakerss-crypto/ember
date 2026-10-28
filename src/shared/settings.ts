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
  /** Separate pages of a fixed paper size, or one continuous sheet. */
  pageView: 'pages' | 'continuous'
  /** Paper shape for the page view. The page keeps these proportions at any width. */
  paperSize: PaperSize
  spellcheck: boolean
  /** Spellcheck languages (e.g. `en-GB`). Empty means the system language. Ignored on macOS. */
  spellLanguages: string[]
  /** Words added to the personal dictionary. */
  dictionary: string[]
  analysis: AnalysisSettings
  statusBar: StatusItem[]
  /** Mark names from the world in chapters (hover for a card, Ctrl/Cmd+click to open). */
  linkNames: boolean
  world: WorldSettings
}

/** World mode and the world beside the page. */
export interface WorldSettings {
  /** Show a card when hovering a linked name (otherwise only the side panel). */
  hoverCards: boolean
  /** Suggest new names from the manuscript in the inbox. */
  nameCatcher: boolean
  /** "Gone quiet": not mentioned in this many chapters. */
  quietAfter: number
}

export const DEFAULT_WORLD_SETTINGS: WorldSettings = {
  hoverCards: true,
  nameCatcher: true,
  quietAfter: 10,
}

export const PAGE_WIDTH = { default: 660, min: 480, max: 1000 } as const

/** Height ÷ width of each paper size. */
export const PAPER_SIZES = {
  a4: { label: 'A4', ratio: 297 / 210 },
  letter: { label: 'US Letter', ratio: 11 / 8.5 },
  trade: { label: 'Trade paperback (6 × 9 in)', ratio: 9 / 6 },
} as const
export type PaperSize = keyof typeof PAPER_SIZES

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
  pageView: 'pages',
  paperSize: 'a4',
  spellcheck: true,
  spellLanguages: [],
  dictionary: [],
  analysis: DEFAULT_ANALYSIS,
  statusBar: DEFAULT_STATUS_BAR,
  linkNames: true,
  world: DEFAULT_WORLD_SETTINGS,
}
