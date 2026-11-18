import { useState } from 'react'
import type { SeriesSummary } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'

/**
 * Go over the whole story (or one book): the AI first reads every chapter it
 * hasn't (or that changed since), then looks across the story for what one
 * chapter at a time can't show. What it finds waits in the inbox.
 */
export function GoOverDialog(props: {
  stories: SeriesSummary[]
  onClose: () => void
  onOpenInbox: () => void
}) {
  const [seriesId, setSeriesId] = useState(props.stories[0]?.id ?? '')
  const [volumeId, setVolumeId] = useState('')
  const [requestId, setRequestId] = useState<string | null>(null)
  const [progress, setProgress] = useState('Starting…')
  const [done, setDone] = useState<{ read: number; found: number; questions: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useIpcEvent('ai:progress', (e) => {
    if (e.requestId === requestId && e.text) setProgress(e.text)
  })
  const story = props.stories.find((s) => s.id === seriesId)
  const start = async () => {
    const id = `goover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setRequestId(id)
    setError(null)
    setProgress('Starting…')
    try {
      setDone(
        await api.invoke('ai:goOver', { requestId: id, seriesId, volumeId: volumeId || null }),
      )
    } catch (err) {
      const e = describeError(err)
      setError(
        e.code === 'cancelled'
          ? 'Stopped. What it found so far is in the inbox; running it again carries on.'
          : e.message,
      )
    } finally {
      setRequestId(null)
    }
  }
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onClick={() => !requestId && props.onClose()}
    >
      <div
        className="card stack dialog go-over"
        role="dialog"
        aria-label="Go over the whole story"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Go over the whole story</h2>
        <p className="small muted">
          First, any chapter that was never run through Update the world, or changed since, is read.
          Then the AI looks across all the chapters for what one at a time can’t show: connections
          that build up over several chapters, people who turn out to be the same person, facts that
          are out of date, people who keep turning up. Everything waits in the inbox; when it isn’t
          sure, it asks.
        </p>
        {!done && (
          <>
            {props.stories.length > 1 && (
              <label>
                Story
                <select
                  value={seriesId}
                  disabled={!!requestId}
                  onChange={(e) => {
                    setSeriesId(e.target.value)
                    setVolumeId('')
                  }}
                >
                  {props.stories.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {story && story.volumes.length > 1 && (
              <label>
                Go over
                <select
                  aria-label="Go over"
                  value={volumeId}
                  disabled={!!requestId}
                  onChange={(e) => setVolumeId(e.target.value)}
                >
                  <option value="">The whole story</option>
                  {story.volumes.map((v) => (
                    <option key={v.id} value={v.id}>
                      Just {v.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {requestId && (
          <>
            <p className="small" role="status">
              {progress}
            </p>
            <progress />
          </>
        )}
        {error && <p className="error small">{error}</p>}
        {done && (
          <p>
            {done.read
              ? `Caught up on ${done.read} ${done.read === 1 ? 'chapter' : 'chapters'}, then looked for gaps: `
              : 'Every chapter was already read; looked for gaps: '}
            {done.found || done.questions
              ? `${done.found} ${done.found === 1 ? 'suggestion' : 'suggestions'} and ${done.questions} ${done.questions === 1 ? 'question' : 'questions'} are waiting in the inbox.`
              : 'nothing more to add.'}
          </p>
        )}
        <div className="row">
          {done ? (
            <>
              <button className="primary" onClick={props.onOpenInbox}>
                Open the inbox
              </button>
              <button onClick={props.onClose}>Close</button>
            </>
          ) : requestId ? (
            <button onClick={() => void api.invoke('ai:cancel', { requestId })}>Stop</button>
          ) : (
            <>
              <button className="primary" disabled={!seriesId} onClick={() => void start()}>
                Go over it
              </button>
              <button onClick={props.onClose}>Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
