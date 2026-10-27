import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { ChapterFile, ChapterType } from '@shared/schema'
import { api, describeError } from '../api'
import { chapterExtensions } from './extensions'
import { docWords, findScenes, type Scene } from './scenes'
import { Toolbar } from './Toolbar'
import { useChapterSaver, type SaveState } from './useChapterSaver'

export interface ChapterMeta {
  title: string
  type: ChapterType
  pov: string | null
}

export interface EditorHandle {
  /** Scrolls to a scene (by the position of its scene break). */
  jumpTo: (pos: number) => void
  /** Renames the chapter (from the binder), through the editor's own autosave. */
  setTitle: (title: string) => void
  /** Selects and shows a search match: the n-th text node, from start to end. */
  showMatch: (node: number, start: number, end: number) => void
  /** Replaces the selection if it is the searched text. Returns whether it did. */
  replaceSelection: (replacement: string, query: string, matchCase: boolean) => boolean
  insertSceneBreak: () => void
}

/** A search match to select once the chapter is open. */
export interface Reveal {
  node: number
  start: number
  end: number
  token: number
}

interface Props {
  seriesId: string
  volumeId: string
  chapterId: string
  povOptions: string[]
  handle: Ref<EditorHandle>
  onMeta: (meta: ChapterMeta) => void
  onWords: (words: number) => void
  onScenes: (scenes: Scene[]) => void
  onSaveState: (state: SaveState, error: string | null) => void
  reveal?: Reveal | null
  /** Focus mode: just the page, no toolbar. */
  bare?: boolean
}

/** Loads a chapter, then shows it as an editable page. */
export function ChapterEditor(props: Props) {
  const { seriesId, volumeId, chapterId } = props
  const [chapter, setChapter] = useState<ChapterFile | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .invoke('chapter:read', { seriesId, volumeId, chapterId })
      .then(setChapter, (err) => setError(describeError(err).message))
  }, [seriesId, volumeId, chapterId])

  if (error) return <p className="error page-message">{error}</p>
  if (!chapter) return null
  return <EditorPage {...props} chapter={chapter} />
}

/**
 * A brand-new chapter is stored as an empty document, which the editor's
 * schema doesn't allow (it needs at least one block). Start it with one empty
 * paragraph; nothing is written until the user types.
 */
function editableContent(content: ChapterFile['content']): JSONContent {
  return content.content?.length
    ? (content as JSONContent)
    : { type: 'doc', content: [{ type: 'paragraph' }] }
}

/** Document positions of a range inside the n-th text node (search results count text nodes). */
function textNodeRange(doc: PMNode, n: number, start: number, end: number) {
  let index = 0
  let found: { from: number; to: number } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.isText) {
      if (index === n && end <= node.text!.length) found = { from: pos + start, to: pos + end }
      index++
    }
    return true
  })
  return found
}

