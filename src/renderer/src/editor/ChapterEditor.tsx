import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { ChapterFile, ChapterType } from '@shared/schema'
import { api, describeError, useIpcEvent } from '../api'
import { ReadOnlyNote } from '../panes/ReadOnlyNote'
import { useDocLease } from '../panes/useDocLease'
import { markReadingTr } from './readingMark'
import { RECALC_DELAY_MS, type ActiveEcho, type AnalysisOptions } from './analysisDecorations'
import { useSettings } from '../useTheme'
import { chapterExtensions } from './extensions'
import { NameCards, type NameIndex } from './NameCards'
import { docWords, findScenes, type Scene } from './scenes'
import { Toolbar } from './Toolbar'
import {
  addCommentTr,
  listComments,
  removeCommentTr,
  setNoteTr,
  type CommentInfo,
} from './comments'
import { PAGE_GAP, usePages } from './usePages'
import { useChapterSaver, type SaveState } from './useChapterSaver'

export interface ChapterMeta {
  title: string
  type: ChapterType
  pov: string | null
  /** The world entry the POV is, if it is one (the name shown follows the entry). */
  povEntryId?: string | null
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
  /** The selected text (for quick add). */
  selectedText: () => string
  /** The text just before the selection, in the same paragraph (to guess what a name is). */
  textBeforeSelection: () => string
  /** The paragraphs (and headings) visible on screen, as text. */
  visibleText: () => string
  /** The chapter as it is on the page, or null when it can't be edited here. */
  getDoc: () => JSONContent | null
  /** Replaces the whole chapter as one undoable step (an AI edit). Returns whether it did. */
  replaceDoc: (doc: JSONContent) => boolean
  /** Blocks to read aloud, from the one with the cursor on (text null: a scene break). */
  readingBlocks: () => { pos: number; text: string | null }[]
  /** Shows (and scrolls to) the block being read aloud; null clears it. */
  markReading: (pos: number | null) => void
  /** Puts text in at the cursor (dictation), as one undoable step. Returns whether it did. */
  insertText: (text: string) => boolean
  /** Puts a comment on the selected text; its id, or null when there's no selection. */
  addComment: () => string | null
  setCommentNote: (id: string, note: string) => void
  /** Takes a comment off (one undoable step; the text stays). */
  removeComment: (id: string) => void
  /** Selects and shows a comment's passage. */
  showComment: (id: string) => void
  /** The chapter cut in two at the cursor; null when the cursor is at the very start or end. */
  splitAtCursor: () => { before: JSONContent; after: JSONContent } | null
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
  /** Names from the world, for linked names and the POV field. */
  nameIndex: NameIndex | null
  linkNames: boolean
  /** Show the entry's card when a linked name is hovered. */
  hoverCards?: boolean
  /** `window`: peek at it in a window of its own (middle-click). */
  onOpenEntry: (entryId: string, how?: 'window') => void
  handle: Ref<EditorHandle>
  onMeta: (meta: ChapterMeta) => void
  onWords: (words: number) => void
  onScenes: (scenes: Scene[]) => void
  /** The chapter's comments, whenever they change. */
  onComments?: (comments: CommentInfo[]) => void
  /** The comment the cursor is in (null: none). */
  onActiveComment?: (id: string | null) => void
  onSaveState: (state: SaveState, error: string | null) => void
  reveal?: Reveal | null
  /** Focus mode: just the page, no toolbar. */
  bare?: boolean
  /** Rhythm, Echo and word highlights (view only). */
  analysis: AnalysisOptions
  onToggleRhythm: () => void
  onToggleEcho: () => void
  /** The chapter's paragraphs, reported a moment after typing stops. */
  onParagraphs: (paragraphs: string[]) => void
  /** The selected text as paragraphs, or null when nothing is selected. */
  onSelection: (paragraphs: string[] | null) => void
}

/**
 * Loads a chapter, then shows it as an editable page. If another window or
 * pane is editing it, it shows read-only and follows that one's saves, with
 * a way to move editing here.
 */
