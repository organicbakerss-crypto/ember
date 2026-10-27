import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OutlineView, SeriesSummary, VolumeStats, VolumeSummary } from '@shared/ipc'
import type { OutlineFile } from '@shared/schema'
import { api, describeError, useIpcEvent } from '../api'
import { Binder } from '../binder/Binder'
import { chapterOrder, toContainers } from '../binder/model'
import { ChapterEditor, type ChapterMeta, type EditorHandle } from '../editor/ChapterEditor'
import type { Scene } from '../editor/scenes'
import type { SaveState } from '../editor/useChapterSaver'
import { loadLocal, saveLocal } from '../storage'
import { SettingsPanel } from './SettingsPanel'
import { StatusBar } from './StatusBar'

type Panel = 'binder' | 'settings'

/** Write mode: top bar, icon rail, side panel (binder), the page, and the status bar. */
export function WritingView(props: {
  series: SeriesSummary
  volume: VolumeSummary
  backLabel: string
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

  const togglePanel = (which: Panel) => {
    const next = panel === which ? null : which
    setPanel(next)
    saveLocal('writing.panel', next ? 'open' : 'closed')
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

  return (
    <div className={`writing-view ${panel ? 'panel-open' : ''}`}>
      <header className="top-bar">
        <button className="link" onClick={props.onBack}>
          ← {props.backLabel}
        </button>
        <nav className="breadcrumb small" aria-label="Breadcrumb">
          <button className="link" onClick={props.onOpenSeries}>
            {series.name}
          </button>
          <span className="muted">/</span>
          <span>{volume.name}</span>
          {arc?.type === 'arc' && (
            <>
              <span className="muted">/</span>
              <span>{arc.name}</span>
            </>
          )}
          {current && (
            <>
              <span className="muted">/</span>
              <span className="breadcrumb-current">{current.title || 'Untitled chapter'}</span>
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
            />
          )}
          {panel === 'settings' && <SettingsPanel />}
          {error && <p className="error small">{error}</p>}
        </aside>
      )}

      <main className="page-area">
        {selectedId && view && selectedId in view.chapters ? (
          <ChapterEditor
            key={selectedId}
            seriesId={series.id}
            volumeId={volume.id}
            chapterId={selectedId}
            povOptions={povOptions}
            handle={editor}
            onMeta={onMeta}
            onWords={onWords}
            onScenes={setScenes}
            onSaveState={onSaveState}
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
