import { useCallback, useEffect, useState } from 'react'
import type { TrashEntry } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'
import { useOverlays } from './overlays'

const KIND_LABELS: Record<TrashEntry['kind'], string> = {
  series: 'Series',
  volume: 'Volume',
  world: 'World',
  chapter: 'Chapter',
  entry: 'World entry',
  map: 'Map',
}

/** Deleted items on this device. Nothing is erased until the trash is emptied. */
export function TrashPage(props: { onBack: () => void }) {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const { toast, choose } = useOverlays()

  const refresh = useCallback(() => {
    api.invoke('trash:list').then(setEntries, (err) => toast(describeError(err).message))
  }, [toast])
  useEffect(refresh, [refresh])
  useIpcEvent('library:changed', (change) => change.kind === 'trash' && refresh())

  const run = async (action: () => Promise<unknown>, done?: string) => {
    try {
      await action()
      if (done) toast(done)
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const purge = async (entry: TrashEntry) => {
    const answer = await choose(
      `Delete “${entry.name}” forever?`,
      [{ value: 'delete', label: 'Delete forever', danger: true }],
      'This cannot be undone.',
    )
    if (answer) await run(() => api.invoke('trash:purge', { trashId: entry.id }))
  }

  const empty = async () => {
    const answer = await choose(
      'Empty the trash?',
      [{ value: 'empty', label: 'Empty trash', danger: true }],
      `Everything in the trash on this device (${entries?.length ?? 0} items, plus replaced covers) will be erased. This cannot be undone.`,
    )
    if (answer) await run(() => api.invoke('trash:empty'))
  }

  return (
    <main className="series-page trash-page">
      <header className="page-header">
        <button className="link" onClick={props.onBack}>
          ← Bookshelf
        </button>
        <div className="row trash-heading">
          <h1>Trash</h1>
          {!!entries?.length && (
            <button className="danger" onClick={() => void empty()}>
              Empty trash
            </button>
          )}
        </div>
        <p className="muted">Deleted items stay here, on this device, until you empty the trash.</p>
      </header>

      {entries?.length === 0 && <p className="muted">The trash is empty.</p>}
      <ul className="trash-list">
        {entries?.map((entry) => (
          <li key={entry.id} className="trash-item card">
            <div className="trash-info">
              <span className="muted small">{KIND_LABELS[entry.kind]}</span>
              <strong>{entry.name}</strong>
              <span className="muted small">
                {entry.from ? `from ${entry.from} · ` : ''}deleted {formatWhen(entry.deletedAt)}
              </span>
            </div>
            <div className="row">
              <button
                className="primary"
                onClick={() =>
                  void run(
                    () => api.invoke('trash:restore', { trashId: entry.id }),
                    `“${entry.name}” restored.`,
                  )
                }
              >
                Restore
              </button>
              <button onClick={() => void purge(entry)}>Delete forever</button>
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}

export function formatWhen(iso: string): string {
  const date = new Date(iso)
  const minutes = Math.round((Date.now() - date.getTime()) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const sameDay = new Date().toDateString() === date.toDateString()
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return `today at ${time}`
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} at ${time}`
}
