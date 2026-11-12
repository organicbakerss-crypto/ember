/**
 * Exports a volume (or some of its chapters) to a file the writer picks:
 * Word, PDF, EPUB or Markdown. And copies one chapter for Royal Road.
 * Files are written safely (temp file, then rename); nothing in the library
 * is changed.
 */
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { app, BrowserWindow, clipboard, ClipboardItem, dialog } from 'electron'
import {
  docToBlocks,
  numberChapters,
  type ExportStyle,
  type Manuscript,
  type ManuscriptChapter,
  blockImages,
} from '@shared/manuscript/blocks'
import {
  bookHtmlForPrint,
  chapterPlainText,
  royalRoadHtml,
  type PaperSize,
} from '@shared/manuscript/html'
import { manuscriptMarkdown } from '@shared/manuscript/markdown'
import type { ExportSettings } from '@shared/settings'
import { AppError } from '../errors'
import { writeFileAtomic } from '../fs/atomicWrite'
import type { Library } from '../library/library'
import { manuscriptDocx } from './docx'
import { manuscriptEpub } from './epub'
import { worldBibleHtml } from './worldBible'

export type ExportFormat = 'docx' | 'pdf' | 'epub' | 'markdown'

const FORMATS: Record<ExportFormat, { ext: string; name: string }> = {
  docx: { ext: 'docx', name: 'Word document' },
  pdf: { ext: 'pdf', name: 'PDF' },
  epub: { ext: 'epub', name: 'EPUB e-book' },
  markdown: { ext: 'md', name: 'Markdown' },
}

const styleOf = (s: ExportSettings, headings?: string | null): ExportStyle => ({
  headings:
    headings === 'both' || headings === 'number' || headings === 'title' ? headings : s.headings,
  sceneBreak: s.sceneBreak,
  paragraphs: s.paragraphs,
})

/** A volume as a manuscript: its chapters in reading order, numbered. */
export async function buildManuscript(
  library: Library,
  seriesId: string,
  volumeId: string,
  author: string,
  only?: string[],
): Promise<{ manuscript: Manuscript; skipped: string[]; headings: string | null }> {
  const found = await library.chaptersForExport(seriesId, volumeId, only)
  // Numbers follow the whole volume, even when only some chapters are exported.
  const all = only ? (await library.chaptersForExport(seriesId, volumeId)).chapters : found.chapters
  const numbered = numberChapters(all.map((c) => ({ id: c.id, type: c.type })))
  const numberOf = new Map(numbered.map((c) => [c.id, c.number]))
  const chapters: ManuscriptChapter[] = found.chapters.map((c) => ({
    title: c.title,
    type: c.type,
    number: numberOf.get(c.id) ?? null,
    blocks: docToBlocks(c.content),
  }))
  const images = await library.chapterImages(
    seriesId,
    volumeId,
    chapters.flatMap((c) => blockImages(c.blocks)),
  )
  return {
    manuscript: { title: found.volume, series: found.series, author, chapters, images },
    skipped: found.skipped,
    headings: found.headings,
  }
}

/** Prints HTML to a PDF in a hidden window (no scripts run in it). */
async function printPdf(html: string): Promise<Uint8Array> {
  const file = join(os.tmpdir(), `export-${randomBytes(6).toString('hex')}.html`)
  await fs.promises.writeFile(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true },
  })
  try {
    await win.loadFile(file)
    return new Uint8Array(await win.webContents.printToPDF({ preferCSSPageSize: true }))
  } finally {
    win.destroy()
    await fs.promises.rm(file, { force: true })
  }
}

