/** Putting pictures into a chapter: store the file in the book, then add it to the page. */
import type { Editor } from '@tiptap/core'
import { api, describeError } from '../api'
import { MAX_COVER_BYTES } from '@shared/media'

export interface BookRef {
  seriesId: string
  volumeId: string
}

/** The picture files among dropped or pasted files. */
export function pictureFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
}

/** A short description from a file name ("map-of-the-coast.png" → "map of the coast"). */
export function altFromName(name: string): string {
  return name
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

/**
 * Stores each picture in the book and puts them in at `at` (the cursor when
 * left out). Returns an error message for the writer, or null.
 */
export async function insertPictures(
  editor: Editor,
  book: BookRef,
  files: File[],
  at?: number,
): Promise<string | null> {
  const stored: { file: string; alt: string }[] = []
  for (const f of files) {
    if (f.size > MAX_COVER_BYTES) return `“${f.name}” is too big (pictures can be up to 20 MB).`
    try {
      const data = new Uint8Array(await f.arrayBuffer())
      const { file } = await api.invoke('chapter:image', { ...book, data })
      stored.push({ file, alt: altFromName(f.name) })
    } catch (err) {
      return describeError(err).message
    }
  }
  if (editor.isDestroyed || !stored.length) return null
  const nodes = stored.map((s) => ({ type: 'chapterImage', attrs: s }))
  const chain = editor.chain().focus()
  ;(at === undefined
    ? chain.insertContentAt(besideCursor(editor), nodes)
    : chain.insertContentAt(at, nodes)
  ).run()
  return null
}

/**
 * Where a picture goes from the cursor: in place of an empty line, else after
 * the paragraph the cursor is in (never splitting a sentence).
 */
function besideCursor(editor: Editor): number | { from: number; to: number } {
  const { $from, empty } = editor.state.selection
  if (!$from.parent.isTextblock) return editor.state.selection.to
  if ($from.parent.content.size === 0 && empty) return { from: $from.before(), to: $from.after() }
  return $from.after()
}
