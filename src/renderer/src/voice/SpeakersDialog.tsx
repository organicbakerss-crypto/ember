import { useEffect, useState } from 'react'
import type { IpcResult } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'

type Lines = IpcResult<'voice:lines'>

/**
 * Who's speaking: every line of dialogue in the chapter with who the AI
 * thinks says it. Change any; the fix is kept (the AI never overrides it)
 * and used for reading aloud and the audiobook script.
 */
export function SpeakersDialog(props: {
  seriesId: string
  volumeId: string
  chapterId: string
  chapterTitle: string
  names: string[]
  onClose: () => void
}) {
  const { seriesId, volumeId, chapterId } = props
  const [data, setData] = useState<Lines | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState('Looking at who says what…')
  const [requestId] = useState(() => `lines-${Date.now()}`)
  useIpcEvent('ai:progress', (p) => {
    if (p.requestId === requestId && p.text) setProgress(p.text)
  })
  useEffect(() => {
    api
      .invoke('voice:lines', { requestId, seriesId, volumeId, chapterId })
      .then(setData, (e) => setError(describeError(e).message))
  }, [requestId, seriesId, volumeId, chapterId])

  const fix = (key: string, name: string) => {
    setData((d) =>
      d
        ? {
            ...d,
            lines: d.lines.map((l) =>
              l.key === key ? { ...l, speaker: name || null, fixed: true } : l,
            ),
          }
        : d,
    )
    api
      .invoke('voice:fixLine', { seriesId, volumeId, chapterId, key, name })
      .catch((e) => setError(describeError(e).message))
  }
  const names = [
    ...new Set([
      ...props.names,
      ...(data?.lines.map((l) => l.speaker).filter((n): n is string => !!n) ?? []),
    ]),
  ].sort()

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card dialog speakers-dialog"
        role="dialog"
        aria-label="Who’s speaking"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h2>Who’s speaking in “{props.chapterTitle || 'Untitled'}”</h2>
        {data?.narrator && <p className="small muted">Told by {data.narrator}.</p>}
        {error && <p className="error small">{error}</p>}
        {!data && !error && <p className="muted small">{progress}</p>}
        {data && !data.lines.length && <p className="muted small">No dialogue in this chapter.</p>}
        {data && data.lines.length > 0 && (
          <ul className="speakers-list">
            {data.lines.map((l) => (
              <li key={l.key}>
                <div className="speakers-line">
                  {l.before && <span className="muted small">…{l.before} </span>}
                  <span>{l.text}</span>
                </div>
                <select
                  aria-label={`Who says: ${l.text}`}
                  value={l.speaker ?? ''}
                  onChange={(e) => fix(l.key, e.target.value)}
                >
                  <option value="">Anyone else</option>
                  {names.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                {l.fixed && <span className="muted small">yours</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="row">
          <span className="muted small">
            Your choices are kept; reading the chapter again uses them.
          </span>
          <span className="status-spacer" />
          <button className="primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
