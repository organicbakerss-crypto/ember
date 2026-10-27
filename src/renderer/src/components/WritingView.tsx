import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OutlineView, SeriesSummary, VolumeStats, VolumeSummary } from '@shared/ipc'
import type { OutlineArc, OutlineFile } from '@shared/schema'
import { api, describeError, useIpcEvent } from '../api'
import { Binder } from '../binder/Binder'
import { chapterOrder, toContainers } from '../binder/model'
import {
  ChapterEditor,
  type ChapterMeta,
  type EditorHandle,
  type Reveal,
} from '../editor/ChapterEditor'
import type { Scene } from '../editor/scenes'
import type { SaveState } from '../editor/useChapterSaver'
import { flushAll } from '../saving'
import { loadLocal, saveLocal } from '../storage'
import { MOD, modKey, useCommands, type Command } from './commands'
import { HistoryPanel } from './HistoryPanel'
import { SearchPanel } from './SearchPanel'
import { SettingsPanel } from './SettingsPanel'
import { useOverlays } from './overlays'
import { StatusBar } from './StatusBar'
import { useLibraryActions } from './useLibraryActions'

type Panel = 'binder' | 'search' | 'history' | 'settings'

/** Write mode: top bar, icon rail, side panel (binder), the page, and the status bar. */
export function WritingView(props: {
  series: SeriesSummary
  volume: VolumeSummary
  /** Back to the bookshelf. */
  onBack: () => void
  onOpenSeries: () => void
}) {
  const { series, volume } = props
  const ref = useMemo(() => ({ seriesId: series.id, volumeId: volume.id }), [series.id, volume.id])
  const lastChapterKey = `writing.lastChapter.${volume.id}`

  const [view, setView] = useState<OutlineView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<VolumeStats | null>(null)
  const [chosenId, setChosenId] = useState<string | null>(() => loadLocal(lastChapterKey))
  const [liveMeta, setLiveMeta] = useState<Record<string, ChapterMeta>>({})
  const [liveWords, setLiveWords] = useState<Record<string, number>>({})
  const [scenes, setScenes] = useState<Scene[]>([])
  const [save, setSave] = useState<{ state: SaveState; error: string | null }>({
    state: 'saved',
    error: null,
  })
  const [panel, setPanel] = useState<Panel | null>(() =>
    loadLocal('writing.panel') === 'closed' ? null : 'binder',
  )
  const editor = useRef<EditorHandle>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [revealArcId, setRevealArcId] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  // Bumped to reload the open chapter from disk (after a restore or replace-all).
  const [reloadToken, setReloadToken] = useState(0)
  const [reveal, setReveal] = useState<(Reveal & { chapterId: string }) | null>(null)
  const [searchFocus, setSearchFocus] = useState(0)
  const { choose } = useOverlays()
  const actions = useLibraryActions()

  const refresh = useCallback(() => {
    api.invoke('outline:get', ref).then(setView, (err) => setError(describeError(err).message))
    api.invoke('volume:stats', ref).then(setStats, () => {})
  }, [ref])
  useEffect(refresh, [refresh])
  useIpcEvent('library:changed', (change) => {
    if (change.kind === 'outline' && change.volumeId === volume.id) refresh()
  })

  // The open chapter: the one last chosen here if it still exists, else the first.
  const selectedId = useMemo(() => {
    if (!view) return null
    if (chosenId && chosenId in view.chapters) return chosenId
    return chapterOrder(toContainers(view.outline))[0] ?? null
  }, [view, chosenId])

  const select = (chapterId: string) => {
    setChosenId(chapterId)
    setScenes([])
    saveLocal(lastChapterKey, chapterId)
  }

  const openPanel = (next: Panel | null) => {
    setPanel(next)
    saveLocal('writing.panel', next ? 'open' : 'closed')
  }
  const togglePanel = (which: Panel) => openPanel(panel === which ? null : which)

  const renameOpenChapter = () => {
    if (!selectedId) return
    setFocusMode(false)
    openPanel('binder')
    setRenamingId(selectedId)
  }
  const openSearch = () => {
    setFocusMode(false)
    openPanel('search')
    setSearchFocus((n) => n + 1)
  }

  // Keyboard: F2 rename, Ctrl/Cmd+F find, Ctrl/Cmd+Shift+F focus mode, Esc leaves focus mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (e.key === 'F2') renameOpenChapter()
      else if (modKey(e) && e.shiftKey && key === 'f') setFocusMode((f) => !f)
      else if (modKey(e) && !e.shiftKey && (key === 'f' || key === 'h')) openSearch()
      else if (e.key === 'Escape' && focusMode) setFocusMode(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const renameChapter = async (chapterId: string, title: string) => {
    if (chapterId === selectedId && editor.current) {
      // The open chapter: go through its editor so the page and autosave agree.
      editor.current.setTitle(title)
      return
    }
    await api.invoke('chapter:save', { ...ref, chapterId, patch: { title } })
    const stored = view?.chapters[chapterId]
    if (stored) setLiveMeta((m) => ({ ...m, [chapterId]: { ...stored, ...m[chapterId], title } }))
  }

  const trashChapter = (chapterId: string) => {
    const title = liveMeta[chapterId]?.title ?? view?.chapters[chapterId]?.title ?? ''
    void actions.moveToTrash({ kind: 'chapter', ...ref, chapterId }, title || 'Untitled chapter')
  }

  const deleteArc = async (arc: OutlineArc) => {
    let chapters: 'keep' | 'trash' = 'keep'
    if (arc.chapterIds.length > 0) {
      const n = arc.chapterIds.length
      const answer = await choose(
        `Delete the arc “${arc.name}”?`,
        [
          {
            value: 'keep',
            label: `Keep the ${n === 1 ? 'chapter' : `${n} chapters`}`,
            primary: true,
          },
          {
            value: 'trash',
            label: `Move ${n === 1 ? 'it' : 'them'} to the trash too`,
            danger: true,
          },
        ],
        `It holds ${n === 1 ? 'one chapter' : `${n} chapters`}. Kept chapters move out of the arc, to where it was.`,
      )
      if (!answer) return
      chapters = answer
    }
    try {
      if (chapters === 'trash') await flushAll()
      setView(await api.invoke('arc:delete', { ...ref, arcId: arc.id, chapters }))
      if (chapters === 'trash')
        actions.toast('Chapters moved to the trash. Restore them from the Trash on the bookshelf.')
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const saveOutline = async (outline: OutlineFile) => {
    try {
      setView(await api.invoke('outline:save', { ...ref, outline }))
      setError(null)
    } catch (err) {
      setError(describeError(err).message)
      refresh()
    }
  }

  // One chapter per click, even if the button is pressed again before the first appears.
  const creating = useRef(false)
  const createChapter = async (arcId?: string) => {
    if (creating.current) return
    creating.current = true
    try {
      const chapter = await api.invoke('chapter:create', { ...ref, title: '', arcId })
      select(chapter.id)
    } catch (err) {
      setError(describeError(err).message)
    } finally {
      creating.current = false
    }
  }

  // Word counts: saved counts per chapter, replaced by live counts for chapters edited here.
  const projectWords = useMemo(() => {
    if (!stats) return 0
    const ids = new Set([...Object.keys(stats.chapterWords), ...Object.keys(liveWords)])
    let total = 0
    for (const id of ids) total += liveWords[id] ?? stats.chapterWords[id] ?? 0
    return total
  }, [stats, liveWords])
  const sessionWords = stats ? projectWords - stats.sessionStartWords : 0

  const onMeta = useCallback(
    (meta: ChapterMeta) => selectedId && setLiveMeta((m) => ({ ...m, [selectedId]: meta })),
    [selectedId],
  )
  const onWords = useCallback(
    (words: number) => selectedId && setLiveWords((w) => ({ ...w, [selectedId]: words })),
    [selectedId],
  )
  const onSaveState = useCallback(
    (state: SaveState, err: string | null) => setSave({ state, error: err }),
    [],
  )

  const povOptions = useMemo(() => {
    if (!view) return []
    const all = Object.keys(view.chapters).map((id) => liveMeta[id]?.pov ?? view.chapters[id]?.pov)
    return [...new Set(all.filter((p): p is string => !!p))].sort()
  }, [view, liveMeta])

  const current = selectedId ? (liveMeta[selectedId] ?? view?.chapters[selectedId]) : undefined
  const arc = view?.outline.items.find(
    (i) => i.type === 'arc' && selectedId && i.chapterIds.includes(selectedId),
  )

  const commands: Command[] = [
    { id: 'new-chapter', title: 'New chapter', run: () => void createChapter() },
    { id: 'find', title: 'Find in volume', shortcut: `${MOD}F`, run: openSearch },
    { id: 'replace', title: 'Find and replace in volume', shortcut: `${MOD}H`, run: openSearch },
    {
      id: 'focus',
      title: focusMode ? 'Leave focus mode' : 'Focus mode',
      shortcut: `${MOD}Shift+F`,
      run: () => setFocusMode((f) => !f),
    },
    { id: 'rename', title: 'Rename chapter', shortcut: 'F2', run: renameOpenChapter },
    {
      id: 'scene-break',
      title: 'Insert scene break',
      run: () => editor.current?.insertSceneBreak(),
    },
    { id: 'binder', title: 'Show binder', run: () => openPanel('binder') },
    { id: 'history', title: 'Version history of this chapter', run: () => openPanel('history') },
    { id: 'settings', title: 'Settings', run: () => openPanel('settings') },
    { id: 'series', title: `Go to series page: ${series.name}`, run: props.onOpenSeries },
    ...(view ? chapterOrder(toContainers(view.outline)) : []).map((id) => ({
      id: `chapter:${id}`,
      group: 'Go to chapter',
      title: liveMeta[id]?.title || view?.chapters[id]?.title || 'Untitled chapter',
      run: () => {
        setFocusMode(false)
        select(id)
      },
    })),
  ]
  useCommands('writing', commands)

  return (
    <div className={`writing-view ${panel ? 'panel-open' : ''} ${focusMode ? 'focus-mode' : ''}`}>
      {focusMode && (
        <button className="focus-exit small" onClick={() => setFocusMode(false)}>
          Leave focus mode (Esc)
        </button>
      )}
      <header className="top-bar">
        <button className="link" onClick={props.onBack} title="Back to the bookshelf">
          ← Bookshelf
        </button>
        <nav className="breadcrumb small" aria-label="Breadcrumb">
          <button className="link" onClick={props.onOpenSeries} title="Open the series page">
            {series.name}
          </button>
          <span className="muted">/</span>
          <button
            className="link"
            onClick={() => openPanel('binder')}
            title="Show this volume's binder"
          >
            {volume.name}
          </button>
          {arc?.type === 'arc' && (
            <>
              <span className="muted">/</span>
              <button
                className="link"
                title="Show this arc in the binder"
                onClick={() => {
                  openPanel('binder')
                  setRevealArcId(arc.id)
                }}
              >
                {arc.name}
              </button>
            </>
          )}
          {current && (
            <>
              <span className="muted">/</span>
              <button
                className="link breadcrumb-current"
                title="Go to the start of this chapter"
                onClick={() => editor.current?.jumpTo(0)}
              >
                {current.title || 'Untitled chapter'}
              </button>
            </>
          )}
        </nav>
      </header>

      <nav className="icon-rail" aria-label="Panels">
        <RailButton
          label="Binder"
          active={panel === 'binder'}
          onClick={() => togglePanel('binder')}
        >
          <path d="M5 5h14M5 10h14M8 15h11M8 20h11" />
        </RailButton>
        <RailButton
          label={`Find in volume (${MOD}F)`}
          active={panel === 'search'}
          onClick={() => (panel === 'search' ? togglePanel('search') : openSearch())}
        >
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15l5.5 5.5" />
        </RailButton>
        <RailButton
          label="History"
          active={panel === 'history'}
          onClick={() => togglePanel('history')}
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </RailButton>
        <span className="rail-spacer" />
        <RailButton
          label="Settings"
          active={panel === 'settings'}
          onClick={() => togglePanel('settings')}
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
        </RailButton>
      </nav>

      {panel && (
        <aside className="side-panel">
          {panel === 'binder' && view && (
            <Binder
              volumeName={volume.name}
              view={view}
              liveMeta={liveMeta}
              selectedId={selectedId}
              scenes={scenes}
              onSelect={select}
              onJump={(pos) => editor.current?.jumpTo(pos)}
              onSave={saveOutline}
              onCreateChapter={(arcId) => void createChapter(arcId)}
              onCreateArc={(name) => api.invoke('arc:create', { ...ref, name })}
              renamingId={renamingId}
              onRenamingChange={setRenamingId}
              onRenameChapter={renameChapter}
              onTrashChapter={trashChapter}
              onDeleteArc={(arc) => void deleteArc(arc)}
              revealArcId={revealArcId}
            />
          )}
          {panel === 'search' && (
            <SearchPanel
              seriesId={series.id}
              volumeId={volume.id}
              focusToken={searchFocus}
              onOpenHit={(hit) => {
                if (hit.chapterId !== selectedId) select(hit.chapterId)
                setReveal({ ...hit, chapterId: hit.chapterId, token: Date.now() })
              }}
              onReplaceSelection={(replacement, query, matchCase) =>
                editor.current?.replaceSelection(replacement, query, matchCase) ?? false
              }
              onReplacedAll={() => setReloadToken((t) => t + 1)}
            />
          )}
          {panel === 'history' && (
            <HistoryPanel
              seriesId={series.id}
              volumeId={volume.id}
              chapterId={selectedId}
              chapterTitle={current?.title ?? ''}
              onRestored={() => setReloadToken((t) => t + 1)}
            />
          )}
          {panel === 'settings' && <SettingsPanel />}
          {error && <p className="error small">{error}</p>}
        </aside>
      )}

      <main className="page-area">
        {selectedId && view && selectedId in view.chapters ? (
          <ChapterEditor
            key={`${selectedId}:${reloadToken}`}
            seriesId={series.id}
            volumeId={volume.id}
            chapterId={selectedId}
            povOptions={povOptions}
            handle={editor}
            onMeta={onMeta}
            onWords={onWords}
            onScenes={setScenes}
            onSaveState={onSaveState}
            reveal={reveal?.chapterId === selectedId ? reveal : null}
            bare={focusMode}
          />
        ) : (
          view && (
            <div className="page-message">
              <p className="muted">This volume has no chapters yet.</p>
              <button className="primary" onClick={() => void createChapter()}>
                Start the first chapter
              </button>
            </div>
          )
        )}
      </main>

      <StatusBar
        seriesId={series.id}
        volume={volume}
        chapterWords={
          selectedId ? (liveWords[selectedId] ?? stats?.chapterWords[selectedId] ?? null) : null
        }
        sessionWords={sessionWords}
        projectWords={projectWords}
        saveState={save.state}
        saveError={save.error}
      />
    </div>
  )
}

function RailButton(props: {
  label: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      className={`rail-button ${props.active ? 'active' : ''}`}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.active}
      onClick={props.onClick}
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        {props.children}
      </svg>
    </button>
  )
}
