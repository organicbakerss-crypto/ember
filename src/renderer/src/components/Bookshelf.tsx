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
  onOpenSettings: () => void
  onOpenWorld: (worldId: string) => void
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
      <header className="bookshelf-header">
        <button className="shelf-button" onClick={props.onOpenSettings}>
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
          </svg>
          Settings
        </button>
        <button
          className="shelf-button trash-button"
          onClick={props.onOpenTrash}
          title="Deleted items, until you empty the trash"
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />
          </svg>
          Trash{snapshot.trashCount > 0 && ` (${snapshot.trashCount})`}
        </button>
      </header>
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
                role="button"
                tabIndex={0}
                aria-label={`Open ${world.name}`}
                onClick={() => props.onOpenWorld(world.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') props.onOpenWorld(world.id)
                  if (e.key === 'F2') setRenaming(world.id)
                }}
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
