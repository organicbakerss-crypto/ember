import { useCallback, useEffect, useState } from 'react'
import type { LibrarySnapshot } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'
import { Bookshelf } from './Bookshelf'
import { useCommands } from './commands'
import { SeriesPage } from './SeriesPage'
import { TrashPage } from './TrashPage'
import { WritingView } from './WritingView'

type Route =
  | { view: 'shelf' }
  | { view: 'trash' }
  | { view: 'series'; seriesId: string; newVolume?: boolean }
  | { view: 'volume'; seriesId: string; volumeId: string }

/** Navigation between the bookshelf, a series page, the writing view and the trash. */
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
    if ((change.kind === 'chapter' || change.kind === 'trash') && writing) return
    refresh()
  })

  useCommands(
    'library',
    snapshot
      ? [
          { id: 'shelf', title: 'Go to bookshelf', run: () => setRoute({ view: 'shelf' }) },
          { id: 'trash', title: 'Open trash', run: () => setRoute({ view: 'trash' }) },
          ...snapshot.series.flatMap((s) => [
            {
              id: `series:${s.id}`,
              group: 'Open series',
              title: s.name,
              run: () => setRoute({ view: 'series', seriesId: s.id }),
            },
            ...s.volumes.map((v) => ({
              id: `volume:${v.id}`,
              group: 'Open volume',
              title: `${s.name} › ${v.name}`,
              run: () => setRoute({ view: 'volume', seriesId: s.id, volumeId: v.id }),
            })),
          ]),
        ]
      : [],
  )

  if (error) return <p className="error page-message">{error}</p>
  if (!snapshot) return null

  const toShelf = () => setRoute({ view: 'shelf' })
  const shelf = (
    <Bookshelf
      snapshot={snapshot}
      onOpenSeries={(series, options) =>
        setRoute({ view: 'series', seriesId: series.id, newVolume: options?.newVolume })
      }
      onOpenTrash={() => setRoute({ view: 'trash' })}
    />
  )

  if (route.view === 'trash') return <TrashPage onBack={toShelf} />
  const series =
    'seriesId' in route ? snapshot.series.find((s) => s.id === route.seriesId) : undefined
  if (route.view === 'shelf' || !series) return shelf

  const toSeries = () => setRoute({ view: 'series', seriesId: series.id })

  if (route.view === 'series') {
    return (
      <SeriesPage
        key={series.id}
        series={series}
        world={snapshot.worlds.find((w) => w.id === series.worldId)}
        startNewVolume={route.newVolume}
        onBack={toShelf}
        onOpenVolume={(volumeId) => setRoute({ view: 'volume', seriesId: series.id, volumeId })}
      />
    )
  }

  const volume = series.volumes.find((v) => v.id === route.volumeId)
  if (!volume) return shelf
  return <WritingView series={series} volume={volume} onBack={toShelf} onOpenSeries={toSeries} />
}
