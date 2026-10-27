import { useCallback, useEffect, useState } from 'react'
import type { SnapshotInfo } from '@shared/ipc'
import type { RichTextDoc } from '@shared/schema'
import { api, describeError, useIpcEvent } from '../api'
import { ReadOnlyDoc } from '../editor/ReadOnlyDoc'
import { flushAll } from '../saving'
import { useOverlays } from './overlays'
import { formatWhen } from './TrashPage'

const REASONS: Record<SnapshotInfo['reason'], string> = {
  auto: '',
  manual: 'kept by you',
  'before-deletion': 'before a deletion',
  'before-restore': 'before a restore',
  'before-replace': 'before replace all',
}

/** Earlier versions of the open chapter. Preview one, then restore it if wanted. */
export function HistoryPanel(props: {
  seriesId: string
  volumeId: string
  chapterId: string | null
  chapterTitle: string
  /** Word count of the text on the page now. */
  currentWords: number | null
  /** Called after a restore so the page reloads the chapter. */
  onRestored: () => void
}) {
  const { seriesId, volumeId, chapterId } = props
  const [list, setList] = useState<SnapshotInfo[] | null>(null)
  const [preview, setPreview] = useState<{ info: SnapshotInfo; content: RichTextDoc } | null>(null)
  const { toast } = useOverlays()

  const refresh = useCallback(() => {
    if (!chapterId) return
    api
      .invoke('history:list', { seriesId, volumeId, chapterId })
      .then(setList, (err) => toast(describeError(err).message))
  }, [seriesId, volumeId, chapterId, toast])
  useEffect(refresh, [refresh])
  useIpcEvent(
    'library:changed',
    (c) => c.kind === 'chapter' && c.chapterId === chapterId && refresh(),
  )

  const open = async (info: SnapshotInfo) => {
    if (!chapterId) return
    try {
      setPreview(
        await api.invoke('history:read', { seriesId, volumeId, chapterId, snapshotId: info.id }),
      )
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const restore = async () => {
    if (!preview || !chapterId) return
    try {
      await flushAll()
      await api.invoke('history:restore', {
        seriesId,
        volumeId,
        chapterId,
        snapshotId: preview.info.id,
      })
      setPreview(null)
      props.onRestored()
      toast(
        `Restored the version from ${formatWhen(preview.info.savedAt)}. The text it replaced is in the history.`,
      )
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const keepNow = async () => {
    if (!chapterId) return
    try {
      await flushAll()
      await api.invoke('history:keep', { seriesId, volumeId, chapterId })
      toast('This version has been kept.')
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  if (!chapterId) return <p className="muted small">Open a chapter to see its history.</p>
  return (
    <div className="history-panel">
      <h2>History</h2>
      <p className="muted small">
        Versions of “{props.chapterTitle || 'Untitled chapter'}”. One is kept every 10 minutes while
        you write, and always just before you delete a chunk of text (20+ characters).
      </p>
      <button onClick={() => void keepNow()}>Keep this version now</button>
      <ol className="history-list">
        <li>
          <div className="history-item current">
            <span>Now (on the page)</span>
            {props.currentWords !== null && (
              <span className="muted small">{props.currentWords.toLocaleString()} words</span>
            )}
          </div>
        </li>
        {list?.map((s) => (
          <li key={s.id}>
            <button className="history-item" onClick={() => void open(s)}>
              <span>{formatWhen(s.savedAt)}</span>
              <span className="muted small">
                {s.wordCount.toLocaleString()} words{REASONS[s.reason] && ` · ${REASONS[s.reason]}`}
              </span>
            </button>
          </li>
        ))}
      </ol>
      {list?.length === 0 && (
        <p className="muted small">
          No earlier versions yet. Click one when it appears to preview it.
        </p>
      )}

      {preview && (
        <div className="modal-backdrop" onMouseDown={() => setPreview(null)}>
          <div
            className="history-preview"
            role="dialog"
            aria-label="Earlier version"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className="history-preview-header">
              <div>
                <strong>{preview.info.title || 'Untitled chapter'}</strong>
                <span className="muted small">
                  {' '}
                  · {formatWhen(preview.info.savedAt)} · {preview.info.wordCount.toLocaleString()}{' '}
                  words
                </span>
              </div>
              <div className="row">
                <button className="primary" onClick={() => void restore()}>
                  Restore this version
                </button>
                <button onClick={() => setPreview(null)}>Close</button>
              </div>
            </header>
            <div className="history-preview-page page">
              <ReadOnlyDoc content={preview.content} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
