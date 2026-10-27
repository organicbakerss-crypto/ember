/** How each statistic is labelled and shown. Every number carries its unit. */
import type { TextStats } from '@shared/analysis'
import type { StatusItem } from '@shared/settings'

const n = (value: number, digits = 0) =>
  value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
const plural = (value: number, one: string, many: string) => (value === 1 ? one : many)

export function formatWords(value: number): string {
  return `${n(value)} ${plural(value, 'word', 'words')}`
}

export function formatMinutes(minutes: number): string {
  if (minutes <= 0) return '0 min'
  if (minutes < 1) return 'under 1 min'
  if (minutes < 60) return `${Math.round(minutes)} min`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

export type StatKey = Exclude<
  StatusItem,
  'chapterWords' | 'sessionWords' | 'projectWords' | 'goals' | 'sync'
>

/** The text statistics, in the order Diagnostics lists them. */
export const STAT_ROWS: {
  key: StatKey | 'words'
  label: string
  value: (s: TextStats) => string
  hint?: string
}[] = [
  { key: 'words', label: 'Words', value: (s) => formatWords(s.words) },
  {
    key: 'pages',
    label: 'Novel pages',
    value: (s) => `${n(s.pages, 1)} ${plural(s.pages, 'page', 'pages')}`,
    hint: 'words ÷ 250',
  },
  {
    key: 'readingTime',
    label: 'Reading time',
    value: (s) => formatMinutes(s.readingMinutes),
    hint: 'at 250 words a minute',
  },
  {
    key: 'sentences',
    label: 'Sentences',
    value: (s) => `${n(s.sentences)} ${plural(s.sentences, 'sentence', 'sentences')}`,
  },
  {
    key: 'avgSentence',
    label: 'Average sentence',
    value: (s) => `${n(s.avgSentenceWords, 1)} words`,
  },
  {
    key: 'longestSentence',
    label: 'Longest sentence',
    value: (s) => formatWords(s.longestSentenceWords),
  },
  {
    key: 'paragraphs',
    label: 'Paragraphs',
    value: (s) => `${n(s.paragraphs)} ${plural(s.paragraphs, 'paragraph', 'paragraphs')}`,
  },
  {
    key: 'avgParagraph',
    label: 'Average paragraph',
    value: (s) => `${n(s.avgParagraphWords, 1)} words`,
  },
  {
    key: 'longestParagraph',
    label: 'Longest paragraph',
    value: (s) => formatWords(s.longestParagraphWords),
  },
  {
    key: 'dialogue',
    label: 'Dialogue',
    value: (s) => `${n(s.dialoguePercent)}% of words`,
    hint: 'words inside quotation marks',
  },
  {
    key: 'variety',
    label: 'Vocabulary variety',
    value: (s) => `${n(s.varietyPercent)} distinct per 100 words`,
    hint: 'averaged over 100-word stretches',
  },
  {
    key: 'lyAdverbs',
    label: '-ly adverbs',
    value: (s) => `${n(s.lyAdverbs)} ${plural(s.lyAdverbs, 'adverb', 'adverbs')}`,
  },
]

/** Labels for the status bar's right-click menu. */
export const STATUS_LABELS: Record<StatusItem, string> = {
  chapterWords: 'Chapter words',
  sessionWords: 'Session words',
  projectWords: 'Project words',
  goals: 'Goal progress',
  sync: 'Save and sync status',
  pages: 'Novel pages',
  readingTime: 'Reading time',
  sentences: 'Sentences',
  avgSentence: 'Average sentence length',
  longestSentence: 'Longest sentence',
  paragraphs: 'Paragraphs',
  avgParagraph: 'Average paragraph length',
  longestParagraph: 'Longest paragraph',
  dialogue: 'Dialogue %',
  variety: 'Vocabulary variety',
  lyAdverbs: '-ly adverbs',
}

/** Short status bar forms of the text statistics (chapter scope). */
export const STATUS_SHORT: Record<StatKey, (s: TextStats) => string> = {
  pages: (s) => `${n(s.pages, 1)} pages`,
  readingTime: (s) => `${formatMinutes(s.readingMinutes)} read`,
  sentences: (s) => `${n(s.sentences)} sentences`,
  avgSentence: (s) => `Avg sentence ${n(s.avgSentenceWords, 1)} words`,
  longestSentence: (s) => `Longest sentence ${formatWords(s.longestSentenceWords)}`,
  paragraphs: (s) => `${n(s.paragraphs)} paragraphs`,
  avgParagraph: (s) => `Avg paragraph ${n(s.avgParagraphWords, 1)} words`,
  longestParagraph: (s) => `Longest paragraph ${formatWords(s.longestParagraphWords)}`,
  dialogue: (s) => `Dialogue ${n(s.dialoguePercent)}%`,
  variety: (s) => `Variety ${n(s.varietyPercent)}%`,
  lyAdverbs: (s) => `${n(s.lyAdverbs)} -ly adverbs`,
}
