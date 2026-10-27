import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChapterFile } from '@shared/schema'
import { api, describeError } from '../api'
import { countWords } from '@shared/text'
import { docToPlainText, isPlainDoc, plainTextToDoc } from '../plainText'

const AUTOSAVE_DELAY_MS = 800

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'

/**
 * Temporary plain-text chapter editor, proving the save path end to end.
 * The TipTap page editor replaces it in the Writing core milestone.
 */
export function ChapterPane(props: { seriesId: string; volumeId: string; chapterId: string }) {
  const { seriesId, volumeId, chapterId } = props
  const [chapter, setChapter] = useState<ChapterFile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)

  // Latest values, read by saves that run after a render.
  const base = useRef<ChapterFile | null>(null)
  const draft = useRef({ title: '', text: '' })
  const dirty = useRef(false)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    api.invoke('chapter:read', { seriesId, volumeId, chapterId }).then(
      (file) => {
        base.current = file
        draft.current = { title: file.title, text: docToPlainText(file.content) }
        setChapter(file)
        setTitle(draft.current.title)
        setText(draft.current.text)
      },
      (err) => setLoadError(describeError(err).message),
    )
  }, [seriesId, volumeId, chapterId])

  /** Saves are queued so they reach the disk in order, each from the latest draft. */
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    queue.current = queue.current.then(async () => {
      if (!dirty.current || !base.current) return
      dirty.current = false
      setSaveState('saving')
      try {
        const { title: t, text: body } = draft.current
        const next = { ...base.current, title: t, content: plainTextToDoc(body) }
        base.current = await api.invoke('chapter:save', { seriesId, volumeId, chapter: next })
        setSaveError(null)
        setSaveState(dirty.current ? 'unsaved' : 'saved')
      } catch (err) {
        dirty.current = true
        setSaveError(describeError(err).message)
        setSaveState('error')
      }
    })
  }, [seriesId, volumeId])

  // Never drop words when switching chapters, closing the pane or closing the window.
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flush])

  const edit = (patch: Partial<typeof draft.current>) => {
    draft.current = { ...draft.current, ...patch }
    dirty.current = true
    setSaveState('unsaved')
    clearTimeout(timer.current)
    timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS)
  }

  if (loadError) return <p className="error">{loadError}</p>
  if (!chapter) return null
  const editable = isPlainDoc(chapter.content)

  return (
    <section className="page-area">
      <article className="page">
        <input
          className="chapter-title"
          value={title}
          placeholder="Untitled chapter"
          readOnly={!editable}
          onChange={(e) => {
            setTitle(e.target.value)
            edit({ title: e.target.value })
          }}
          onBlur={flush}
        />
        {editable ? (
          <textarea
            className="chapter-body"
            value={text}
            spellCheck
            placeholder="Start writing…"
            onChange={(e) => {
              setText(e.target.value)
              edit({ text: e.target.value })
            }}
            onBlur={flush}
          />
        ) : (
          <p className="muted">
            This chapter has formatting this early editor can't show. It is left untouched.
          </p>
        )}
      </article>
      <footer className="status-bar small">
        <span>{countWords(text).toLocaleString()} words</span>
        <span className={saveState === 'error' ? 'error' : 'muted'}>
          {saveState === 'error' ? `Not saved: ${saveError}` : saveLabels[saveState]}
        </span>
      </footer>
    </section>
  )
}

const saveLabels: Record<Exclude<SaveState, 'error'>, string> = {
  saved: 'Saved',
  unsaved: 'Editing…',
  saving: 'Saving…',
}
