import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LibrarySnapshot, SeriesSummary } from '@shared/ipc'
import type { PaneRoute } from '@shared/panes'
import { api, describeError, useIpcEvent } from '../api'
import { PaneContext } from '../panes/PaneContext'
import { PaneFrame, PANE_DRAG } from '../panes/PaneFrame'
import { SplitView } from '../panes/SplitView'
import { useWords } from '../skins/useWords'
import { Bookshelf } from './Bookshelf'
import { MOD, modKey, useCommands } from './commands'
import { SeriesPage } from './SeriesPage'
import { SettingsWindow } from './SettingsWindow'
import { TrashPage } from './TrashPage'
import { WorldView } from '../world/WorldView'
import { WritingView, type ChapterTarget } from './WritingView'

interface WriteSide {
  seriesId: string
  volumeId: string
  /** Open this chapter (and show the first use of `find`), e.g. from an entry's appearances. */
  open?: ChapterTarget
}

interface WorldSide {
  worldId: string
  entryId?: string
  /** Changes on each request to show `entryId`. */
  token?: number
}

type Route =
  | { view: 'shelf' }
  | { view: 'trash' }
  | { view: 'settings' }
  | { view: 'series'; seriesId: string; newVolume?: boolean }
  | ({ view: 'volume' } & WriteSide)
  | ({
      view: 'world'
      /** The volume it was opened from, for the Write/World switch. */
      from?: { seriesId: string; volumeId: string }
    } & WorldSide)
  /** Split screen: writing on the left, the world beside it. */
  | { view: 'split'; write: WriteSide; world: WorldSide }

const writeSide = (r: Extract<PaneRoute, { kind: 'write' }>): WriteSide => ({
  seriesId: r.seriesId,
  volumeId: r.volumeId,
  open: r.chapterId ? { chapterId: r.chapterId, token: Date.now() } : undefined,
})

/** A torn-off window starts at its pane's route. */
function startRoute(detached: PaneRoute | null): Route {
  if (!detached) return { view: 'shelf' }
  if (detached.kind === 'write') return { view: 'volume', ...writeSide(detached) }
  return { view: 'world', worldId: detached.worldId, entryId: detached.entryId, token: 1 }
}

/** A pane docked back (or sent here) from a torn-off window: beside the current view, or instead. */
function withDocked(current: Route, route: PaneRoute): Route {
  if (route.kind === 'world') {
    const world = { worldId: route.worldId, entryId: route.entryId, token: Date.now() }
    if (current.view === 'volume') return { view: 'split', write: current, world }
    if (current.view === 'split') return { ...current, world }
    return { view: 'world', ...world }
  }
  const write = writeSide(route)
  if (current.view === 'world') {
    return {
      view: 'split',
      write,
      world: { worldId: current.worldId, entryId: current.entryId, token: current.token },
    }
  }
  if (current.view === 'split') return { ...current, write }
  return { view: 'volume', ...write }
}

/**
 * Navigation between the bookshelf, a series page, the writing view, the
 * world and the trash; the writing view and the world can sit side by side
 * (split screen), and either can be torn off into a window of its own. In a
 * torn-off window (`detached`), this shows just that pane.
 */
