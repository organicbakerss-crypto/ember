import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LibrarySnapshot, SeriesSummary } from '@shared/ipc'
import type { PaneRoute } from '@shared/panes'
import { api, describeError, useIpcEvent } from '../api'
import { PaneContext } from '../panes/PaneContext'
import { PaneFrame } from '../panes/PaneFrame'
import { SplitView } from '../panes/SplitView'
import { useWords } from '../skins/useWords'
import { Bookshelf } from './Bookshelf'
import { MOD, modKey, useCommands } from './commands'
import { SeriesPage } from './SeriesPage'
import { SettingsWindow } from './SettingsWindow'
import { TrashPage } from './TrashPage'
import { WorldView } from '../world/WorldView'
import { WritingView, type ChapterTarget } from './WritingView'
import { isBook } from './worldLink'
import { AiView } from '../ai/AiView'
import { sortNamesNote, worldUpdateNote } from '../ai/worldUpdate'
import { useOverlays } from './overlays'

interface WriteSide {
  seriesId: string
  volumeId: string
  /** Open this chapter (and show the first use of `find`), e.g. from an entry's appearances. */
  open?: ChapterTarget
}

interface WorldSide {
  worldId: string
  entryId?: string
  /** Open at the inbox. */
  inbox?: boolean
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
  /** Writing on the left, the AI beside it. */
  | { view: 'splitAi'; write: WriteSide }
  /** The AI alone (a torn-off window). */
  | { view: 'ai'; seriesId: string; volumeId: string }

const writeSide = (r: Extract<PaneRoute, { kind: 'write' }>): WriteSide => ({
  seriesId: r.seriesId,
  volumeId: r.volumeId,
  open: r.chapterId ? { chapterId: r.chapterId, token: Date.now() } : undefined,
})

/** A torn-off window starts at its pane's route. */
function startRoute(detached: PaneRoute | null): Route {
  if (!detached) return { view: 'shelf' }
  if (detached.kind === 'write') return { view: 'volume', ...writeSide(detached) }
  if (detached.kind === 'ai') {
    return { view: 'ai', seriesId: detached.seriesId, volumeId: detached.volumeId }
  }
  return {
    view: 'world',
    worldId: detached.worldId,
    entryId: detached.entryId,
    inbox: detached.inbox,
    token: 1,
  }
}

/** A pane docked back (or sent here) from a torn-off window: beside the current view, or instead. */
function withDocked(current: Route, route: PaneRoute): Route {
  if (route.kind === 'ai') {
    if (current.view === 'volume') return { view: 'splitAi', write: current }
    if (current.view === 'split' || current.view === 'splitAi') {
      return { view: 'splitAi', write: current.write }
    }
    return {
      view: 'splitAi',
      write: { seriesId: route.seriesId, volumeId: route.volumeId },
    }
  }
  if (route.kind === 'world') {
    const world = {
      worldId: route.worldId,
      entryId: route.entryId,
      inbox: route.inbox,
      token: Date.now(),
    }
    if (current.view === 'volume') return { view: 'split', write: current, world }
    if (current.view === 'split') return { ...current, world }
    if (current.view === 'splitAi') return { view: 'split', write: current.write, world }
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
  if (current.view === 'split' || current.view === 'splitAi') return { ...current, write }
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
  // Roundtable is a full-width mode of the existing AI tab, not another sidebar pane.
  const [roundtableExpanded, setRoundtableExpanded] = useState(false)
  // Where each pane is now, as it reports it (for popping out, and for a torn-off window).
  const at = useRef<{ write?: PaneRoute; world?: PaneRoute; ai?: PaneRoute }>({})
  const word = useWords()
  const { toast } = useOverlays()

  const refresh = useCallback(() => {
    api.invoke('library:snapshot').then(setSnapshot, (err) => setError(describeError(err).message))
  }, [])
  // Loads at once (a torn-off window can start in the writing view), and again on leaving
  // the writing view, to pick up word counts skipped below.
  const writing = route.view === 'volume' || route.view === 'split' || route.view === 'splitAi'
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
  const reportWrite = useCallback(
    (r: PaneRoute) => {
      at.current.write = r
      if (detached) void api.invoke('window:route', { route: r })
    },
    [detached],
  )
  const reportAi = useCallback(
    (r: PaneRoute) => {
      at.current.ai = r
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

  /** New look: the world beside the page, from writing alone or with the AI beside (or closes it). */
  const toggleWorldBeside = useCallback(() => {
    setRoute((current) => {
      if (current.view === 'split') return { view: 'volume', ...current.write }
      const write =
        current.view === 'volume' ? current : current.view === 'splitAi' ? current.write : null
      const worldId = write && snapshot?.series.find((s) => s.id === write.seriesId)?.worldId
      return write && worldId ? { view: 'split', write: { ...write }, world: { worldId } } : current
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
            isBook(s) && s.volumes[0]
              ? {
                  id: `series:${s.id}`,
                  group: 'Open book',
                  title: s.name,
                  run: () =>
                    setRoute({ view: 'volume', seriesId: s.id, volumeId: s.volumes[0]!.id }),
                }
              : {
                  id: `series:${s.id}`,
                  group: 'Open series',
                  title: s.name,
                  run: () => setRoute({ view: 'series', seriesId: s.id }),
                },
            ...(isBook(s) ? [] : s.volumes).map((v) => ({
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

  /** The world's inbox: beside the writing view (or in a window of its own from a torn-off pane). */
  const openInbox = (worldId: string) => {
    const write =
      route.view === 'volume'
        ? route
        : route.view === 'split' || route.view === 'splitAi'
          ? route.write
          : null
    if (detached || route.view === 'ai') {
      void api.invoke('window:open', { route: { kind: 'world', worldId, inbox: true } })
      return
    }
    const world = { worldId, inbox: true, token: Date.now() }
    setRoute(write ? { view: 'split', write, world } : { view: 'world', ...world })
    setActiveSide('world')
  }

  // AI work runs in the background: say when it's done, wherever the writer is.
  useIpcEvent('ai:jobDone', (job) => {
    const worldId = seriesOf(job.seriesId)?.worldId
    if (job.kind === 'voices') {
      if (job.state === 'failed') toast(`The audiobook script couldn’t be made: ${job.error}`)
      else if (job.state === 'done' && job.result) {
        const r = job.result
        toast(
          r.saved
            ? `Saved the audiobook script (${r.chapters} ${r.chapters === 1 ? 'chapter' : 'chapters'}, ${r.lines} lines): ${r.saved}. Open it in VoiceStudio’s Audiobook page and give each name a voice in the Cast.`
            : 'The audiobook script was made but not saved.',
        )
      }
      return
    }
    if (job.kind === 'names') {
      if (job.state === 'done' && job.result) {
        toast(
          sortNamesNote(job.result),
          worldId ? { label: 'Open the inbox', run: () => openInbox(worldId) } : undefined,
        )
      } else if (job.state === 'failed') toast(`Sorting names didn’t work: ${job.error}`)
      return
    }
    if (job.kind === 'world') {
      // Started by itself: quiet, unless something needs the writer.
      if (job.auto && !(job.result?.questions || job.result?.continuity)) return
      if (job.state === 'done' && job.result) {
        toast(
          worldUpdateNote(job.chapterTitle, job.result),
          worldId ? { label: 'Open the inbox', run: () => openInbox(worldId) } : undefined,
        )
      } else if (job.state === 'failed') {
        toast(
          `Updating the world from “${job.chapterTitle || 'Untitled'}” didn’t work: ${job.error}`,
        )
      }
      return
    }
    const aiOpen =
      route.view === 'ai' || (route.view === 'splitAi' && route.write.seriesId === job.seriesId)
    if (aiOpen || job.state === 'cancelled') return
    const write = route.view === 'volume' && route.seriesId === job.seriesId ? route : null
    const open = write
      ? {
          label: 'Open the AI',
          run: () => setRoute((r) => (r.view === 'volume' ? { view: 'splitAi', write: r } : r)),
        }
      : undefined
    if (job.state === 'failed') toast(`The AI couldn’t finish: ${job.error}`, open)
    else if (job.kind === 'edit') {
      toast(`The AI’s edit of “${job.chapterTitle || 'Untitled'}” is ready to look over.`, open)
    } else toast('The AI has answered. It’s saved in the conversation.', open)
  })

  if (error) return <p className="error page-message">{error}</p>
  if (!snapshot) return null

  const toShelf = () => setRoute({ view: 'shelf' })
  /** In a torn-off window: put this pane back in the main window. */
  const dock = (side: 'write' | 'world') => {
    const r = at.current[side]
    if (r) void api.invoke('window:dock', { route: r })
  }
  /** In a torn-off window: its tab let go outside it docks if that was over the main window. */
  const dropOutside = (side: 'write' | 'world') => {
    const r = at.current[side]
    if (r) void api.invoke('window:dropped', { route: r })
  }
  /** Pops a split pane out into its own window, leaving the other one here. */
  const popOut = (side: 'write' | 'world', atCursor = false) => {
    if (route.view !== 'split') return
    const r =
      at.current[side] ??
      (side === 'write'
        ? { kind: 'write' as const, seriesId: route.write.seriesId, volumeId: route.write.volumeId }
        : { kind: 'world' as const, worldId: route.world.worldId })
    void api.invoke('window:open', { route: r, atCursor })
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
      onOpenVolume={(seriesId, volumeId) => setRoute({ view: 'volume', seriesId, volumeId })}
      onOpenTrash={() => setRoute({ view: 'trash' })}
      onOpenWorld={(worldId) => setRoute({ view: 'world', worldId })}
      onOpenSettings={() => setRoute({ view: 'settings' })}
    />
  )

  /** Opens (or closes) the AI beside the writing view; from a torn-off writing window, in its own. */
  const toggleAi = (write: WriteSide, place: 'alone' | 'split' | 'detached') => {
    if (place === 'detached') {
      void api.invoke('window:open', {
        route: { kind: 'ai', seriesId: write.seriesId, volumeId: write.volumeId },
      })
      return
    }
    setRoute((current) => {
      if (current.view === 'splitAi') return { view: 'volume', ...current.write }
      if (current.view === 'volume') return { view: 'splitAi', write: current }
      if (current.view === 'split') return { view: 'splitAi', write: current.write }
      return current
    })
    setActiveSide('world')
  }

  /** The AI for one side (beside the writing view, or torn off). */
  const aiPane = (side: { seriesId: string; volumeId: string }, place: 'split' | 'detached') => {
    const series = seriesOf(side.seriesId)
    if (!series) return null
    const route: PaneRoute = { kind: 'ai', seriesId: side.seriesId, volumeId: side.volumeId }
    return (
      <PaneFrame
        id="ai"
        title={`AI · ${series.name}`}
        active={place === 'detached' || activeSide === 'world'}
        split={place === 'split'}
        detached={place === 'detached'}
        onActivate={() => setActiveSide('world')}
        onRoute={reportAi}
        onPopOut={
          place === 'split' && route
            ? (atCursor) => {
                void api.invoke('window:open', { route, atCursor })
                setRoute((current) =>
                  current.view === 'splitAi' ? { view: 'volume', ...current.write } : current,
                )
              }
            : undefined
        }
        onClose={
          place === 'split'
            ? () =>
                setRoute((current) =>
                  current.view === 'splitAi' ? { view: 'volume', ...current.write } : current,
                )
            : undefined
        }
        onDock={place === 'detached' ? () => void api.invoke('window:dock', { route }) : undefined}
        onDropOutside={
          place === 'detached' ? () => void api.invoke('window:dropped', { route }) : undefined
        }
      >
        <AiView
          seriesId={side.seriesId}
          volumeId={side.volumeId}
          onRoute={reportAi}
          onOpenInbox={openInbox}
          roundtableActive={roundtableExpanded}
          onRoundtableChange={setRoundtableExpanded}
        />
      </PaneFrame>
    )
  }

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
        worlds={snapshot.worlds}
        open={write.open}
        onBack={place === 'detached' ? () => dock('write') : toShelf}
        onOpenSeries={() => setRoute({ view: 'series', seriesId: series.id })}
        onOpenVolumeAt={
          place === 'detached'
            ? undefined
            : (volumeId, open) => {
                const target: WriteSide = { seriesId: series.id, volumeId, open }
                setRoute((r) =>
                  r.view === 'split' || r.view === 'splitAi'
                    ? { ...r, write: target }
                    : { view: 'volume', ...target },
                )
              }
        }
        onOpenWorld={series.worldId ? openWorldFrom(series, write) : undefined}
        onOpenWorldBeside={
          // With the AI beside, the world can still come in its place (Classic shows the button).
          series.worldId && place === 'alone'
            ? splitCurrent
            : series.worldId && place === 'split' && route.view === 'splitAi'
              ? toggleWorldBeside
              : undefined
        }
        onToggleAi={() => toggleAi(write, place)}
        aiBeside={route.view === 'splitAi'}
        hideModeSwitch={place !== 'alone'}
        beside={
          place === 'detached'
            ? null
            : route.view === 'split'
              ? 'world'
              : route.view === 'splitAi'
                ? 'ai'
                : null
        }
        onToggleWorldBeside={place !== 'detached' && series.worldId ? toggleWorldBeside : undefined}
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
        onPopOut={
          place === 'split' && route.view === 'split'
            ? (atCursor) => popOut('write', atCursor)
            : undefined
        }
        onClose={
          place === 'split' && route.view === 'split'
            ? () => setRoute({ view: 'world', ...route.world, from: route.write })
            : undefined
        }
        onDock={place === 'detached' ? () => dock('write') : undefined}
        onDropOutside={place === 'detached' ? () => dropOutside('write') : undefined}
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
        inbox={world.inbox}
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
        onPopOut={place === 'split' ? (atCursor) => popOut('world', atCursor) : undefined}
        onClose={
          place === 'split' && route.view === 'split'
            ? () => setRoute({ view: 'volume', ...route.write })
            : undefined
        }
        onDock={place === 'detached' ? () => dock('world') : undefined}
        onDropOutside={place === 'detached' ? () => dropOutside('world') : undefined}
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
          : route.view === 'ai'
            ? aiPane(route, 'detached')
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
  if (route.view === 'splitAi') {
    if (roundtableExpanded) {
      // Temporarily give the AI tab the entire workspace; returning to Chat restores the split.
      return (
        <AlonePane id="ai" onRoute={reportAi}>
          <AiView
            seriesId={route.write.seriesId}
            volumeId={route.write.volumeId}
            onRoute={reportAi}
            onOpenInbox={openInbox}
            roundtableActive={true}
            onRoundtableChange={setRoundtableExpanded}
          />
        </AlonePane>
      )
    }
    const left = writingPane(route.write, 'split')
    const right = aiPane(route.write, 'split')
    if (!left || !right) return left ?? shelf
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
        worlds={snapshot.worlds}
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
