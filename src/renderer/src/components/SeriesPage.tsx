import { useState } from 'react'
import { ShelfHero } from './ShelfHero'
import type { SeriesSummary, VolumeSummary, WorldSummary } from '@shared/ipc'
import { api, describeError } from '../api'
import { formatWords, seriesCover, volumeCover } from '../covers'
import { Cover, CoverDropZone } from './Cover'
import { EditableText } from './EditableText'
import { NewCard } from './NewCard'
import { useOverlays, type MenuItem } from './overlays'
import { useLibraryActions } from './useLibraryActions'
import { ExportDialog } from '../io/ExportDialog'
import { ImportDialog } from '../io/ImportDialog'
import { worldLinkMenu } from './worldLink'
import { SettingsWindow } from './SettingsWindow'

/** A series' volumes as covers, in reading order. */
export function SeriesPage(props: {
  series: SeriesSummary
  world: WorldSummary | undefined
  worlds: WorldSummary[]
  /** Open with the "New volume" name field ready (from the bookshelf menu). */
  startNewVolume?: boolean
  onBack: () => void
  onOpenVolume: (volumeId: string) => void
}) {
  const { series } = props
  const [renaming, setRenaming] = useState<string | null>(null)
  const { openMenu, toast } = useOverlays()
  const actions = useLibraryActions()

  const [exporting, setExporting] = useState<VolumeSummary | null>(null)
  const [importing, setImporting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const volumeMenu = (volume: VolumeSummary): MenuItem[] => [
    { label: 'Rename', hint: 'F2', onSelect: () => setRenaming(volume.id) },
    { label: 'Export… (Word, PDF, EPUB, Markdown)', onSelect: () => setExporting(volume) },
    {
      label: 'Finished (keep less history)',
      checked: volume.settings['finished'] === true,
      onSelect: () =>
        void api
          .invoke('volume:update', {
            seriesId: series.id,
            volumeId: volume.id,
            finished: volume.settings['finished'] !== true,
          })
          .catch((err: unknown) => toast(describeError(err).message)),
    },
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
            <button
              className="link muted world-link"
              title="Choose the world this series uses"
              onClick={(e) => openMenu(e, worldLinkMenu(series, props.worlds, toast).submenu!)}
            >
              {props.world ? `World: ${props.world.name}` : 'No world'} ▾
            </button>
            <p className="muted small">
              {series.volumes.length} {series.volumes.length === 1 ? 'volume' : 'volumes'} ·{' '}
              {formatWords(series.volumes.reduce((n, v) => n + v.wordCount, 0))} in all
            </p>
          </div>
          <span className="status-spacer" />
          <button onClick={() => setImporting(true)} title="Bring chapters in from a .docx file">
            Import from Word…
          </button>
          <button aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>
            ⚙ Settings
          </button>
        </div>
        <textarea
          className="series-description"
          aria-label="Description"
          placeholder="What this story is about, in a few lines (for you; the AI’s blurb can go here)"
          defaultValue={series.description ?? ''}
          rows={3}
          onBlur={(e) => {
            if (e.target.value.trim() !== (series.description ?? '')) {
              void api
                .invoke('series:describe', { seriesId: series.id, description: e.target.value })
                .catch((err: unknown) => toast(describeError(err).message))
            }
          }}
        />
      </header>
      {series.volumes.some((v) => v.wordCount > 0) && (
        <ShelfHero
          series={series}
          compact
          onOpenVolume={(_, volumeId) => props.onOpenVolume(volumeId)}
        />
      )}
      {settingsOpen && (
        <div className="series-settings">
          <SettingsWindow onClose={() => setSettingsOpen(false)} />
        </div>
      )}
      {exporting && (
        <ExportDialog series={series} volume={exporting} onClose={() => setExporting(null)} />
      )}
      {importing && (
        <ImportDialog
          series={series}
          onClose={() => setImporting(false)}
          onImported={(volumeId) => props.onOpenVolume(volumeId)}
        />
      )}

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
                if (e.key === 'F2' || e.key === 'F3') setRenaming(volume.id)
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
