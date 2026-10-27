import { useState } from 'react'
import type { LibrarySnapshot, SeriesSummary, WorldSummary } from '@shared/ipc'
import { api } from '../api'
import { formatVolumes, seriesStack, worldCover } from '../covers'
import { CoverDropZone } from './Cover'
import { CoverStack } from './CoverStack'
import { EditableText } from './EditableText'
import { NewCard } from './NewCard'
import { NewSeriesForm } from './NewSeriesForm'
import { useOverlays, type MenuItem } from './overlays'
import { useLibraryActions } from './useLibraryActions'

/** The home screen: every series as a cover (or a deck of covers), then the worlds. */
export function Bookshelf(props: {
  snapshot: LibrarySnapshot
  onOpenSeries: (series: SeriesSummary, options?: { newVolume?: boolean }) => void
  onOpenTrash: () => void
}) {
  const { snapshot } = props
  const [creatingSeries, setCreatingSeries] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const { openMenu } = useOverlays()
  const actions = useLibraryActions()

  const seriesMenu = (series: SeriesSummary): MenuItem[] => [
    { label: 'New volume', onSelect: () => props.onOpenSeries(series, { newVolume: true }) },
    { label: 'Rename', hint: 'F2', onSelect: () => setRenaming(series.id) },
    {
      label: 'Change cover',
      onSelect: () => actions.pickCover({ kind: 'series', seriesId: series.id }),
    },
    {
      label: 'Delete',
      danger: true,
      onSelect: () =>
        void actions.moveToTrash({ kind: 'series', seriesId: series.id }, series.name),
    },
  ]
  const worldMenu = (world: WorldSummary): MenuItem[] => [
    { label: 'Rename', hint: 'F2', onSelect: () => setRenaming(world.id) },
    {
      label: 'Change cover',
      onSelect: () => actions.pickCover({ kind: 'world', worldId: world.id }),
    },
    {
      label: 'Delete',
      danger: true,
      onSelect: () => void actions.moveToTrash({ kind: 'world', worldId: world.id }, world.name),
    },
  ]
  const menu = (items: MenuItem[]) => (e: React.MouseEvent) => {
    e.preventDefault()
    openMenu(e, items)
  }

  return (
    <main className="bookshelf">
      {snapshot.problems.length > 0 && <Problems problems={snapshot.problems} />}

      <section className="shelf">
        <h2>Series</h2>
        <div className="shelf-row">
          {snapshot.series.map((series) => (
            <div key={series.id} className="shelf-item" onContextMenu={menu(seriesMenu(series))}>
              <div
                className="shelf-card"
                role="button"
                tabIndex={0}
                aria-label={`Open ${series.name}`}
                onClick={() => props.onOpenSeries(series)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') props.onOpenSeries(series)
                  if (e.key === 'F2') setRenaming(series.id)
                }}
              >
                <CoverDropZone
                  target={{ kind: 'series', seriesId: series.id }}
                  hasCover={!!series.cover}
                >
                  <CoverStack sources={seriesStack(series)} />
                </CoverDropZone>
              </div>
              <div className="shelf-caption">
                <EditableText
                  className="shelf-title"
                  value={series.name}
                  editing={renaming === series.id}
                  onEditingChange={(on) => setRenaming(on ? series.id : null)}
                  onRename={(name) => api.invoke('series:rename', { seriesId: series.id, name })}
                />
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
            <div key={world.id} className="shelf-item" onContextMenu={menu(worldMenu(world))}>
              <div
                className="shelf-card"
                tabIndex={0}
                aria-label={world.name}
                onKeyDown={(e) => e.key === 'F2' && setRenaming(world.id)}
              >
                <CoverDropZone
                  target={{ kind: 'world', worldId: world.id }}
                  hasCover={!!world.cover}
                  showButtons
                >
                  <CoverStack sources={[worldCover(world)]} />
                </CoverDropZone>
              </div>
              <div className="shelf-caption">
                <EditableText
                  className="shelf-title"
                  value={world.name}
                  editing={renaming === world.id}
                  onEditingChange={(on) => setRenaming(on ? world.id : null)}
                  onRename={(name) => api.invoke('world:rename', { worldId: world.id, name })}
                />
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

      <footer className="shelf-footer muted small">
        <span className="library-path" title={snapshot.root}>
          Library: {snapshot.root}
        </span>
        <button className="link small" onClick={props.onOpenTrash}>
          Trash
        </button>
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
