import type { SeriesSummary, WorldSummary } from '@shared/ipc'
import { api } from '../api'
import { formatWords, seriesCover, volumeCover } from '../covers'
import { Cover, CoverDropZone } from './Cover'
import { NewCard } from './NewCard'

/** A series' volumes as covers, in reading order. */
export function SeriesPage(props: {
  series: SeriesSummary
  world: WorldSummary | undefined
  onBack: () => void
  onOpenVolume: (volumeId: string) => void
}) {
  const { series } = props
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
            <h1>{series.name}</h1>
            <p className="muted">
              {props.world ? `World: ${props.world.name}` : 'No world linked'}
            </p>
          </div>
        </div>
      </header>

      <div className="shelf-row">
        {series.volumes.map((volume, i) => (
          <div key={volume.id} className="shelf-item">
            <div
              className="shelf-card"
              role="button"
              tabIndex={0}
              aria-label={`Open ${volume.name}`}
              onClick={() => props.onOpenVolume(volume.id)}
              onKeyDown={(e) => e.key === 'Enter' && props.onOpenVolume(volume.id)}
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
                <span className="muted">{i + 1}.</span> {volume.name}
              </span>
              <span className="muted small">{formatWords(volume.wordCount)}</span>
            </div>
          </div>
        ))}
        <NewCard
          label="New volume"
          placeholder="Volume name"
          onCreate={(name) => api.invoke('volume:create', { seriesId: series.id, name })}
        />
      </div>
    </main>
  )
}
