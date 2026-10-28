import { useCallback, useEffect, useState } from 'react'
import type { LibrarySnapshot } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'
import { Bookshelf } from './Bookshelf'
import { useCommands } from './commands'
import { SeriesPage } from './SeriesPage'
import { SettingsWindow } from './SettingsWindow'
import { TrashPage } from './TrashPage'
import { WorldView } from '../world/WorldView'
import { WritingView, type ChapterTarget } from './WritingView'

type Route =
  | { view: 'shelf' }
  | { view: 'trash' }
  | { view: 'settings' }
  | { view: 'series'; seriesId: string; newVolume?: boolean }
  | {
      view: 'volume'
      seriesId: string
      volumeId: string
      /** Open this chapter (and show the first use of `find`), e.g. from an entry's appearances. */
      open?: ChapterTarget
    }
  | {
      view: 'world'
      worldId: string
      entryId?: string
      /** The volume it was opened from, for the Write/World switch. */
      from?: { seriesId: string; volumeId: string }
    }

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
          { id: 'app-settings', title: 'Open settings', run: () => setRoute({ view: 'settings' }) },
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
          ...snapshot.worlds.map((w) => ({
            id: `world:${w.id}`,
            group: 'Open world',
            title: w.name,
            run: () => setRoute({ view: 'world', worldId: w.id }),
          })),
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
      onOpenWorld={(worldId) => setRoute({ view: 'world', worldId })}
      onOpenSettings={() => setRoute({ view: 'settings' })}
    />
  )

  if (route.view === 'trash') return <TrashPage onBack={toShelf} />
  if (route.view === 'world') {
    if (!snapshot.worlds.some((w) => w.id === route.worldId)) return shelf
    const from = route.from
    const fromSeries = from && snapshot.series.find((s) => s.id === from.seriesId)
    const fromVolume = fromSeries?.volumes.find((v) => v.id === from?.volumeId)
    return (
      <WorldView
        key={route.worldId}
        worldId={route.worldId}
        entryId={route.entryId}
        series={snapshot.series}
        writeLabel={fromVolume?.name}
        onWrite={
          from && fromVolume
            ? () => setRoute({ view: 'volume', seriesId: from.seriesId, volumeId: from.volumeId })
            : undefined
        }
        onBack={toShelf}
        onOpenAppearance={(a, name) =>
          setRoute({
            view: 'volume',
            seriesId: a.seriesId,
            volumeId: a.volumeId,
            open: { chapterId: a.chapterId, find: name, token: Date.now() },
          })
        }
      />
    )
  }
  if (route.view === 'settings') {
    return (
      <main className="settings-page">
        <SettingsWindow onClose={toShelf} />
      </main>
    )
  }
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
  return (
    <WritingView
      series={series}
      volume={volume}
      open={route.open}
      onBack={toShelf}
      onOpenSeries={toSeries}
      onOpenWorld={
        series.worldId
          ? (entryId) =>
              setRoute({
                view: 'world',
                worldId: series.worldId!,
                entryId,
                from: { seriesId: series.id, volumeId: volume.id },
              })
          : undefined
      }
    />
  )
}