function EditorPage(props: Props & { chapter: ChapterFile }) {
  const { chapter, onMeta, onWords, onScenes, onSaveState } = props
  const [meta, setMeta] = useState<ChapterMeta>({
    title: chapter.title,
    type: chapter.type,
    pov: chapter.pov,
  })
  // Content the editor can't represent is never edited or saved.
  const [contentError, setContentError] = useState<string | null>(null)
  const unreadable = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)

  const editor = useEditor({
    extensions: chapterExtensions(),
    content: editableContent(chapter.content),
    enableContentCheck: true,
    onContentError: ({ error }) => {
      unreadable.current = true
      setContentError(error.message)
    },
    onCreate: ({ editor: e }) => {
      if (unreadable.current) e.setEditable(false)
      onWords(docWords(e.state.doc))
      onScenes(findScenes(e.state.doc))
    },
    onUpdate: ({ editor: e }) => {
      if (unreadable.current) return
      saver.changeContent()
      onWords(docWords(e.state.doc))
      onScenes(findScenes(e.state.doc))
    },
    editorProps: { attributes: { class: 'chapter-content', spellcheck: 'true' } },
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
  })

  const saver = useChapterSaver(
    { seriesId: props.seriesId, volumeId: props.volumeId, chapterId: chapter.id },
    () =>
      unreadable.current || editor.isDestroyed
        ? null
        : (editor.getJSON() as ChapterFile['content']),
  )

  useEffect(() => onSaveState(saver.state, saver.error), [saver.state, saver.error, onSaveState])

  // Show a search match once the chapter is open (or when another one is picked).
  const { reveal } = props
  useEffect(() => {
    if (!reveal || unreadable.current) return
    const range = textNodeRange(editor.state.doc, reveal.node, reveal.start, reveal.end)
    if (range) editor.chain().focus().setTextSelection(range).scrollIntoView().run()
  }, [reveal, editor])

  const update = (patch: Partial<ChapterMeta>) => {
    const next = { ...meta, ...patch }
    setMeta(next)
    onMeta(next)
    saver.changeFields(patch)
  }
  useImperativeHandle(props.handle, () => ({
    setTitle(title: string) {
      update({ title })
      void saver.flush()
    },
    showMatch(node: number, start: number, end: number) {
      const range = textNodeRange(editor.state.doc, node, start, end)
      if (!range) return
      editor.chain().focus().setTextSelection(range).scrollIntoView().run()
    },
    replaceSelection(replacement: string, query: string, matchCase: boolean) {
      const { from, to } = editor.state.selection
      const selected = editor.state.doc.textBetween(from, to)
      const same = matchCase ? selected === query : selected.toLowerCase() === query.toLowerCase()
      if (!selected || !same) return false
      editor.view.dispatch(editor.state.tr.insertText(replacement, from, to))
      return true
    },
    insertSceneBreak() {
      editor.chain().focus().insertSceneBreak().run()
    },
    jumpTo(pos: number) {
      if (pos === 0) {
        scroller.current?.closest('.page-scroll')?.scrollTo({ top: 0, behavior: 'smooth' })
        editor.commands.focus('start')
        return
      }
      const dom = editor.view.nodeDOM(pos)
      if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
      try {
        editor
          .chain()
          .focus()
          .setTextSelection(pos + 2)
          .run()
      } catch {
        // The break was the last node; leave the cursor where it is.
      }
    },
  }))

  return (
    <div className="editor" ref={scroller}>
      {!contentError && !props.bare && <Toolbar editor={editor} />}
      <div className="page-scroll">
        <article
          className={`page ${meta.type}`}
          // Clicking the empty paper below the text puts the cursor at the end.
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !contentError) {
              e.preventDefault()
              editor.commands.focus('end')
            }
          }}
        >
          <div className="chapter-meta small">
            <select
              aria-label="Chapter type"
              value={meta.type}
              onChange={(e) => update({ type: e.target.value as ChapterType })}
            >
              <option value="chapter">Chapter</option>
              <option value="interlude">Interlude</option>
            </select>
            <input
              aria-label="Point of view"
              placeholder="POV"
              list="pov-options"
              value={meta.pov ?? ''}
              onChange={(e) => update({ pov: e.target.value.trim() ? e.target.value : null })}
            />
            <datalist id="pov-options">
              {props.povOptions.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>
          <input
            // A brand-new chapter starts with its title ready to type.
            autoFocus={!chapter.title && !chapter.content.content?.length}
            className="chapter-title"
            aria-label="Chapter title"
            value={meta.title}
            placeholder="Untitled chapter"
            onChange={(e) => update({ title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                // Focus synchronously, so keys typed right after Enter land in the text.
                editor.view.focus()
                editor.commands.setTextSelection(1)
              }
            }}
            onBlur={() => void saver.flush()}
          />
          {contentError ? (
            <div className="card warning">
              <strong>This chapter contains formatting this version can't show.</strong> It has been
              left untouched and won't be changed here. ({contentError})
            </div>
          ) : (
            <EditorContent editor={editor} onBlur={() => void saver.flush()} />
          )}
        </article>
      </div>
    </div>
  )
}