/** A file name from a title (no characters file systems refuse). */
const fileName = (title: string) => title.replace(/[\\/:*?"<>|]/g, '').trim() || 'Export'

export async function exportVolume(
  library: Library,
  window: BrowserWindow | null,
  input: {
    seriesId: string
    volumeId: string
    format: ExportFormat
    chapterIds?: string[]
    settings: ExportSettings
  },
): Promise<{ path: string; chapters: number; skipped: string[] }> {
  const { manuscript, skipped, headings } = await buildManuscript(
    library,
    input.seriesId,
    input.volumeId,
    input.settings.author,
    input.chapterIds,
  )
  if (!manuscript.chapters.length)
    throw new AppError('invalid-input', 'There are no chapters to export.')
  const format = FORMATS[input.format]
  const suffix =
    input.chapterIds?.length === 1 ? ` - ${manuscript.chapters[0]!.title || 'Chapter'}` : ''
  const options: Electron.SaveDialogOptions = {
    title: `Export as ${format.name}`,
    defaultPath: join(
      app.getPath('documents'),
      `${fileName(manuscript.title + suffix)}.${format.ext}`,
    ),
    filters: [{ name: format.name, extensions: [format.ext] }],
  }
  const choice = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) throw new AppError('cancelled', 'Export cancelled.')
  const style = styleOf(input.settings, headings)
  const bytes =
    input.format === 'markdown'
      ? manuscriptMarkdown(manuscript, style)
      : input.format === 'docx'
        ? await manuscriptDocx(manuscript, style)
        : input.format === 'epub'
          ? manuscriptEpub(manuscript, style)
          : await printPdf(bookHtmlForPrint(manuscript, style, input.settings.paper as PaperSize))
  await writeFileAtomic(choice.filePath, bytes)
  return { path: choice.filePath, chapters: manuscript.chapters.length, skipped }
}

/** Copies one chapter as HTML (with plain text alongside) that pastes cleanly into Royal Road. */
export async function copyForRoyalRoad(
  library: Library,
  input: { seriesId: string; volumeId: string; chapterId: string; settings: ExportSettings },
): Promise<{ title: string }> {
  const { manuscript, headings } = await buildManuscript(
    library,
    input.seriesId,
    input.volumeId,
    input.settings.author,
    [input.chapterId],
  )
  const chapter = manuscript.chapters[0]
  if (!chapter) throw new AppError('not-found', 'That chapter could not be read.')
  const style = styleOf(input.settings, headings)
  await clipboard.write([
    new ClipboardItem({
      'text/html': royalRoadHtml(chapter, style),
      'text/plain': chapterPlainText(chapter, style),
    }),
  ])
  return { title: chapter.title }
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** A world as a PDF series bible (asks where to save it). */
export async function exportWorldPdf(
  library: Library,
  window: BrowserWindow | null,
  worldId: string,
): Promise<{ path: string; entries: number }> {
  const view = await library.world.view(worldId)
  const entries = []
  for (const e of view.entries) {
    try {
      entries.push(await library.world.readEntry(worldId, e.id))
    } catch (err) {
      if (!(err instanceof AppError)) throw err
    }
  }
  if (!entries.length) throw new AppError('invalid-input', 'This world has no entries yet.')
  const options: Electron.SaveDialogOptions = {
    title: 'Export the world as a PDF',
    defaultPath: join(app.getPath('documents'), `${fileName(view.world.name)} - series bible.pdf`),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  }
  const choice = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) throw new AppError('cancelled', 'Export cancelled.')
  const images = new Map<string, string | null>()
  for (const e of entries) {
    for (const file of [e.portrait?.file, ...e.gallery.map((p) => p.file)]) {
      if (!file || images.has(file)) continue
      const type = IMAGE_TYPES[file.split('.').pop() ?? '']
      const data = await fs.promises
        .readFile(library.world.imagePath(worldId, file))
        .catch(() => null)
      images.set(file, data && type ? `data:${type};base64,${data.toString('base64')}` : null)
    }
  }
  const html = worldBibleHtml({
    worldName: view.world.name,
    entries,
    templates: view.templates,
    relationships: view.relationships,
    relationshipTypes: view.relationshipTypes,
    image: (file) => images.get(file) ?? null,
  })
  await writeFileAtomic(choice.filePath, await printPdf(html))
  return { path: choice.filePath, entries: entries.length }
}
