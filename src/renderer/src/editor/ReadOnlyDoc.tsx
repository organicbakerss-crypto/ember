import { EditorContent, useEditor, type JSONContent } from '@tiptap/react'
import type { RichTextDoc } from '@shared/schema'
import { chapterExtensions } from './extensions'

/** A chapter's text, shown with the page's styling but not editable (history previews). */
export function ReadOnlyDoc(props: {
  content: RichTextDoc
  /** The book it's from, so its pictures show. */
  book?: { seriesId: string; volumeId: string }
}) {
  const editor = useEditor({
    extensions: chapterExtensions(undefined, props.book),
    content: props.content as JSONContent,
    editable: false,
    immediatelyRender: true,
    editorProps: { attributes: { class: 'chapter-content' } },
  })
  return <EditorContent editor={editor} />
}
