import { useState } from 'react'
import type { SeriesSummary, VolumeSummary, WorldSummary } from '@shared/ipc'
import { api } from '../api'
import { formatWords, seriesCover, volumeCover } from '../covers'
import { Cover, CoverDropZone } from './Cover'
import { EditableText } from './EditableText'
import { NewCard } from './NewCard'
import { useOverlays, type MenuItem } from './overlays'
import { useLibraryActions } from './useLibraryActions'

/** A series' volumes as covers, in reading order. */
export function SeriesPage(props: {
  series: SeriesSummary
  world: WorldSummary | undefined
  /** Open with the "New volume" name field ready (from the bookshelf menu). */
  startNewVolume?: boolean
  onBack: () => void
  onOpenVolume: (volumeId: string) => void
}) {
  const { series } = props
  const [renaming, setRenaming] = useState<string | null>(null)
  const { openMenu } = useOverlays()
  const actions = useLibraryActions()

  const volumeMenu = (volume: VolumeSummary): MenuItem[] => [
    { label: 'Rename', hint: 'F3', onSelect: () => setRenaming(volume.id) },
    {
      label: 'Change cover',
      onSelect: () =>
        actions.pickCover({ kind: 'volume', seriesId: series.id, volumeId: volume.id }),
    },
    {
      label: 'Delete',
      danger: true,
      onSelect: () =>
        void actions.moveToTrash(
          { kind: 'volume', seriesId: series.id, volumeId: volume.id },
          volume.name,
        ),
    },
  ]

  return (
    <main className="series-page">
      <header className="page-header">
        <button className="link" onClick={props.onBack}>
          ← Bookshelf
        </button>
        <div className="series-heading">
          <div className="series-cover-thumb" title="Series cover (used by volumes without one)">
            <CoverDropZone
              target={{ kind: 'series', seriesId: series.id }}
              hasCover={!!series.cover}
              showButtons
            >
              <Cover source={seriesCover(series)} />
            </CoverDropZone>
          </div>
          <div>
            <h1>
              <EditableText
                value={series.name}
                editing={renaming === series.id}
                onEditingChange={(on) => setRenaming(on ? series.id : null)}
                onRename={(name) => api.invoke('series:rename', { seriesId: series.id, name })}
              />
            </h1>
            <p className="muted">
              {props.world ? `World: ${props.world.name}` : 'No world linked'}
            </p>
          </div>
        </div>
      </header>

      <div className="shelf-row">
        {series.volumes.map((volume, i) => (
          <div
            key={volume.id}
            className="shelf-item"
            onContextMenu={(e) => {
              e.preventDefault()
              openMenu(e, volumeMenu(volume))
            }}
          >
            <div
              className="shelf-card"
              role="button"
              tabIndex={0}
              aria-label={`Open ${volume.name}`}
              onClick={() => props.onOpenVolume(volume.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') props.onOpenVolume(volume.id)
                if (e.key === 'F3') setRenaming(volume.id)
              }}
            >
              <CoverDropZone
                target={{ kind: 'volume', seriesId: series.id, volumeId: volume.id }}
                hasCover={!!volume.cover}
                showButtons
              >
                <Cover source={volumeCover(series, volume)} />
              </CoverDropZone>
            </div>
            <div className="shelf-caption">
              <span className="shelf-title">
                <span className="muted">{i + 1}.</span>{' '}
                <EditableText
                  value={volume.name}
                  editing={renaming === volume.id}
                  onEditingChange={(on) => setRenaming(on ? volume.id : null)}
                  onRename={(name) =>
                    api.invoke('volume:update', { seriesId: series.id, volumeId: volume.id, name })
                  }
                />
              </span>
              <span className="muted small">{formatWords(volume.wordCount)}</span>
            </div>
          </div>
        ))}
        <NewCard
          label="New volume"
          placeholder="Volume name"
          startNaming={props.startNewVolume}
          onCreate={(name) => api.invoke('volume:create', { seriesId: series.id, name })}
        />
      </div>
    </main>
  )
}
