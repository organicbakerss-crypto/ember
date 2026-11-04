import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Color, FontFamily, TextStyle } from '@tiptap/extension-text-style'
import type { SeriesSummary, VolumeSummary } from '@shared/ipc'
import type { ChapterFile } from '@shared/schema'
import { chapterHeading, numberChapters } from '@shared/manuscript/blocks'
import { api, describeError, useIpcEvent } from '../api'
import { Cover } from '../components/Cover'
import { volumeCover } from '../covers'
import { Toolbar } from '../editor/Toolbar'
import { SceneBreak } from '../editor/sceneBreak'
import { usePane } from '../panes/PaneContext'
import { registerFlusher } from '../saving'
import {
  ChapterSection,
  INTERNAL,
  ManuscriptDocument,
  SectionGuard,
  sectionsById,
} from './sections'
import type { Node as PMNode } from '@tiptap/pm/model'

/** Save after this long without typing, or at least this often while typing nonstop. */
const PAUSE_MS = 800
const MAX_WAIT_MS = 5000
const RETRY_MS = 5000

type Loaded = { chapters: ChapterFile[]; readOnly: Set<string> }

/**
 * The whole book (or volume) as one document: the cover as page zero, a
 * title page, then every chapter under its heading as a printed book shows
 * it. Typing anywhere edits that chapter, and each changed chapter is saved
 * to its own file (autosave, history and all). Chapter boundaries are locked;
 * a chapter being edited in another window or pane is shown read-only here.
 */
export function ManuscriptView(props: {
  series: SeriesSummary
  volume: VolumeSummary
  chapterIds: string[]
  headings: 'both' | 'number' | 'title'
  author: string
  onClose: () => void
}) {
  const { series, volume, chapterIds } = props
  const pane = usePane()
  const holder = `${pane.id}:manuscript`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Ask to edit every chapter (those edited elsewhere stay read-only), and read them.
  useEffect(() => {
    let live = true
    const keys = chapterIds.map((id) => `chapter:${id}`)
    void (async () => {
      try {
        const claims = await Promise.all(
          keys.map((key) =>
            api
              .invoke('doc:claim', { key, pane: holder, take: false })
              .catch(() => ({ editing: true })),
          ),
        )
        const chapters = await Promise.all(
          chapterIds.map((chapterId) =>
            api.invoke('chapter:read', { seriesId: series.id, volumeId: volume.id, chapterId }),
          ),
        )
        if (!live) return
        setLoaded({
          chapters,
          readOnly: new Set(chapterIds.filter((_, i) => !claims[i]!.editing)),
        })
      } catch (err) {
        if (live) setError(describeError(err).message)
      }
    })()
    return () => {
      live = false
      for (const key of keys) void api.invoke('doc:release', { key, pane: holder }).catch(() => {})
    }
  }, [chapterIds, holder, series.id, volume.id])

  const book = series.kind === 'book'
  return (
    <div className="manuscript">
      <div className="manuscript-bar small">
        <strong>Manuscript</strong>
        <span className="muted">
          The whole {book ? 'book' : 'volume'}; type anywhere to edit that chapter.
        </span>
        <span className="status-spacer" />
        <button onClick={props.onClose}>Back to chapters</button>
      </div>
      {error && <p className="error page-message">{error}</p>}
      {!loaded && !error && <p className="muted page-message">Putting the book together…</p>}
      {loaded && (
        <ManuscriptEditor
          {...props}
          holder={holder}
          chapters={loaded.chapters}
          initialReadOnly={loaded.readOnly}
        />
      )}
    </div>
  )
}

