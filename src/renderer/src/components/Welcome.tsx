import { useState } from 'react'
import type { LibraryStatus } from '@shared/ipc'
import { appConfig } from '../../../../app.config'
import { api, describeError } from '../api'

export function Welcome(props: { defaultPath: string; onOpen: (status: LibraryStatus) => void }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (channel: 'library:openDefault' | 'library:choose') => {
    setBusy(true)
    setError(null)
    try {
      props.onOpen(await api.invoke(channel))
    } catch (err) {
      const { code, message } = describeError(err)
      if (code !== 'cancelled') setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="welcome">
      <h1>{appConfig.name}</h1>
      <p className="muted">
        Your series, volumes and worlds live in a library folder of ordinary files.
      </p>
      <div className="welcome-actions">
        <button className="primary" disabled={busy} onClick={() => void run('library:openDefault')}>
          Use the default folder
        </button>
        <code className="path">{props.defaultPath}</code>
        <button disabled={busy} onClick={() => void run('library:choose')}>
          Choose a folder…
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </main>
  )
}
