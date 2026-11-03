/**
 * Reads a Word file for import. The text comes back as HTML (headings,
 * paragraphs, emphasis, lists); the window turns it into chapters and shows
 * the splits to fix before anything is created. The Word file itself is
 * only read, never changed.
 */
import fs from 'node:fs'
import { basename } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import mammoth from 'mammoth'
import { AppError } from '../errors'

/** Word files bigger than this are refused (a whole series is far smaller). */
const MAX_BYTES = 100 * 1024 * 1024

export async function readDocx(
  window: BrowserWindow | null,
): Promise<{ fileName: string; html: string; warnings: string[] }> {
  const options: Electron.OpenDialogOptions = {
    title: 'Import a Word document',
    buttonLabel: 'Import',
    properties: ['openFile'],
    filters: [{ name: 'Word document', extensions: ['docx'] }],
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  const path = result.filePaths[0]
  if (result.canceled || !path) throw new AppError('cancelled', 'No file chosen.')
  return readDocxFile(path)
}

export async function readDocxFile(
  path: string,
): Promise<{ fileName: string; html: string; warnings: string[] }> {
  const stat = await fs.promises.stat(path)
  if (stat.size > MAX_BYTES)
    throw new AppError('invalid-input', 'That file is too large to import.')
  let converted: Awaited<ReturnType<typeof mammoth.convertToHtml>>
  try {
    converted = await mammoth.convertToHtml(
      { buffer: await fs.promises.readFile(path) },
      {
        // Underlined text stays underlined (Word's underline isn't kept by default).
        styleMap: ['u => u'],
        // Images are left out: chapters hold text only.
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
      },
    )
  } catch {
    throw new AppError('invalid-input', 'That file could not be read as a Word document (.docx).')
  }
  return {
    fileName: basename(path).replace(/\.docx$/i, ''),
    html: converted.value,
    warnings: [...new Set(converted.messages.map((m) => m.message))].slice(0, 20),
  }
}
