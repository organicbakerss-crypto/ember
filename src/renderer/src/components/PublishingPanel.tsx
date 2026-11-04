import { useCallback, useEffect, useState } from 'react'
import type { PublishingRow } from '@shared/ipc'
import type { PublishInfo } from '@shared/schema'
import { api, describeError, useIpcEvent } from '../api'

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const dayLabel = (date: string) =>
  date
    ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      })
    : 'no date'

/** The publishing tracker: what's posted, what's scheduled, and what's written but not out yet. */
export function PublishingPanel(props: {
  seriesId: string
  onOpenChapter: (volumeId: string, chapterId: string) => void
  /** A chapter's publishing changed (the binder shows it). */
  onChanged?: () => void
}) {
  const { seriesId } = props
  const [rows, setRows] = useState<PublishingRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(
    () =>
      api
        .invoke('publishing:list', { seriesId })
        .then(setRows, (err: unknown) => setError(describeError(err).message)),
    [seriesId],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])
  useIpcEvent('library:changed', (c) => {
    if ((c.kind === 'chapter' || c.kind === 'outline') && c.seriesId === seriesId) void refresh()
  })

  const set = async (row: PublishingRow, publish: PublishInfo | null) => {
    setRows(
      (all) => all?.map((r) => (r.chapterId === row.chapterId ? { ...r, publish } : r)) ?? all,
    )
    try {
      await api.invoke('chapter:save', {
        seriesId,
        volumeId: row.volumeId,
        chapterId: row.chapterId,
        patch: { publish },
      })
      props.onChanged?.()
    } catch (err) {
      setError(describeError(err).message)
      void refresh()
    }
  }

  if (!rows) return <p className="muted small">{error ?? 'Loading…'}</p>
  const posted = rows.filter((r) => r.publish?.status === 'posted')
  const scheduled = rows
    .filter((r) => r.publish?.status === 'scheduled')
    .sort((a, b) => (a.publish!.date || '9').localeCompare(b.publish!.date || '9'))
  const waiting = rows.filter((r) => !r.publish && r.words > 0)
  const ready = waiting.filter((r) => r.status === 'done')
  const lastPosted = posted
    .map((r) => r.publish!.date)
    .filter(Boolean)
    .sort()
    .pop()
  const multi = new Set(rows.map((r) => r.volumeId)).size > 1

  return (
    <div className="publishing-panel">
      <h2>Publishing</h2>
      <ul className="publishing-summary small">
        <li>
          <strong>{posted.length}</strong> posted
          {lastPosted ? ` · last on ${dayLabel(lastPosted)}` : ''}
        </li>
        <li>
          <strong>{scheduled.length}</strong> scheduled
          {scheduled[0] ? ` · next ${dayLabel(scheduled[0].publish!.date)}` : ''}
        </li>
        <li>
          <strong>{waiting.length}</strong> written, not posted yet
          {ready.length ? ` (${ready.length} marked Done)` : ''}
        </li>
      </ul>
      {error && <p className="error small">{error}</p>}
      <ol className="publishing-list">
        {rows.map((row) => {
          const p = row.publish
          return (
            <li key={row.chapterId} className={`publishing-row ${p?.status ?? 'none'}`}>
              <button
                className="link publishing-title"
                onClick={() => props.onOpenChapter(row.volumeId, row.chapterId)}
              >
                {multi ? `${row.volumeName} › ` : ''}
                {row.label}
                {row.title ? `: ${row.title}` : ''}
              </button>
              <div className="publishing-controls small">
                <select
                  aria-label={`Publishing: ${row.title || row.label}`}
                  value={p?.status ?? ''}
                  onChange={(e) => {
                    const status = e.target.value
                    void set(
                      row,
                      status === 'posted' || status === 'scheduled'
                        ? {
                            status,
                            date: p?.date || (status === 'posted' ? today() : ''),
                            url: p?.url ?? '',
                          }
                        : null,
                    )
                  }}
                >
                  <option value="">Not posted</option>
                  <option value="scheduled">Scheduled</option>
                  <option value="posted">Posted</option>
                </select>
                {p && (
                  <input
                    type="date"
                    aria-label="Date"
                    value={p.date}
                    onChange={(e) => void set(row, { ...p, date: e.target.value })}
                  />
                )}
                {p?.status === 'posted' && (
                  <LinkField value={p.url} onSave={(url) => void set(row, { ...p, url })} />
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function LinkField(props: { value: string; onSave: (url: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="url"
      aria-label="Link"
      placeholder="Link (optional)"
      value={draft ?? props.value}
      onFocus={() => setDraft(props.value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== props.value) props.onSave(draft.trim())
        setDraft(null)
      }}
    />
  )
}
