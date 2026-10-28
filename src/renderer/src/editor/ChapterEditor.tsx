import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { ChapterFile, ChapterType } from '@shared/schema'
import { api, describeError } from '../api'
import { RECALC_DELAY_MS, type ActiveEcho, type AnalysisOptions } from './analysisDecorations'
import { PAPER_SIZES } from '@shared/settings'
import { useSettings } from '../useTheme'
import { chapterExtensions } from './extensions'
import { NameCards, type NameIndex } from './NameCards'
import { docWords, findScenes, type Scene } from './scenes'
import { Toolbar } from './Toolbar'
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
  onOpenEntry: (entryId: string) => void
  handle: Ref<EditorHandle>
  onMeta: (meta: ChapterMeta) => void
  onWords: (words: number) => void
  onScenes: (scenes: Scene[]) => void
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

const SELECTION_DELAY_MS = 300
/** Space between sheets in the page view. */
const PAGE_GAP = 28

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

function EditorPage(props: Props & { chapter: ChapterFile }) {
  const { chapter, onMeta, onWords, onScenes, onSaveState } = props
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
      if (unreadable.current) e.setEditable(false)
      onWords(docWords(e.state.doc))
      onScenes(findScenes(e.state.doc))
      props.onParagraphs(editorParagraphs(e.state.doc))
    },
    onSelectionUpdate: ({ editor: e }) => {
      clearTimeout(selectionTimer.current)
      selectionTimer.current = setTimeout(() => {
        if (e.isDestroyed) return
        const { from, to, empty } = e.state.selection
        props.onSelection(empty ? null : editorParagraphs(e.state.doc, from, to))
      }, SELECTION_DELAY_MS)
    },
    onUpdate: ({ editor: e }) => {
      if (unreadable.current) return
      saver.changeContent()
      onWords(docWords(e.state.doc))
      onScenes(findScenes(e.state.doc))
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
  const ratio = PAPER_SIZES[settings.paperSize].ratio
  const stackRef = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState({ width: 0, marginBlock: 0 })
  const [pages, setPages] = useState(1)
  useEffect(() => {
    const stack = stackRef.current
    if (!stack) return
    const measure = () => {
      const content = stack.querySelector('.page-content')
      const marginBlock = content ? parseFloat(getComputedStyle(content).paddingTop) : 0
      setGeometry((g) =>
        g.width === stack.clientWidth && g.marginBlock === marginBlock
          ? g
          : { width: stack.clientWidth, marginBlock },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stack)
    return () => observer.disconnect()
  }, [])
  const pageHeight = Math.round(geometry.width * ratio)
  useEffect(() => {
    editor.commands.onPages(setPages)
    return () => {
      if (!editor.isDestroyed) editor.commands.onPages(null)
    }
  }, [editor])
  useEffect(() => {
    editor.commands.setPageLayout({
      enabled: paged && pageHeight > 0,
      contentHeight: pageHeight - 2 * geometry.marginBlock,
      pitch: pageHeight + PAGE_GAP,
    })
  }, [editor, paged, pageHeight, geometry.marginBlock])

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
    selectedText() {
      const { from, to } = editor.state.selection
      return editor.state.doc.textBetween(from, to, ' ').trim()
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