function ManuscriptEditor(props: {
  series: SeriesSummary
  volume: VolumeSummary
  headings: 'both' | 'number' | 'title'
  author: string
  holder: string
  chapters: ChapterFile[]
  initialReadOnly: Set<string>
}) {
  const { series, volume, holder } = props
  // A plain holder (not a ref) because the section guard reads it while the editor is built.
  const [readOnly] = useState(() => ({ current: new Set(props.initialReadOnly) }))
  const [, setLockVersion] = useState(0)
  const [saveState, setSaveState] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved')
  // What each chapter's section was when last saved (or loaded): a changed one is saved.
  const saved = useRef(new Map<string, PMNode>())
  const dirty = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const firstChange = useRef<number | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())

  const numbered = numberChapters(props.chapters.map((c) => ({ ...c, type: c.type })))
  const [content] = useState<JSONContent>(() => ({
    type: 'doc',
    content: props.chapters.map((c, i) => ({
      type: 'chapterSection',
      attrs: {
        chapterId: c.id,
        heading: chapterHeading(
          { title: c.title, type: c.type, number: numbered[i]!.number, blocks: [] },
          { headings: props.headings, sceneBreak: '* * *', paragraphs: 'spaced' },
        ),
      },
      content: c.content.content?.length ? c.content.content : [{ type: 'paragraph' }],
    })),
  }))

  const editorRef = useRef<ReturnType<typeof useEditor>>(null)
  const retry = useRef<() => void>(() => {})
  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current)
    firstChange.current = null
    const editor = editorRef.current
    if (!editor || !dirty.current.size) return queue.current
    const sections = sectionsById(editor.state.doc)
    const work = [...dirty.current]
    dirty.current.clear()
    queue.current = queue.current.then(async () => {
      setSaveState('saving')
      for (const chapterId of work) {
        const node = sections.get(chapterId)
        if (!node || readOnly.current.has(chapterId)) continue
        try {
          await api.invoke('chapter:save', {
            seriesId: series.id,
            volumeId: volume.id,
            chapterId,
            patch: { content: { type: 'doc', content: node.content.toJSON() as JSONContent[] } },
          })
          saved.current.set(chapterId, node)
        } catch {
          // Kept and tried again shortly: nothing typed is dropped.
          dirty.current.add(chapterId)
          setSaveState('error')
          clearTimeout(timer.current)
          timer.current = setTimeout(() => retry.current(), RETRY_MS)
          return
        }
      }
      setSaveState(dirty.current.size ? 'unsaved' : 'saved')
    })
    return queue.current
  }, [series.id, volume.id, readOnly])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        document: false,
        heading: { levels: [2, 3] },
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: false,
      }),
      TextStyle,
      Color,
      FontFamily,
      SceneBreak,
      ManuscriptDocument,
      ChapterSection,
      SectionGuard(() => readOnly.current),
    ],
    content,
    editorProps: {
      attributes: { class: 'chapter-content manuscript-content', spellcheck: 'true' },
    },
    onCreate: ({ editor: e }) => {
      for (const [id, node] of sectionsById(e.state.doc)) saved.current.set(id, node)
    },
    onUpdate: ({ editor: e, transaction }) => {
      if (transaction.getMeta(INTERNAL)) return
      for (const [id, node] of sectionsById(e.state.doc)) {
        if (saved.current.get(id) !== node && !saved.current.get(id)?.eq(node))
          dirty.current.add(id)
      }
      if (!dirty.current.size) return
      setSaveState('unsaved')
      firstChange.current ??= Date.now()
      clearTimeout(timer.current)
      const wait = Math.min(PAUSE_MS, MAX_WAIT_MS - (Date.now() - firstChange.current))
      timer.current = setTimeout(() => void flush(), Math.max(0, wait))
    },
  })
  useEffect(() => {
    editorRef.current = editor
  }, [editor])
  useEffect(() => {
    retry.current = () => void flush()
  }, [flush])

  // Save whatever's pending when asked (closing, switching) and when this closes.
  useEffect(() => {
    const off = registerFlusher(flush)
    return () => {
      off()
      void flush()
    }
  }, [flush])

  /** Puts a chapter's saved text in its section (it changed elsewhere). */
  const reload = useCallback(
    async (chapterId: string) => {
      const e = editorRef.current
      if (!e) return
      const chapter = await api.invoke('chapter:read', {
        seriesId: series.id,
        volumeId: volume.id,
        chapterId,
      })
      let at = -1
      e.state.doc.forEach((n, offset) => {
        if (n.attrs['chapterId'] === chapterId) at = offset
      })
      if (at < 0) return
      const old = e.state.doc.nodeAt(at)!
      const fresh = e.schema.nodeFromJSON({
        type: 'chapterSection',
        attrs: old.attrs,
        content: chapter.content.content?.length
          ? chapter.content.content
          : [{ type: 'paragraph' }],
      })
      e.view.dispatch(
        e.state.tr
          .replaceWith(at, at + old.nodeSize, fresh)
          .setMeta(INTERNAL, true)
          .setMeta('addToHistory', false),
      )
      saved.current.set(chapterId, sectionsById(e.state.doc).get(chapterId)!)
    },
    [series.id, volume.id],
  )

  const lock = (chapterId: string, on: boolean) => {
    if (on) readOnly.current.add(chapterId)
    else readOnly.current.delete(chapterId)
    setLockVersion((v) => v + 1)
    // Redraw the read-only shading.
    editorRef.current?.view.dispatch(editorRef.current.state.tr.setMeta('manuscript-lock', true))
  }

  // Another place takes a chapter: save it, then show it read-only here.
  useIpcEvent('doc:yield', (request) => {
    if (request.pane !== holder || !request.key.startsWith('chapter:')) return
    const chapterId = request.key.slice('chapter:'.length)
    void flush().finally(() => {
      lock(chapterId, true)
      void api.invoke('doc:yielded', { key: request.key, pane: holder })
    })
  })
  // Sync gave a chapter back after writing the other computer's version: load it, edit again.
  useIpcEvent('doc:returned', (back) => {
    if (back.pane !== holder || !back.key.startsWith('chapter:')) return
    const chapterId = back.key.slice('chapter:'.length)
    void api
      .invoke('doc:claim', { key: back.key, pane: holder, take: false })
      .then(async (r) => {
        if (r.editing) {
          await reload(chapterId).catch(() => {})
          lock(chapterId, false)
        }
      })
      .catch(() => {})
  })
  // A chapter edited elsewhere changed: show the new text here.
  useIpcEvent('library:changed', (c) => {
    if (c.kind !== 'chapter' || c.volumeId !== volume.id) return
    if (readOnly.current.has(c.chapterId)) void reload(c.chapterId).catch(() => {})
  })

  if (!editor) return null
  return (
    <>
      <Toolbar editor={editor} />
      <div className="page-scroll">
        <div className="manuscript-front">
          <div className="manuscript-cover" aria-label="Cover">
            <Cover source={volumeCover(series, volume)} />
          </div>
          <div className="page manuscript-title-page" aria-label="Title page">
            <h1>{volume.name}</h1>
            {series.kind !== 'book' && <p className="muted">{series.name}</p>}
            {props.author && <p>{props.author}</p>}
          </div>
        </div>
        <div className="page manuscript-page">
          <EditorContent editor={editor} onBlur={() => void flush()} />
        </div>
        <p className="muted small manuscript-save" role="status">
          {saveState === 'saved'
            ? 'Saved'
            : saveState === 'saving'
              ? 'Saving…'
              : saveState === 'error'
                ? 'Couldn’t save; trying again…'
                : 'Editing…'}
        </p>
      </div>
    </>
  )
}
