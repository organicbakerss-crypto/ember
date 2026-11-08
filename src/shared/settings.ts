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
  /** Keep the line being typed in the middle of the screen. */
  typewriter: boolean
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
  export: ExportSettings
  ai: AiSettings
  voice: VoiceSettings
  /** Backups of the library to a folder (this computer only). */
  backup: BackupSettings
}

export interface BackupSettings {
  enabled: boolean
  /** The folder backups go in ('' until one is chosen). */
  folder: string
  /** How often, in hours. */
  everyHours: number
  /** How many backups to keep. */
  keep: number
}

export const DEFAULT_BACKUP_SETTINGS: BackupSettings = {
  enabled: false,
  folder: '',
  everyHours: 24,
  keep: 10,
}

/** One backup in the folder. */
export interface BackupInfo {
  file: string
  at: string
  size: number
}

/** Voice (read aloud, the audiobook script): on this computer only. Off by default. */
export interface VoiceSettings {
  enabled: boolean
  /** The computer's voice for reading aloud ("" = the system's default). */
  systemVoice: string
  /** Reading speed (1 = normal). */
  rate: number
  /** Use VoiceStudio's voices when it's running (else the computer's). */
  useStudio: boolean
  /** Where VoiceStudio is ("" = this computer, http://127.0.0.1:3900). */
  studioUrl: string
  /** For another computer's VoiceStudio: its key. */
  studioKey: string
  /** VoiceStudio's quality: faster or better sounding. */
  quality: 'fast' | 'balanced' | 'best'
  /** The language VoiceStudio speaks (ISO code, e.g. en; '' = each voice's own). */
  language: string
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  systemVoice: '',
  rate: 1,
  useStudio: true,
  studioUrl: '',
  studioKey: '',
  quality: 'balanced',
  language: 'en',
}

/** Where VoiceStudio is by default (on this computer). */
export const DEFAULT_STUDIO_URL = 'http://127.0.0.1:3900'

/** AI on this computer (never synced). Off until turned on in Settings → AI. */
export interface AiSettings {
  enabled: boolean
  /** Who answers: Ollama on this computer, or ChatGPT (your plan). */
  provider: 'ollama' | 'chatgpt'
  /** Where Ollama listens. */
  host: string
  /** The Ollama model to use ("" = the first one installed). */
  model: string
  /** The ChatGPT model ("" = the first it offers). */
  chatgptModel: string
  /** The AI character (a regular partner or a guest star); independent of the model. */
  characterId: string
  /**
   * Reading a chapter for the world: make the changes itself (each listed in
   * the inbox, with Undo), or only suggest them.
   */
  worldChanges: 'apply' | 'suggest'
  /** Read changed chapters for the world by itself (after you've left them alone a while). */
  autoWorld: boolean
  /** The writer's own one-click prompts in the AI pane. */
  prompts: string[]
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  provider: 'ollama',
  host: 'http://127.0.0.1:11434',
  model: '',
  chatgptModel: '',
  characterId: 'nora',
  worldChanges: 'apply',
  autoWorld: false,
  prompts: [],
}

/** How exports look (Word, PDF, EPUB, Markdown, Royal Road). */
export interface ExportSettings {
  /** On title pages and in the book's details. */
  author: string
  headings: 'both' | 'number' | 'title'
  sceneBreak: string
  paragraphs: 'spaced' | 'indented'
  /** PDF paper: A4, US Letter, or 6 × 9 in trade paperback. */
  paper: 'a4' | 'letter' | 'trade'
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  author: '',
  headings: 'both',
  sceneBreak: '* * *',
  paragraphs: 'spaced',
  paper: 'a4',
}

/** World mode and the world beside the page. */
export interface WorldSettings {
  /** Show a card when hovering a linked name (otherwise only the side panel). */
  hoverCards: boolean
  /** Suggest new names from the manuscript in the inbox. */
  nameCatcher: boolean
  /** "Gone quiet": not mentioned in this many chapters. */
  quietAfter: number
  /** The map in the Where lens (otherwise places and lists only). */
  map: boolean
  /** For slower machines: lower-resolution map images, no animations. */
  lighter: boolean
  /** Lines with several relationship types show each colour in its own band (else the strongest). */
  blendLines: boolean
  /** The time scrubber above the map and board (otherwise the world as it stands now). */
  timeScrubber: boolean
  /** Faint trails behind people who moved, and portraits gliding to their new place. */
  trails: boolean
  /**
   * How much of a theme's world skin shows: everything (art, fonts, map
   * styling, transitions), plain (fonts and map styling), or minimal (the
   * clean default layout in the theme's colours).
   */
  skin: 'full' | 'plain' | 'minimal'
  /** The skin's words for things (Atlas, Chronicle…) instead of plain ones. */
  vocabulary: boolean
}

export const DEFAULT_WORLD_SETTINGS: WorldSettings = {
  hoverCards: true,
  nameCatcher: true,
  quietAfter: 10,
  map: true,
  lighter: false,
  blendLines: true,
  timeScrubber: true,
  trails: true,
  skin: 'full',
  vocabulary: true,
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
  typewriter: false,
  spellcheck: true,
  spellLanguages: [],
  dictionary: [],
  analysis: DEFAULT_ANALYSIS,
  statusBar: DEFAULT_STATUS_BAR,
  linkNames: true,
  world: DEFAULT_WORLD_SETTINGS,
  export: DEFAULT_EXPORT_SETTINGS,
  ai: DEFAULT_AI_SETTINGS,
  voice: DEFAULT_VOICE_SETTINGS,
  backup: DEFAULT_BACKUP_SETTINGS,
}
