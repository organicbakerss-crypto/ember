import { useCallback, useEffect, useState } from 'react'
import type { LibrarySnapshot, SeriesSummary } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'
import { Bookshelf } from './Bookshelf'
import { SeriesPage } from './SeriesPage'
import { WritingView } from './WritingView'

type Route =
  | { view: 'shelf' }
  | { view: 'series'; seriesId: string }
  | { view: 'volume'; seriesId: string; volumeId: string; from: 'shelf' | 'series' }

/** Navigation between the bookshelf, a series page and the writing view. */
export function Home() {
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [route, setRoute] = useState<Route>({ view: 'shelf' })

  const refresh = useCallback(() => {
    api.invoke('library:snapshot').then(setSnapshot, (err) => setError(describeError(err).message))
  }, [])
  // Also refreshes on leaving the writing view, to pick up word counts skipped below.
  const writing = route.view === 'volume'
  useEffect(() => {
    if (!writing) refresh()
  }, [refresh, writing])
  useIpcEvent('library:changed', (change) => {
    // Autosaves only change word counts, which aren't shown while writing.
    if (change.kind === 'chapter' && writing) return
    refresh()
  })

  if (error) return <p className="error page-message">{error}</p>
  if (!snapshot) return null

  const openSeries = (series: SeriesSummary) => {
    const [only] = series.volumes
    if (series.volumes.length === 1 && only) {
      setRoute({ view: 'volume', seriesId: series.id, volumeId: only.id, from: 'shelf' })
    } else setRoute({ view: 'series', seriesId: series.id })
  }

  const series = 'seriesId' in route && snapshot.series.find((s) => s.id === route.seriesId)
  if (route.view === 'shelf' || !series) {
    return <Bookshelf snapshot={snapshot} onOpenSeries={openSeries} />
  }

  const toSeries = () => setRoute({ view: 'series', seriesId: series.id })
  const toShelf = () => setRoute({ view: 'shelf' })

  if (route.view === 'series') {
    return (
      <SeriesPage
        series={series}
        world={snapshot.worlds.find((w) => w.id === series.worldId)}
        onBack={toShelf}
        onOpenVolume={(volumeId) =>
          setRoute({ view: 'volume', seriesId: series.id, volumeId, from: 'series' })
        }
      />
    )
  }

  const volume = series.volumes.find((v) => v.id === route.volumeId)
  if (!volume) return <Bookshelf snapshot={snapshot} onOpenSeries={openSeries} />
  return (
    <WritingView
      series={series}
      volume={volume}
      backLabel={route.from === 'shelf' ? 'Bookshelf' : series.name}
      onBack={route.from === 'shelf' ? toShelf : toSeries}
      onOpenSeries={toSeries}
    />
  )
}
