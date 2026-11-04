import { useEffect, useRef, useState } from 'react'
import { api, describeError, useIpcEvent } from '../api'
import { registerFlusher } from '../saving'

const SAVE_DELAY_MS = 600
let requests = 0
const newRequestId = () => `synopsis-${Date.now()}-${++requests}`

type Fields = { synopsis: string; notes: string }

/**
 * The open chapter's synopsis (what happens in it, in a few lines) and the
 * writer's notes to self. Both are saved with the chapter as they're typed.
 * With the AI on, it can write the synopsis; it never replaces one silently.
 */
export function ChapterNotesPanel(props: {
  seriesId: string
  volumeId: string
  chapterId: string | null
  chapterTitle: string
  aiOn: boolean
}) {
  if (!props.chapterId) {
    return (
      <div className="notes-panel">
        <h2>Synopsis &amp; notes</h2>
        <p className="muted small">Open a chapter to see its synopsis and notes.</p>
      </div>
    )
  }
  return <ChapterNotes key={props.chapterId} {...props} chapterId={props.chapterId} />
}

function ChapterNotes(props: {
  seriesId: string
  volumeId: string
  chapterId: string
  chapterTitle: string
  aiOn: boolean
}) {
  const { seriesId, volumeId, chapterId } = props
  const [fields, setFields] = useState<Fields | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [proposal, setProposal] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const pending = useRef<Partial<Fields>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = () =>
    api.invoke('chapter:read', { seriesId, volumeId, chapterId }).then(
      (c) => {
        // Typed while it was being read: what's on screen wins (it's about to be saved).
        if (Object.keys(pending.current).length) return
        setFields({ synopsis: c.synopsis ?? '', notes: c.notes })
      },
      (err: unknown) => setError(describeError(err).message),
    )
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const flush = async () => {
    clearTimeout(timer.current)
    const patch = pending.current
    if (!Object.keys(patch).length) return
    pending.current = {}
    try {
      await api.invoke('chapter:save', { seriesId, volumeId, chapterId, patch })
      setSaveError(null)
    } catch (err) {
      // Kept to be sent with the next change (or on close): nothing typed is dropped.
      pending.current = { ...patch, ...pending.current }
      setSaveError(describeError(err).message)
    }
  }
  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  })
  useEffect(() => {
    const off = registerFlusher(() => flushRef.current())
    return () => {
      off()
      void flushRef.current()
    }
  }, [])

  const change = (key: keyof Fields, value: string) => {
    setFields((f) => (f ? { ...f, [key]: value } : f))
    pending.current = { ...pending.current, [key]: value }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flushRef.current(), SAVE_DELAY_MS)
  }

  // Changed on another computer (sync): show it, unless something here isn't saved yet.
  useIpcEvent('library:changed', (c) => {
    if (c.kind === 'chapter' && c.chapterId === chapterId && !Object.keys(pending.current).length) {
      void load()
    }
  })

  const askAi = async () => {
    setAsking(true)
    setError(null)
    try {
      const text = await api.invoke('ai:chapterSynopsis', {
        requestId: newRequestId(),
        seriesId,
        volumeId,
        chapterId,
      })
      if (fields && !fields.synopsis.trim()) change('synopsis', text)
      else setProposal(text)
    } catch (err) {
      setError(describeError(err).message)
    } finally {
      setAsking(false)
    }
  }

  return (
    <div className="notes-panel">
      <h2>Synopsis &amp; notes</h2>
      <p className="muted small">
        For “{props.chapterTitle || 'Untitled chapter'}”. Saved as you type.
      </p>
      {error && <p className="error small">{error}</p>}
      {saveError && <p className="error small">Not saved yet: {saveError}</p>}
      {fields && (
        <>
          <label className="notes-field">
            <span>Synopsis</span>
            <textarea
              rows={6}
              value={fields.synopsis}
              placeholder="What happens in this chapter, in a few lines."
              maxLength={5000}
              onChange={(e) => change('synopsis', e.target.value)}
            />
          </label>
          {props.aiOn && !proposal && (
            <button className="small" disabled={asking} onClick={() => void askAi()}>
              {asking ? 'The AI is reading the chapter…' : 'Write the synopsis with AI'}
            </button>
          )}
          {proposal && (
            <div className="notes-proposal">
              <p className="small muted">The AI’s synopsis:</p>
              <p className="small">{proposal}</p>
              <div className="row">
                <button
                  className="small primary"
                  onClick={() => {
                    change('synopsis', proposal)
                    setProposal(null)
                  }}
                >
                  Use this instead of mine
                </button>
                <button className="small" onClick={() => setProposal(null)}>
                  Keep mine
                </button>
              </div>
            </div>
          )}
          <label className="notes-field">
            <span>Notes</span>
            <textarea
              rows={10}
              value={fields.notes}
              placeholder="Notes to yourself: what to fix, what to remember."
              onChange={(e) => change('notes', e.target.value)}
            />
          </label>
        </>
      )}
    </div>
  )
}
