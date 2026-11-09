import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AiCharacterFile } from '@shared/schema'
import { diffText } from '@shared/ai/diff'
import {
  MAX_SELECTION_CHARS,
  SELECTION_LABELS,
  type SelectionAction,
  type SelectionAnswer,
} from '@shared/ai/selection'
import { api, describeError } from '../api'

const newRequestId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

export interface AiSelection {
  from: number
  to: number
  text: string
  before: string
  after: string
  rect: { left: number; top: number; bottom: number }
}

/**
 * The box by the selection for right-click → AI: the AI's options, each with
 * Use. Nothing changes the page until one is used (one undoable step).
 */
export function SelectionAiBox(props: {
  action: SelectionAction
  selection: AiSelection
  /** The story's world, for "in a character's voice". */
  worldId: string | null
  /** Puts an option in place of the selection; false when the text changed meanwhile. */
  onUse: (text: string) => boolean
  onClose: () => void
}) {
  const { action, selection } = props
  const [answer, setAnswer] = useState<SelectionAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [cast, setCast] = useState<AiCharacterFile[] | null>(action === 'voice' ? null : [])
  const [characterId, setCharacterId] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState({ left: selection.rect.left, top: selection.rect.bottom + 8 })

  const tooLong = selection.text.length > MAX_SELECTION_CHARS

  const run = (who: string | null = characterId) => {
    if (tooLong) return
    const id = newRequestId()
    setRequestId(id)
    setAnswer(null)
    setError(null)
    api
      .invoke('ai:selection', {
        requestId: id,
        action,
        text: selection.text,
        before: selection.before,
        after: selection.after,
        ...(who && props.worldId
          ? { character: { worldId: props.worldId, characterId: who } }
          : {}),
      })
      .then(
        (a) => setAnswer(a),
        (err) => {
          const e = describeError(err)
          if (e.code !== 'cancelled') setError(e.message)
        },
      )
      .finally(() => setRequestId((current) => (current === id ? null : current)))
  }

  // Starts at once, except "in a character's voice", which asks who first.
  // (After this render, not during it.)
  useEffect(() => {
    const t = setTimeout(() => {
      if (action !== 'voice') run(null)
      else if (!props.worldId) setCast([])
      else api.invoke('character:list', { worldId: props.worldId }).then(setCast, () => setCast([]))
    })
    return () => clearTimeout(t)
    // Once, when the box opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Stops the request if the box closes first.
  const running = useRef<string | null>(null)
  useEffect(() => {
    running.current = requestId
  }, [requestId])
  useEffect(
    () => () => {
      if (running.current) void api.invoke('ai:cancel', { requestId: running.current })
    },
    [],
  )

  // Esc closes; kept on screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(8, Math.min(place.left, window.innerWidth - r.width - 8))
    let top = place.top
    if (top + r.height > window.innerHeight - 8)
      top = Math.max(8, selection.rect.top - r.height - 8)
    if (left !== place.left || top !== place.top) setPlace({ left, top })
  }, [place.left, place.top, selection.rect.top, answer, error, cast, characterId, requestId])

  const use = (text: string) => {
    if (props.onUse(text)) props.onClose()
    else setError('The text changed since you asked. Select it again and ask again.')
  }

  const title =
    action === 'voice' && characterId
      ? `In ${cast?.find((c) => c.id === characterId)?.name ?? 'their'}’s voice`
      : SELECTION_LABELS[action].replace('…', '')

  return (
    <div
      ref={box}
      className="selection-ai card"
      role="dialog"
      aria-label={title}
      style={{ left: place.left, top: place.top }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="row">
        <strong className="small">{title}</strong>
        <span className="status-spacer" />
        <button className="icon" aria-label="Close" title="Close (Esc)" onClick={props.onClose}>
          ×
        </button>
      </div>
      {tooLong ? (
        <p className="small error">
          That’s too much at once (about {Math.round(MAX_SELECTION_CHARS / 6)} words at most).
          Select less, or use Edit chapter for the whole chapter.
        </p>
      ) : action === 'voice' && !characterId ? (
        cast === null ? (
          <p className="muted small">Loading your characters…</p>
        ) : cast.length === 0 ? (
          <p className="muted small">
            No story characters yet. Set one up in Settings → AI → Your story characters (or on
            their world page).
          </p>
        ) : (
          <div className="selection-ai-who">
            <span className="muted small">Who’s speaking?</span>
            {cast.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setCharacterId(c.id)
                  run(c.id)
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        )
      ) : requestId ? (
        <div className="row">
          <span className="muted small">Thinking…</span>
          <span className="status-spacer" />
          <button
            className="link small"
            onClick={() => void api.invoke('ai:cancel', { requestId })}
          >
            Stop
          </button>
        </div>
      ) : error ? (
        <p className="small error">{error}</p>
      ) : answer ? (
        <>
          {answer.note && <p className="small selection-ai-note">{answer.note}</p>}
          {action === 'word' ? (
            <div className="selection-ai-words">
              {answer.options.map((o) => (
                <button key={o} onClick={() => use(o)} title="Use this word">
                  {o}
                </button>
              ))}
            </div>
          ) : (
            answer.options.map((o, i) => (
              <div key={i} className="selection-ai-option">
                <p className="small">
                  {action === 'fix' ? <Changes before={selection.text} after={o} /> : o}
                </p>
                <button className="small" onClick={() => use(o)}>
                  Use
                </button>
              </div>
            ))
          )}
          {!answer.options.length && !answer.note && (
            <p className="muted small">No suggestions came back.</p>
          )}
        </>
      ) : null}
      {!tooLong && !requestId && (answer || error) && (
        <div className="row">
          <button className="link small" onClick={() => run()}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

/** The fixed text, with what changed marked (struck-out old, highlighted new). */
function Changes(props: { before: string; after: string }) {
  const changes = diffText(props.before, props.after)
  const out: React.ReactNode[] = []
  let at = 0
  changes.forEach((c, i) => {
    out.push(props.before.slice(at, c.start))
    if (c.before) out.push(<del key={`d${i}`}>{c.before}</del>)
    if (c.after) out.push(<ins key={`i${i}`}>{c.after}</ins>)
    at = c.end
  })
  out.push(props.before.slice(at))
  return <>{out}</>
}
