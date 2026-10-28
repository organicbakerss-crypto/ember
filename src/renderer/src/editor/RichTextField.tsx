import { useImperativeHandle, type Ref } from 'react'
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react'
import type { Extensions } from '@tiptap/core'
import type { RichTextDoc } from '@shared/schema'
import { chapterExtensions } from './extensions'
import { NameCards, type NameIndex } from './NameCards'

export interface RichTextHandle {
  getContent: () => RichTextDoc | null
  editor: Editor
}

/**
 * A rich-text area without a page (a world entry's page). Same formatting and
 * keyboard shortcuts as the page; no toolbar. Unknown content is shown
 * read-only and never saved.
 */
export function RichTextField(props: {
  content: RichTextDoc
  placeholder: string
  handle: Ref<RichTextHandle>
  onChange: () => void
  extensions?: Extensions
  ariaLabel: string
  /** Linked names inside this text (world entries). */
  names?: {
    index: NameIndex
    enabled: boolean
    hoverCards?: boolean
    onOpen: (entryId: string) => void
  }
}) {
  const editor = useEditor({
    extensions: [...chapterExtensions(props.placeholder), ...(props.extensions ?? [])],
    content: (props.content.content?.length
      ? props.content
      : { type: 'doc', content: [{ type: 'paragraph' }] }) as JSONContent,
    enableContentCheck: true,
    onContentError: ({ editor: e }) => e.setEditable(false),
    onUpdate: () => props.onChange(),
    editorProps: {
      attributes: { class: 'entry-text', 'aria-label': props.ariaLabel, spellcheck: 'true' },
    },
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
  })
  useImperativeHandle(props.handle, () => ({
    getContent: () =>
      editor.isDestroyed || !editor.isEditable ? null : (editor.getJSON() as RichTextDoc),
    editor,
  }))
  return (
    <>
      <EditorContent editor={editor} />
      {props.names && (
        <NameCards
          editor={editor}
          index={props.names.index}
          enabled={props.names.enabled}
          hoverCards={props.names.hoverCards}
          onOpen={props.names.onOpen}
        />
      )}
    </>
  )
}