export function ChapterEditor(props: Props) {
  const { seriesId, volumeId, chapterId } = props
  const [chapter, setChapter] = useState<ChapterFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  const read = useCallback(
    () => api.invoke('chapter:read', { seriesId, volumeId, chapterId }),
    [seriesId, volumeId, chapterId],
  )
  const lease = useDocLease(`chapter:${chapterId}`, async () => setChapter(await read()))
  useEffect(() => {
    read().then(setChapter, (err) => setError(describeError(err).message))
  }, [read])
  // Read-only: follow the other place's saves.
  useIpcEvent('library:changed', (c) => {
    if (lease.editing !== false || c.kind !== 'chapter' || c.chapterId !== chapterId) return
    read().then(setChapter, () => {})
  })

  if (error) return <p className="error page-message">{error}</p>
  if (!chapter || lease.editing === null) return null
  return (
    <EditorPage
      {...props}
      key={lease.editing ? 'edit' : 'view'}
      chapter={chapter}
      readOnly={!lease.editing}
      notice={
        lease.editing ? null : (
          <ReadOnlyNote
            what="chapter"
            onTake={() => void lease.take(async () => setChapter(await read()))}
          />
        )
      }
    />
  )
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

const SELECTION_DELAY_MS = 300

/** Paragraph texts of the document (or of a range of it), for stats. */
function editorParagraphs(doc: PMNode, from = 0, to = doc.content.size): string[] {
  const out: string[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true
    const start = Math.max(0, from - pos - 1)
    const end = Math.min(node.content.size, to - pos - 1)
    out.push(
      node.textBetween(start, end, undefined, (leaf) =>
        leaf.type.name === 'hardBreak' ? '\n' : ' ',
      ),
    )
    return false
  })
  return out
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

function EditorPage(
  props: Props & {
    chapter: ChapterFile
    /** Shown, not edited: another window or pane is editing this chapter. */
    readOnly?: boolean
    notice?: React.ReactNode
  },
) {
  const { chapter, onMeta, onWords, onScenes, onSaveState } = props
  const readOnly = !!props.readOnly
  const [meta, setMeta] = useState<ChapterMeta>({
    title: chapter.title,
    type: chapter.type,
    pov: chapter.pov,
    povEntryId: chapter.povEntryId ?? null,
  })
  // A linked POV shows the entry's current name, so renaming the character carries through.
  const povLabel =
    (meta.povEntryId && props.nameIndex?.world.resolve(meta.povEntryId)?.name) || meta.pov || ''
  // Content the editor can't represent is never edited or saved.
  const [contentError, setContentError] = useState<string | null>(null)
  const unreadable = useRef(false)
  const scroller = useRef<HTMLDivElement>(null)

  const paragraphTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(
    () => () => {
      clearTimeout(paragraphTimer.current)
      clearTimeout(selectionTimer.current)
    },
    [],
  )
  const [activeEcho, setActiveEcho] = useState<ActiveEcho | null>(null)

  const editor = useEditor({
    extensions: chapterExtensions(),
    content: editableContent(chapter.content),
    enableContentCheck: true,
    onContentError: ({ error }) => {
      unreadable.current = true
      setContentError(error.message)
    },
    onCreate: ({ editor: e }) => {
      if (unreadable.current || readOnly) e.setEditable(false)
      onWords(docWords(e.state.doc))
      onScenes(findScenes(e.state.doc))
      props.onComments?.(listComments(e.state.doc))
      props.onParagraphs(editorParagraphs(e.state.doc))
    },
    onSelectionUpdate: ({ editor: e }) => {
      const { $from } = e.state.selection
      const inside = [...$from.marks(), ...($from.nodeAfter?.marks ?? [])].find(
        (m) => m.type.name === 'comment',
      )
      props.onActiveComment?.(inside ? String(inside.attrs['id']) : null)
      clearTimeout(selectionTimer.current)
      selectionTimer.current = setTimeout(() => {
        if (e.isDestroyed) return
        const { from, to, empty } = e.state.selection
        props.onSelection(empty ? null : editorParagraphs(e.state.doc, from, to))
      }, SELECTION_DELAY_MS)
    },
    onUpdate: ({ editor: e }) => {
      if (unreadable.current || readOnly) return
      saver.changeContent()
      onWords(docWords(e.state.doc))
      onScenes(findScenes(e.state.doc))
      props.onComments?.(listComments(e.state.doc))
      // Stats recalculate a moment after typing stops, not on every key.
      clearTimeout(paragraphTimer.current)
      paragraphTimer.current = setTimeout(() => {
        if (!e.isDestroyed) props.onParagraphs(editorParagraphs(e.state.doc))
      }, RECALC_DELAY_MS)
    },
    editorProps: { attributes: { class: 'chapter-content', spellcheck: 'true' } },
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
  })

  // Rhythm / Echo / highlight options, and the Echo the writer clicked.
  const { analysis } = props
  useEffect(() => {
    editor.commands.setAnalysis(analysis)
  }, [editor, analysis])
  useEffect(() => {
    editor.commands.onActiveEcho(setActiveEcho)
    return () => {
      if (!editor.isDestroyed) editor.commands.onActiveEcho(null)
    }
  }, [editor])
  const showEcho = (index: number) => {
    if (!activeEcho) return
    const i = (index + activeEcho.ranges.length) % activeEcho.ranges.length
    setActiveEcho({ ...activeEcho, index: i })
    editor.chain().focus().setTextSelection(activeEcho.ranges[i]!).scrollIntoView().run()
  }
  const closeEcho = () => editor.commands.clearActiveEcho()

  // Page view: sheets of a fixed paper shape. Height follows the page's width.
  const { settings } = useSettings()
  const paged = settings.pageView === 'pages'
  const { stackRef, pageHeight, pages } = usePages(editor, paged)
  useEffect(() => {
    editor.commands.setTypewriter(settings.typewriter)
  }, [editor, settings.typewriter])

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

  // Read-only: show the other place's latest save in place (keeping the scroll position).
  const [shown, setShown] = useState(chapter)
  if (readOnly && shown !== chapter) {
    setShown(chapter)
    const next = {
      title: chapter.title,
      type: chapter.type,
      pov: chapter.pov,
      povEntryId: chapter.povEntryId ?? null,
    }
    setMeta(next)
    onMeta(next)
  }
  useEffect(() => {
    if (!readOnly || editor.isDestroyed) return
    editor.commands.setContent(editableContent(shown.content), { emitUpdate: false })
    onWords(docWords(editor.state.doc))
    onScenes(findScenes(editor.state.doc))
    props.onComments?.(listComments(editor.state.doc))
    props.onParagraphs(editorParagraphs(editor.state.doc))
    // Only when another save arrives; the callbacks are stable enough not to matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, readOnly, editor])

  const update = (patch: Partial<ChapterMeta>) => {
    if (readOnly) return
    const next = { ...meta, ...patch }
    setMeta(next)
    onMeta(next)
    saver.changeFields(patch)
  }
  useImperativeHandle(props.handle, () => ({
    setTitle(title: string) {
      if (readOnly) {
        // Renamed from the binder while another place edits it: save just the title.
        void api.invoke('chapter:save', {
          seriesId: props.seriesId,
          volumeId: props.volumeId,
          chapterId: chapter.id,
          patch: { title },
        })
        return
      }
      update({ title })
      void saver.flush()
    },
    showMatch(node: number, start: number, end: number) {
      const range = textNodeRange(editor.state.doc, node, start, end)
      if (!range) return
      editor.chain().focus().setTextSelection(range).scrollIntoView().run()
    },
    replaceSelection(replacement: string, query: string, matchCase: boolean) {
      if (readOnly) return false
      const { from, to } = editor.state.selection
      const selected = editor.state.doc.textBetween(from, to)
      const same = matchCase ? selected === query : selected.toLowerCase() === query.toLowerCase()
      if (!selected || !same) return false
      editor.view.dispatch(editor.state.tr.insertText(replacement, from, to))
      return true
    },
    selectedText() {
      const { from, to } = editor.state.selection
      return editor.state.doc.textBetween(from, to, ' ').trim()
    },
    visibleText() {
      const box = (
        scroller.current?.querySelector('.page-scroll') ?? scroller.current?.closest('.page-scroll')
      )?.getBoundingClientRect()
      const parts: string[] = []
      editor.state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return true
        const dom = editor.view.nodeDOM(pos)
        if (dom instanceof HTMLElement && box) {
          const r = dom.getBoundingClientRect()
          if (r.bottom >= box.top && r.top <= box.bottom && node.textContent.trim()) {
            parts.push(node.textContent)
          }
        }
        return false
      })
      return parts.join('\n\n')
    },
    readingBlocks() {
      const from = editor.state.selection.from
      const blocks: { pos: number; text: string | null; end: number }[] = []
      editor.state.doc.forEach((node, offset) => {
        if (node.type.name === 'sceneBreak') blocks.push({ pos: offset, text: null, end: offset })
        else if (node.isTextblock) {
          blocks.push({ pos: offset, text: node.textContent, end: offset + node.nodeSize })
        } else {
          node.descendants((child, at) => {
            if (!child.isTextblock) return true
            const pos = offset + 1 + at
            blocks.push({ pos, text: child.textContent, end: pos + child.nodeSize })
            return false
          })
        }
      })
      const start = Math.max(
        0,
        blocks.findIndex((b) => b.end >= from),
      )
      return blocks.slice(start).map(({ pos, text }) => ({ pos, text }))
    },
    markReading(pos: number | null) {
      if (editor.isDestroyed) return
      editor.view.dispatch(markReadingTr(editor.state, pos))
      if (pos === null) return
      const dom = editor.view.nodeDOM(pos)
      if (dom instanceof HTMLElement) dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
    },
    insertText(text: string) {
      if (readOnly || contentError || !text) return false
      const { from } = editor.state.selection
      const before = editor.state.doc.textBetween(Math.max(0, from - 1), from)
      const spaced = before && !/\s$/.test(before) ? ` ${text}` : text
      editor.chain().focus().insertContent(spaced).run()
      return true
    },
    addComment() {
      if (readOnly || contentError) return null
      const made = addCommentTr(editor.state)
      if (!made) return null
      editor.view.dispatch(made.tr)
      return made.id
    },
    setCommentNote(id: string, note: string) {
      if (readOnly || contentError) return
      const tr = setNoteTr(editor.state, id, note)
      if (tr) editor.view.dispatch(tr)
    },
    removeComment(id: string) {
      if (readOnly || contentError) return
      const tr = removeCommentTr(editor.state, id)
      if (tr) editor.view.dispatch(tr)
    },
    showComment(id: string) {
      const c = listComments(editor.state.doc).find((x) => x.id === id)
      if (c)
        editor.chain().focus().setTextSelection({ from: c.from, to: c.to }).scrollIntoView().run()
    },
    splitAtCursor() {
      if (readOnly || contentError) return null
      const { doc } = editor.state
      const pos = editor.state.selection.from
      const before = doc.cut(0, pos)
      const after = doc.cut(pos)
      if (!before.textContent.trim() || !after.textContent.trim()) return null
      return { before: before.toJSON() as JSONContent, after: after.toJSON() as JSONContent }
    },
    getDoc() {
      if (readOnly || contentError) return null
      return editor.getJSON()
    },
    replaceDoc(doc: JSONContent) {
      if (readOnly || contentError) return false
      editor.chain().setContent(doc, { emitUpdate: true }).run()
      return true
    },
    textBeforeSelection() {
      const { $from } = editor.state.selection
      return $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, ' ')
    },
    insertSceneBreak() {
      if (readOnly) return
      editor.chain().focus().insertSceneBreak().run()
    },
    jumpTo(pos: number) {
      if (pos === 0) {
        ;(
          scroller.current?.querySelector('.page-scroll') ??
          scroller.current?.closest('.page-scroll')
        )?.scrollTo({ top: 0, behavior: 'smooth' })
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
      {!contentError && !props.bare && (
        <Toolbar
          editor={editor}
          rhythm={analysis.rhythm}
          echo={analysis.echo}
          onToggleRhythm={props.onToggleRhythm}
          onToggleEcho={props.onToggleEcho}
        />
      )}
      <NameCards
        editor={editor}
        index={props.nameIndex}
        enabled={props.linkNames}
        hoverCards={props.hoverCards}
        onOpen={props.onOpenEntry}
      />
      {activeEcho && analysis.echo && (
        <div className="echo-bar small" role="status">
          <span>
            Echo: “{activeEcho.word}” · {activeEcho.index + 1} of {activeEcho.ranges.length} nearby
          </span>
          <button
            className="icon"
            title="Previous"
            aria-label="Previous repeat"
            onClick={() => showEcho(activeEcho.index - 1)}
          >
            ‹
          </button>
          <button
            className="icon"
            title="Next"
            aria-label="Next repeat"
            onClick={() => showEcho(activeEcho.index + 1)}
          >
            ›
          </button>
          <button className="icon" title="Close" aria-label="Close" onClick={closeEcho}>
            ✕
          </button>
        </div>
      )}
      {props.notice}
      <div className="page-scroll">
        <div
          ref={stackRef}
          className={`page-stack ${paged ? 'paged' : 'continuous'}`}
          style={{ '--page-height': `${pageHeight}px` } as React.CSSProperties}
        >
          {paged &&
            Array.from({ length: pages }, (_, i) => (
              <div key={i} className="page-sheet" style={{ top: i * (pageHeight + PAGE_GAP) }}>
                <span className="page-number" aria-label={`Page ${i + 1} of ${pages}`}>
                  {i + 1}
                </span>
              </div>
            ))}
          <article
            className={`page-content ${meta.type} ${paged ? '' : 'page'}`}
            style={paged ? { minHeight: pages * (pageHeight + PAGE_GAP) - PAGE_GAP } : undefined}
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
                disabled={readOnly}
                value={meta.type}
                onChange={(e) => update({ type: e.target.value as ChapterType })}
              >
                <option value="chapter">Chapter</option>
                <option value="interlude">Interlude</option>
              </select>
              <input
                aria-label="Point of view"
                disabled={readOnly}
                placeholder="POV"
                list="pov-options"
                value={povLabel}
                onChange={(e) => {
                  const pov = e.target.value.trim() ? e.target.value : null
                  // Picking a name from the world links the POV to that entry.
                  const entry = pov
                    ? props.nameIndex?.world.view.entries.find((x) => x.name === pov.trim())
                    : undefined
                  update({ pov, povEntryId: entry?.id ?? null })
                }}
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
              readOnly={readOnly}
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
                <strong>This chapter contains formatting this version can't show.</strong> It has
                been left untouched and won't be changed here. ({contentError})
              </div>
            ) : (
              <EditorContent editor={editor} onBlur={() => void saver.flush()} />
            )}
          </article>
        </div>
      </div>
    </div>
  )
}
