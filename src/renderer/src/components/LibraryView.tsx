import { useCallback, useEffect, useState } from 'react'
import type { LibrarySnapshot } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'
import { InlineCreate } from './InlineCreate'
import { NewSeriesForm } from './NewSeriesForm'
import { VolumeView } from './VolumeView'

interface Selection {
  seriesId: string
  volumeId: string
}

export function LibraryView() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [creatingSeries, setCreatingSeries] = useState(false)

  const refresh = useCallback(() => {
    api.invoke('library:snapshot').then(setSnapshot, (err) => setError(describeError(err).message))
  }, [])
  useEffect(refresh, [refresh])
  useIpcEvent('library:changed', (change) => {
    if (change.kind !== 'chapter' && change.kind !== 'outline') refresh()
  })

  if (error) return <p className="error page-message">{error}</p>
  if (!snapshot) return null

  const worldName = (id: string | null) => snapshot.worlds.find((w) => w.id === id)?.name
  const selectedSeries = snapshot.series.find((s) => s.id === selection?.seriesId)
  const selectedVolume = selectedSeries?.volumes.find((v) => v.id === selection?.volumeId)

  return (
    <div className="layout">
      <aside className="sidebar">
        <section>
          <header className="section-header">
            <h2>Series</h2>
            <button className="link" onClick={() => setCreatingSeries(true)}>
              + New
            </button>
          </header>
          {snapshot.series.length === 0 && <p className="muted small">No series yet.</p>}
          <ul className="tree">
            {snapshot.series.map((series) => (
              <li key={series.id}>
                <div className="tree-label">
                  <strong>{series.name}</strong>
                  <span className="muted small">{worldName(series.worldId) ?? 'No world'}</span>
                </div>
                <ul>
                  {series.volumes.map((volume) => (
                    <li key={volume.id}>
                      <button
                        className={`tree-item ${volume.id === selection?.volumeId ? 'selected' : ''}`}
                        onClick={() => setSelection({ seriesId: series.id, volumeId: volume.id })}
                      >
                        {volume.name}
                      </button>
                    </li>
                  ))}
                  <li>
                    <InlineCreate
                      label="Volume"
                      placeholder="Volume name"
                      onCreate={async (name) => {
                        const volume = await api.invoke('volume:create', {
                          seriesId: series.id,
                          name,
                        })
                        setSelection({ seriesId: series.id, volumeId: volume.id })
                      }}
                    />
                  </li>
                </ul>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <header className="section-header">
            <h2>Worlds</h2>
          </header>
          <ul className="tree">
            {snapshot.worlds.map((world) => (
              <li key={world.id} className="tree-label">
                {world.name}
              </li>
            ))}
            <li>
              <InlineCreate
                label="World"
                placeholder="World name"
                onCreate={(name) => api.invoke('world:create', { name })}
              />
            </li>
          </ul>
        </section>

        <footer className="muted small library-path" title={snapshot.root}>
          {snapshot.root}
        </footer>
      </aside>

      <main className="content">
        {snapshot.problems.length > 0 && (
          <div className="card warning">
            <strong>Some files could not be read.</strong> They have not been changed.
            <ul>
              {snapshot.problems.map((p) => (
                <li key={p.path}>
                  <code>{p.path}</code>: {p.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {creatingSeries ? (
          <NewSeriesForm worlds={snapshot.worlds} onDone={() => setCreatingSeries(false)} />
        ) : selectedVolume && selection ? (
          <VolumeView
            key={selectedVolume.id}
            seriesId={selection.seriesId}
            volume={selectedVolume}
          />
        ) : (
          <p className="muted page-message">
            {snapshot.series.length ? 'Pick a volume, or add one.' : 'Start by creating a series.'}
          </p>
        )}
      </main>
    </div>
  )
}
