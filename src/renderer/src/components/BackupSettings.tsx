import { useCallback, useEffect, useState } from 'react'
import type { IpcResult } from '@shared/ipc'
import { api, describeError } from '../api'
import { flushAll } from '../saving'
import { formatWhen } from './TrashPage'

type Status = IpcResult<'backup:status'>

const size = (bytes: number) =>
  bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`

/** Settings → Backups: a zip of the whole library, now and then, in a folder you choose. */
export function BackupSettingsSection() {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(
    () =>
      api
        .invoke('backup:status')
        .then(setStatus, (err: unknown) => setError(describeError(err).message)),
    [],
  )
  useEffect(() => {
    void refresh()
  }, [refresh])

  const configure = async (change: IpcInput) => {
    try {
      await api.invoke('backup:configure', change)
      await refresh()
    } catch (err) {
      setError(describeError(err).message)
    }
  }
  const choose = async () => {
    const folder = await api.invoke('backup:chooseFolder').catch(() => null)
    if (folder) await refresh()
  }
  const now = async () => {
    setBusy(true)
    setError(null)
    try {
      await flushAll()
      await api.invoke('backup:now')
    } catch (err) {
      setError(describeError(err).message)
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  if (!status) return <p className="muted">{error ?? 'Loading…'}</p>
  const s = status.settings
  const last = status.backups[0]
  return (
    <section className="settings-section">
      <p className="muted small">
        A zip of your whole library (every story, world, picture and version history), saved to a
        folder now and then. Sync isn’t a backup: if something is deleted, the deletion syncs too.
        Pick a folder outside the library, ideally on another drive or a cloud folder.
      </p>
      <label className="radio">
        <input
          type="checkbox"
          checked={s.enabled}
          disabled={!s.folder}
          onChange={(e) => void configure({ enabled: e.target.checked })}
        />
        Back up automatically
      </label>
      <div className="row">
        <span className="small">{s.folder || 'No folder chosen yet.'}</span>
        <button className="small" onClick={() => void choose()}>
          {s.folder ? 'Change folder…' : 'Choose a folder…'}
        </button>
        {s.folder && (
          <button className="small" onClick={() => void api.invoke('backup:open')}>
            Show backups
          </button>
        )}
      </div>
      <label>
        How often
        <select
          value={s.everyHours}
          onChange={(e) => void configure({ everyHours: Number(e.target.value) })}
        >
          <option value={6}>Every 6 hours</option>
          <option value={24}>Once a day</option>
          <option value={168}>Once a week</option>
        </select>
      </label>
      <label>
        Keep
        <select value={s.keep} onChange={(e) => void configure({ keep: Number(e.target.value) })}>
          {[5, 10, 20, 50].map((n) => (
            <option key={n} value={n}>
              The newest {n}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">Older ones go to the system trash.</p>
      <div className="row">
        <button
          className="primary small"
          disabled={!s.folder || busy || status.running}
          onClick={() => void now()}
        >
          {busy || status.running ? 'Backing up…' : 'Back up now'}
        </button>
        <span className="muted small" role="status">
          {last
            ? `Last backup: ${formatWhen(last.at)} (${size(last.size)}) · ${status.backups.length} in the folder`
            : s.folder
              ? 'No backups yet.'
              : ''}
        </span>
      </div>
      {(error ?? status.lastError) && (
        <p className="error small">Backup failed: {error ?? status.lastError}</p>
      )}
      <p className="muted small">
        To get something back: open a backup (it’s an ordinary zip), unzip it somewhere, then choose
        that folder in Settings → Library.
      </p>
    </section>
  )
}

type IpcInput = { enabled?: boolean; everyHours?: number; keep?: number }
