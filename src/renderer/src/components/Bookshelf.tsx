import { useState } from 'react'
import type { LibrarySnapshot, SeriesSummary } from '@shared/ipc'
import { api } from '../api'
import { formatVolumes, seriesStack, worldCover } from '../covers'
import { CoverDropZone } from './Cover'
import { CoverStack } from './CoverStack'
import { NewCard } from './NewCard'
import { NewSeriesForm } from './NewSeriesForm'

/** The home screen: every series as a cover (or a deck of covers), then the worlds. */
export function Bookshelf(props: {
  snapshot: LibrarySnapshot
  onOpenSeries: (series: SeriesSummary) => void
}) {
  const { snapshot } = props
  const [creatingSeries, setCreatingSeries] = useState(false)

  return (
    <main className="bookshelf">
      {snapshot.problems.length > 0 && <Problems problems={snapshot.problems} />}

      <section className="shelf">
        <h2>Series</h2>
        <div className="shelf-row">
          {snapshot.series.map((series) => (
            <div key={series.id} className="shelf-item">
              <div
                className="shelf-card"
                role="button"
                tabIndex={0}
                aria-label={`Open ${series.name}`}
                onClick={() => props.onOpenSeries(series)}
                onKeyDown={(e) => e.key === 'Enter' && props.onOpenSeries(series)}
              >
                <CoverDropZone
                  target={{ kind: 'series', seriesId: series.id }}
                  hasCover={!!series.cover}
                >
                  <CoverStack sources={seriesStack(series)} />
                </CoverDropZone>
              </div>
              <div className="shelf-caption">
                <span className="shelf-title">{series.name}</span>
                <span className="muted small">{formatVolumes(series.volumes.length)}</span>
              </div>
            </div>
          ))}
          <NewCard label="New series" onClick={() => setCreatingSeries(true)} />
        </div>
      </section>

      <section className="shelf">
        <h2>Worlds</h2>
        <div className="shelf-row">
          {snapshot.worlds.map((world) => (
            <div key={world.id} className="shelf-item">
              <div className="shelf-card">
                <CoverDropZone
                  target={{ kind: 'world', worldId: world.id }}
                  hasCover={!!world.cover}
                  showButtons
                >
                  <CoverStack sources={[worldCover(world)]} />
                </CoverDropZone>
              </div>
              <div className="shelf-caption">
                <span className="shelf-title">{world.name}</span>
              </div>
            </div>
          ))}
          <NewCard
            label="New world"
            placeholder="World name"
            onCreate={(name) => api.invoke('world:create', { name })}
          />
        </div>
      </section>

      <footer className="muted small library-path" title={snapshot.root}>
        Library: {snapshot.root}
      </footer>

      {creatingSeries && (
        <div className="modal-backdrop" onClick={() => setCreatingSeries(false)}>
          <div onClick={(e) => e.stopPropagation()}>
            <NewSeriesForm worlds={snapshot.worlds} onDone={() => setCreatingSeries(false)} />
          </div>
        </div>
      )}
    </main>
  )
}

function Problems(props: { problems: LibrarySnapshot['problems'] }) {
  return (
    <div className="card warning">
      <strong>Some files could not be read.</strong> They have not been changed.
      <ul>
        {props.problems.map((p) => (
          <li key={p.path}>
            <code>{p.path}</code>: {p.message}
          </li>
        ))}
      </ul>
    </div>
  )
}
