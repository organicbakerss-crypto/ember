/**
 * Files attached to an AI conversation (a hand-off doc, notes). Kept as text
 * on this computer only, in the library's local folder: they don't sync, but
 * the conversation (which names them) does.
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import mammoth from 'mammoth'
import { newId } from '@shared/ids'
import { AppError } from '../errors'
import { readJsonFile, writeJsonFile } from '../fs/jsonFile'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_TEXT_CHARS = 2_000_000

const attachmentSchema = z.looseObject({
  formatVersion: z.number().int().positive(),
  id: z.string().regex(/^att_[0-9a-z]{16}$/),
  name: z.string().max(300),
  text: z.string(),
  addedAt: z.string(),
})

export interface AttachmentInfo {
  id: string
  name: string
  words: number
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** The text of a file the writer attached: plain text, Markdown, HTML or Word. */
export async function attachmentText(name: string, data: Uint8Array): Promise<string> {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) })
    return value
  }
  if (['pdf', 'doc', 'odt', 'rtf', 'pages', 'epub'].includes(ext)) {
    throw new AppError(
      'invalid-input',
      `“${name}” can’t be read here yet. Save it as .docx, .md or .txt and attach that.`,
    )
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(data)
  if (ext === 'html' || ext === 'htm') {
    return text
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<\/(p|div|h\d|li|br)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  }
  if (text.includes('\u0000')) {
    throw new AppError('invalid-input', `“${name}” doesn’t look like a text file.`)
  }
  return text
}

export class Attachments {
  constructor(private readonly dir: () => string) {}

  private folder(conversationId: string): string {
    if (!/^[a-z]+_[a-z0-9]+$/.test(conversationId)) {
      throw new AppError('invalid-input', 'Not a conversation.')
    }
    return join(this.dir(), conversationId)
  }

  async add(conversationId: string, name: string, data: Uint8Array): Promise<AttachmentInfo> {
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AppError('invalid-input', `“${name}” is too big to attach (20 MB at most).`)
    }
    const text = (await attachmentText(name, data)).slice(0, MAX_TEXT_CHARS).trim()
    if (!text) throw new AppError('invalid-input', `“${name}” has no text in it.`)
    const id = newId('attachment')
    const folder = this.folder(conversationId)
    await fs.promises.mkdir(folder, { recursive: true })
    await writeJsonFile(join(folder, `${id}.json`), {
      formatVersion: 1,
      id,
      name: name.slice(0, 300),
      text,
      addedAt: new Date().toISOString(),
    })
    return { id, name, words: words(text) }
  }

  /** The texts of these attachments (any missing here, e.g. attached on another computer, skipped). */
  async texts(conversationId: string, ids: string[]): Promise<{ name: string; text: string }[]> {
    const out: { name: string; text: string }[] = []
    for (const id of ids) {
      if (!/^att_[0-9a-z]{16}$/.test(id)) continue
      try {
        const file = await readJsonFile(
          join(this.folder(conversationId), `${id}.json`),
          attachmentSchema,
        )
        out.push({ name: file.name, text: file.text })
      } catch (err) {
        if (!(err instanceof AppError)) throw err
      }
    }
    return out
  }

  /** Which of these are on this computer. */
  async here(conversationId: string, ids: string[]): Promise<string[]> {
    const folder = this.folder(conversationId)
    const out: string[] = []
    for (const id of ids) {
      if (/^att_[0-9a-z]{16}$/.test(id) && fs.existsSync(join(folder, `${id}.json`))) out.push(id)
    }
    return out
  }
}