export function Home(props: { detached?: PaneRoute | null }) {
  const detached = props.detached ?? null
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [route, setRoute] = useState<Route>(() => startRoute(detached))
  // Which side of the split is being worked in (it answers keyboard shortcuts).
  const [activeSide, setActiveSide] = useState<'write' | 'world'>('write')
  // Where each pane is now, as it reports it (for popping out, and for a torn-off window).
  const at = useRef<{ write?: PaneRoute; world?: PaneRoute }>({})
  const word = useWords()

  const refresh = useCallback(() => {
    api.invoke('library:snapshot').then(setSnapshot, (err) => setError(describeError(err).message))
  }, [])
  // Loads at once (a torn-off window can start in the writing view), and again on leaving
  // the writing view, to pick up word counts skipped below.
  const writing = route.view === 'volume' || route.view === 'split'
  const loaded = useRef(false)
  useEffect(() => {
    if (writing && loaded.current) return
    loaded.current = true
    refresh()
  }, [refresh, writing])
  useIpcEvent('library:changed', (change) => {
    // Autosaves only change word counts, which aren't shown while writing.
    if ((change.kind === 'chapter' || change.kind === 'trash') && writing) return
    refresh()
  })

  // A torn-off pane docked back here (or a torn-off window asked to show something here).
  useIpcEvent('pane:dock', (pane) => {
    if (!detached) setRoute((current) => withDocked(current, pane))
  })
  // This torn-off world window was asked to show an entry.
  useIpcEvent('pane:showEntry', ({ worldId, entryId }) => {
    setRoute((current) =>
      current.view === 'world' && current.worldId === worldId
        ? { ...current, entryId, token: Date.now() }
        : current,
    )
  })
  // A torn-off pane dragged over this window can be dropped here to dock.
  useEffect(() => {
    if (detached) return
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(PANE_DRAG)) e.preventDefault()
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', over)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', over)
    }
  }, [detached])

  const reportWrite = useCallback(
    (r: PaneRoute) => {
      at.current.write = r
      if (detached) void api.invoke('window:route', { route: r })
    },
    [detached],
  )
  const reportWorld = useCallback(
    (r: PaneRoute) => {
      at.current.world = r
      if (detached) void api.invoke('window:route', { route: r })
    },
    [detached],
  )

  const seriesOf = (seriesId: string) => snapshot?.series.find((s) => s.id === seriesId)

  /** Splits the current view: writing beside the world, or the world beside writing. */
  const splitCurrent = useCallback(() => {
    setRoute((current) => {
      if (current.view === 'volume') {
        const worldId = snapshot?.series.find((s) => s.id === current.seriesId)?.worldId
        return worldId ? { view: 'split', write: current, world: { worldId } } : current
      }
      if (current.view === 'world' && current.from) {
        return {
          view: 'split',
          write: current.from,
          world: { worldId: current.worldId, entryId: current.entryId, token: current.token },
        }
      }
      if (current.view === 'split') return { view: 'volume', ...current.write }
      return current
    })
  }, [snapshot])

  // Ctrl/Cmd+\ opens (or closes) the other mode beside this one.
  useEffect(() => {
    if (detached) return
    const onKey = (e: KeyboardEvent) => {
      if (modKey(e) && e.key === '\\') {
        e.preventDefault()
        splitCurrent()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detached, splitCurrent])

  useCommands(
    'library',
    snapshot
      ? [
          ...(detached
            ? []
            : [
                { id: 'shelf', title: 'Go to bookshelf', run: () => setRoute({ view: 'shelf' }) },
                { id: 'trash', title: 'Open trash', run: () => setRoute({ view: 'trash' }) },
                {
                  id: 'app-settings',
                  title: 'Open settings',
                  run: () => setRoute({ view: 'settings' }),
                },
              ]),
          ...(!detached && (route.view === 'volume' || route.view === 'world' || writing)
            ? [
                {
                  id: 'split',
                  title: route.view === 'split' ? 'Close the side-by-side view' : 'Side by side',
                  shortcut: `${MOD}\\`,
                  run: splitCurrent,
                },
              ]
            : []),
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

  // A torn-off window is titled after its pane.
  const detachedTitle = (() => {
    if (!detached || !snapshot) return null
    if (route.view === 'volume') {
      const series = snapshot.series.find((x) => x.id === route.seriesId)
      const volume = series?.volumes.find((v) => v.id === route.volumeId)
      return series && volume ? `${series.name} › ${volume.name}` : null
    }
    if (route.view === 'world')
      return snapshot.worlds.find((w) => w.id === route.worldId)?.name ?? null
    return null
  })()
  useEffect(() => {
    if (detachedTitle) document.title = detachedTitle
  }, [detachedTitle])

  if (error) return <p className="error page-message">{error}</p>
  if (!snapshot) return null

  const toShelf = () => setRoute({ view: 'shelf' })
  /** In a torn-off window: put this pane back in the main window. */
  const dock = (side: 'write' | 'world') => {
    const r = at.current[side]
    if (r) void api.invoke('window:dock', { route: r })
  }
  /** Pops a split pane out into its own window, leaving the other one here. */
  const popOut = (side: 'write' | 'world') => {
    if (route.view !== 'split') return
    const r =
      at.current[side] ??
      (side === 'write'
        ? { kind: 'write' as const, seriesId: route.write.seriesId, volumeId: route.write.volumeId }
        : { kind: 'world' as const, worldId: route.world.worldId })
    void api.invoke('window:open', { route: r })
    if (side === 'world') setRoute({ view: 'volume', ...route.write })
    else setRoute({ view: 'world', ...route.world, from: route.write })
  }

  /**
   * Opens an entry from the writing view: in a window of its own (middle-click),
   * in a torn-off window of its world if there is one, else beside the page.
   * Without an entry, switches to World mode.
   */
  const openWorldFrom =
    (series: SeriesSummary, write: WriteSide) => (entryId?: string, how?: 'window') => {
      const worldId = series.worldId
      if (!worldId) return
      if (how === 'window') {
        void api.invoke('window:open', { route: { kind: 'world', worldId, entryId } })
        return
      }
      if (!entryId) {
        if (detached) {
          void api.invoke('window:dock', { route: { kind: 'world', worldId }, keep: true })
          return
        }
        setRoute({ view: 'world', worldId, from: write })
        return
      }
      void api.invoke('window:showEntry', { worldId, entryId }).then((shown) => {
        if (shown) return
        if (detached) {
          void api.invoke('window:dock', {
            route: { kind: 'world', worldId, entryId },
            keep: true,
          })
          return
        }
        setRoute((current) =>
          current.view === 'split'
            ? { ...current, world: { worldId, entryId, token: Date.now() } }
            : { view: 'split', write, world: { worldId, entryId, token: Date.now() } },
        )
        setActiveSide('world')
      })
    }

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

  /** The writing view for one side (alone, split, or torn off). */
  const writingPane = (write: WriteSide, place: 'alone' | 'split' | 'detached') => {
    const series = seriesOf(write.seriesId)
    const volume = series?.volumes.find((v) => v.id === write.volumeId)
    if (!series || !volume) return null
    const view = (
      <WritingView
        key={volume.id}
        series={series}
        volume={volume}
        open={write.open}
        onBack={place === 'detached' ? () => dock('write') : toShelf}
        onOpenSeries={() => setRoute({ view: 'series', seriesId: series.id })}
        onOpenWorld={series.worldId ? openWorldFrom(series, write) : undefined}
        onOpenWorldBeside={place === 'alone' && series.worldId ? splitCurrent : undefined}
        hideModeSwitch={place !== 'alone'}
      />
    )
    if (place === 'alone') {
      return (
        <AlonePane id="write" onRoute={reportWrite}>
          {view}
        </AlonePane>
      )
    }
    return (
      <PaneFrame
        id="write"
        title={`Write · ${series.name} › ${volume.name}`}
        active={place === 'detached' || activeSide === 'write'}
        split={place === 'split'}
        detached={place === 'detached'}
        onActivate={() => setActiveSide('write')}
        onRoute={reportWrite}
        onPopOut={place === 'split' ? () => popOut('write') : undefined}
        onClose={
          place === 'split' && route.view === 'split'
            ? () => setRoute({ view: 'world', ...route.world, from: route.write })
            : undefined
        }
        onDock={place === 'detached' ? () => dock('write') : undefined}
      >
        {view}
      </PaneFrame>
    )
  }

  /** The world for one side (alone, split, or torn off). */
  const worldPane = (
    world: WorldSide & { from?: { seriesId: string; volumeId: string } },
    place: 'alone' | 'split' | 'detached',
  ) => {
    const info = snapshot.worlds.find((w) => w.id === world.worldId)
    if (!info) return null
    const from = world.from
    const fromVolume = from && seriesOf(from.seriesId)?.volumes.find((v) => v.id === from.volumeId)
    const view = (
      <WorldView
        key={world.worldId}
        worldId={world.worldId}
        entryId={world.entryId}
        entryToken={world.token}
        series={snapshot.series}
        writeLabel={fromVolume?.name}
        onWrite={
          place === 'alone' && from && fromVolume
            ? () => setRoute({ view: 'volume', seriesId: from.seriesId, volumeId: from.volumeId })
            : undefined
        }
        onWriteBeside={place === 'alone' && from && fromVolume ? splitCurrent : undefined}
        onBack={place === 'detached' ? () => dock('world') : toShelf}
        onOpenAppearance={(a, name) => {
          const target: WriteSide = {
            seriesId: a.chapter.seriesId,
            volumeId: a.chapter.volumeId,
            open: { chapterId: a.chapter.id, find: name, token: Date.now() },
          }
          if (place === 'detached') {
            void api.invoke('window:dock', {
              route: {
                kind: 'write',
                seriesId: target.seriesId,
                volumeId: target.volumeId,
                chapterId: a.chapter.id,
              },
              keep: true,
            })
          } else if (place === 'split' && route.view === 'split') {
            setRoute({ ...route, write: target })
            setActiveSide('write')
          } else setRoute({ view: 'volume', ...target })
        }}
      />
    )
    if (place === 'alone') {
      return (
        <AlonePane id="world" onRoute={reportWorld}>
          {view}
        </AlonePane>
      )
    }
    return (
      <PaneFrame
        id="world"
        title={`${word('world', 'World')} · ${info.name}`}
        active={place === 'detached' || activeSide === 'world'}
        split={place === 'split'}
        detached={place === 'detached'}
        onActivate={() => setActiveSide('world')}
        onRoute={reportWorld}
        onPopOut={place === 'split' ? () => popOut('world') : undefined}
        onClose={
          place === 'split' && route.view === 'split'
            ? () => setRoute({ view: 'volume', ...route.write })
            : undefined
        }
        onDock={place === 'detached' ? () => dock('world') : undefined}
      >
        {view}
      </PaneFrame>
    )
  }

  if (detached) {
    const pane =
      route.view === 'volume'
        ? writingPane(route, 'detached')
        : route.view === 'world'
          ? worldPane(route, 'detached')
          : null
    return (
      pane ?? (
        <p className="muted page-message">
          This is no longer in the library (it may be in the trash). Close this window.
        </p>
      )
    )
  }

  if (route.view === 'trash') return <TrashPage onBack={toShelf} />
  if (route.view === 'split') {
    const left = writingPane(route.write, 'split')
    const right = worldPane(route.world, 'split')
    if (!left || !right) return left ?? right ?? shelf
    return <SplitView left={left} right={right} />
  }
  if (route.view === 'world') return worldPane(route, 'alone') ?? shelf
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
  return writingPane(route, 'alone') ?? shelf
}

/** A view shown alone: still a pane (it reports where it is), with no tab. */
function AlonePane(props: {
  id: string
  onRoute: (route: PaneRoute) => void
  children: ReactNode
}) {
  const { id, onRoute } = props
  const pane = useMemo(
    () => ({ id, active: true, split: false, detached: false, onRoute }),
    [id, onRoute],
  )
  return <PaneContext.Provider value={pane}>{props.children}</PaneContext.Provider>
}
