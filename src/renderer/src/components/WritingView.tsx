import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isBook, worldLinkMenu } from './worldLink'
import { AiPanel } from '../ai/AiPanel'
import { GrammarDialog } from '../ai/GrammarDialog'
import type {
  WorldSummary,
  CaptureContext,
  OutlineView,
  SeriesSummary,
  VolumeStats,
  VolumeSummary,
} from '@shared/ipc'
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
import { computeStats } from '@shared/analysis'
import type { AnalysisOptions } from '../editor/analysisDecorations'
import { flushAll } from '../saving'
import { useSettings } from '../useTheme'
import { loadLocal, saveLocal } from '../storage'
import { MOD, modKey, useCommands, type Command } from './commands'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { QuickAddDialog } from '../world/QuickAddDialog'
import { nameMatcher } from '@shared/names'
import { guessTemplate } from '@shared/world/guess'
import type { NameIndex } from '../editor/NameCards'
import { useWorld } from '../world/useWorld'
import { useUndo } from '../world/useUndo'
import { useWorldActions } from '../world/useWorldActions'
import { shownTemplates, templateOf } from '../world/model'
import { WorldPanel, type ChapterMention } from '../world/WorldPanel'
import { HistoryPanel } from './HistoryPanel'
import { SearchPanel } from './SearchPanel'
import { SettingsWindow } from './SettingsWindow'
import { useOverlays } from './overlays'
import { StatusBar } from './StatusBar'
import { useLibraryActions } from './useLibraryActions'
import { useWords } from '../skins/useWords'
import { copyChapterForRoyalRoad, ExportDialog } from '../io/ExportDialog'
import { ImportDialog } from '../io/ImportDialog'
import { usePane } from '../panes/PaneContext'

type Panel = 'binder' | 'search' | 'history' | 'diagnostics' | 'world' | 'ai'

/** A chapter to open, optionally showing the first use of a name. */
export interface ChapterTarget {
  chapterId: string
  find?: string
  token: number
}

/** Write mode: top bar, icon rail, side panel (binder), the page, and the status bar. */
export function WritingView(props: {
  series: SeriesSummary
  volume: VolumeSummary
  /** Every world, to link one to this story. */
  worlds?: WorldSummary[]
  /** Back to the bookshelf. */
  onBack: () => void
  open?: ChapterTarget
  /** Switch to World mode (the series' world), optionally at an entry. */
  /** Opens the world (at an entry): beside, in its own window (`window`), or instead. */
  onOpenWorld?: (entryId?: string, how?: 'window') => void
  /** Opens the world beside this view (split screen); unset when it already is. */
  onOpenWorldBeside?: () => void
  /** Beside the world already: no Write/World switch. */
  hideModeSwitch?: boolean
  onOpenSeries: () => void
}) {
  const word = useWords()
  const pane = usePane()
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
  // Beside the world the pane is narrow: the page gets the room, the binder starts closed.
  const [panel, setPanel] = useState<Panel | null>(() =>
    pane.split || loadLocal('writing.panel') === 'closed' ? null : 'binder',
  )
  const editor = useRef<EditorHandle>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [revealArcId, setRevealArcId] = useState<string | null>(null)
  const [focusMode, setFocusMode] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Bumped to reload the open chapter from disk (after a restore or replace-all).
  const [reloadToken, setReloadToken] = useState(0)
  const [reveal, setReveal] = useState<(Reveal & { chapterId: string }) | null>(null)
  const [searchFocus, setSearchFocus] = useState(0)
  // Writing analysis: Rhythm and Echo (off by default), Diagnostics word highlight.
  const [rhythm, setRhythm] = useState(() => loadLocal('writing.rhythm') === 'on')
  const [echo, setEcho] = useState(() => loadLocal('writing.echo') === 'on')
  const [highlightStem, setHighlightStem] = useState<string | null>(null)
  const [chapterParagraphs, setChapterParagraphs] = useState<string[]>([])
  const [selectionParagraphs, setSelectionParagraphs] = useState<string[] | null>(null)
  const { settings } = useSettings()
  const { choose, openMenu } = useOverlays()
  // Export and import dialogs (export can start with one chapter chosen).
  const aiOn = settings.ai.enabled
  const [checking, setChecking] = useState(false)
  const [exporting, setExporting] = useState<{ chapterId: string | null; only?: boolean } | null>(
    null,
  )
  const [importing, setImporting] = useState(false)
  const actions = useLibraryActions()

  // A story of one chapter (a short story) opens with the binder out of the way.
  const [sized, setSized] = useState(false)
  if (view && !sized) {
    setSized(true)
    if (Object.keys(view.chapters).length === 1 && panel === 'binder') setPanel(null)
  }

  const refresh = useCallback(() => {
    api.invoke('outline:get', ref).then(setView, (err) => setError(describeError(err).message))
    api.invoke('volume:stats', ref).then(setStats, () => {})
  }, [ref])
  useEffect(refresh, [refresh])
  // The series' world: its entries become linked names, POV choices and names left out of analysis.
  const worldId = series.worldId
  const { data: world } = useWorld(worldId)
  const book = isBook(series)
  const recordUndo = useUndo()
  const worldActions = useWorldActions(world, recordUndo)
  const names = useMemo(
    () =>
      (world?.view.entries ?? []).flatMap((e) =>
        [e.name, ...e.aliases].flatMap((n) => n.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []),
      ),
    [world],
  )

  // Quick add: a selected name becomes a world entry.
  const [quickAdd, setQuickAdd] = useState<{ name: string; guess: string | null } | null>(null)
  const startQuickAdd = (text?: string) => {
    const name = text ?? editor.current?.selectedText() ?? ''
    setQuickAdd({ name, guess: guessTemplate(name, editor.current?.textBeforeSelection() ?? '') })
  }
  useIpcEvent('text:quickAdd', (text) => startQuickAdd(text))
  useIpcEvent('text:captured', (message) => actions.toast(message))
  const openWorldRef = useRef(props.onOpenWorld)
  useEffect(() => {
    openWorldRef.current = props.onOpenWorld
  })

  const toggleRhythm = () =>
    setRhythm((on) => {
      saveLocal('writing.rhythm', on ? 'off' : 'on')
      return !on
    })
  const toggleEcho = () =>
    setEcho((on) => {
      saveLocal('writing.echo', on ? 'off' : 'on')
      return !on
    })

  const { analysis: analysisSettings } = settings
  const words = useMemo(
    () => ({
      fillers: new Set(analysisSettings.fillerWords),
      names: new Set(names),
      includeNames: analysisSettings.includeNames,
    }),
    [analysisSettings.fillerWords, analysisSettings.includeNames, names],
  )
  const analysis = useMemo<AnalysisOptions>(
    () => ({
      rhythm,
      echo,
      highlightStem,
      words,
      echoRange: analysisSettings.echoRange,
      rhythmMediumFrom: analysisSettings.rhythmMediumFrom,
      rhythmLongFrom: analysisSettings.rhythmLongFrom,
    }),
    [rhythm, echo, highlightStem, words, analysisSettings],
  )
  // Chapter statistics for the status bar, only when it shows any.
  const needsStats = settings.statusBar.some(
    (i) => !['chapterWords', 'sessionWords', 'projectWords', 'goals', 'sync'].includes(i),
  )
  const chapterStats = useMemo(
    () => (needsStats ? computeStats(chapterParagraphs) : null),
    [needsStats, chapterParagraphs],
  )
  useIpcEvent('library:changed', (change) => {
    if (change.kind === 'outline' && change.volumeId === volume.id) refresh()
  })

  // The open chapter: the one last chosen here if it still exists, else the first.
  const selectedId = useMemo(() => {
    if (!view) return null
    if (chosenId && chosenId in view.chapters) return chosenId
    return chapterOrder(toContainers(view.outline))[0] ?? null
  }, [view, chosenId])
  // Where this pane is (a torn-off window reopens there; popping out starts there).
  const { onRoute } = pane
  useEffect(() => {
    onRoute?.({
      kind: 'write',
      seriesId: series.id,
      volumeId: volume.id,
      chapterId: selectedId ?? undefined,
    })
  }, [onRoute, series.id, volume.id, selectedId])

  // Open a chapter asked for from elsewhere (an entry's appearances), at the first mention.
  const { open } = props
  const [openToken, setOpenToken] = useState<number | null>(null)
  if (open && open.token !== openToken) {
    setOpenToken(open.token)
    setChosenId(open.chapterId)
  }
  useEffect(() => {
    if (!open?.find) return
    api
      .invoke('search:volume', { ...ref, query: open.find, matchCase: true, wholeWord: true })
      .then(
        (result) => {
          const hit = result.hits.find((h) => h.chapterId === open.chapterId)
          if (hit) setReveal({ ...hit, token: Date.now() })
        },
        () => {},
      )
  }, [open, ref])

  const select = (chapterId: string) => {
    setChosenId(chapterId)
    setScenes([])
    setSelectionParagraphs(null)
    saveLocal(lastChapterKey, chapterId)
  }

  const openPanel = (next: Panel | null) => {
    setPanel(next)
    // Remembered for the full-width view only; a split pane always starts with it closed.
    if (!pane.split) saveLocal('writing.panel', next ? 'open' : 'closed')
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

  // Keyboard: F3 rename, Ctrl/Cmd+F find, Ctrl/Cmd+Shift+F focus mode, Esc leaves focus mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Beside another pane, only the one being worked in answers shortcuts.
      if (!pane.active) return
      const key = e.key.toLowerCase()
      if (e.key === 'F3') renameOpenChapter()
      else if (modKey(e) && e.shiftKey && key === 'f') setFocusMode((f) => !f)
      else if (modKey(e) && !e.shiftKey && (key === 'f' || key === 'h')) openSearch()
      else if (modKey(e) && e.altKey && e.code === 'KeyR') toggleRhythm()
      else if (modKey(e) && e.altKey && e.code === 'KeyE') toggleEcho()
      else if (modKey(e) && e.altKey && e.code === 'KeyN') startQuickAdd()
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

  // POV choices: names from the world first, then tags already used in this volume.
  const povOptions = useMemo(() => {
    const fromWorld = (world?.view.entries ?? [])
      .filter((e) => world && templateOf(world, e).lens === 'who')
      .map((e) => e.name)
    const used = view
      ? Object.keys(view.chapters).map((id) => liveMeta[id]?.pov ?? view.chapters[id]?.pov)
      : []
    return [...new Set([...fromWorld, ...used.filter((p): p is string => !!p).sort()])]
  }, [view, liveMeta, world])

  const current = selectedId ? (liveMeta[selectedId] ?? view?.chapters[selectedId]) : undefined

  // The world as of this chapter: hover cards and the side panel show facts at this point.
  const at = (selectedId ? world?.positions.get(selectedId) : undefined) ?? null
  const nameIndex = useMemo<NameIndex | null>(
    () => world && { world, terms: world.terms, at },
    [world, at],
  )
  const chapterMentions = useMemo<ChapterMention[]>(() => {
    if (!world) return []
    const matcher = nameMatcher(world.terms)
    const counts = new Map<string, number>()
    for (const p of chapterParagraphs) {
      for (const m of matcher.find(p)) counts.set(m.entryId, (counts.get(m.entryId) ?? 0) + 1)
    }
    return [...counts]
      .map(([id, count]) => ({ entry: world.byId.get(id)!, count }))
      .filter((m) => m.entry)
      .sort((a, b) => b.count - a.count || a.entry.name.localeCompare(b.entry.name))
  }, [world, chapterParagraphs])

  // Tell main what the right-click menu can capture into: who's in this chapter, then recent ones.
  const povEntryId = current?.povEntryId ?? null
  const chapterTitle = current?.title ?? ''
  const captureContext = useMemo<CaptureContext | null>(() => {
    if (!world || !selectedId) return null
    const pov = povEntryId ? world.resolve(povEntryId) : undefined
    const entries = [...(pov ? [pov] : []), ...chapterMentions.map((m) => m.entry)].filter(
      (e, i, list) => list.findIndex((x) => x.id === e.id) === i,
    )
    return {
      worldId: world.view.world.id,
      source: {
        seriesId: series.id,
        volumeId: volume.id,
        chapterId: selectedId,
        chapterTitle,
      },
      targets: entries.slice(0, 30).map((e) => ({
        entryId: e.id,
        name: e.name,
        fields: templateOf(world, e)
          .fields.filter((f) => f.kind === 'text')
          .map((f) => ({ id: f.id, label: f.label })),
      })),
    }
  }, [world, selectedId, povEntryId, chapterTitle, chapterMentions, series.id, volume.id])
  useEffect(() => {
    void api.invoke('capture:context', { context: captureContext }).catch(() => {})
  }, [captureContext])
  useEffect(() => () => void api.invoke('capture:context', { context: null }).catch(() => {}), [])
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
    { id: 'rename', title: 'Rename chapter', shortcut: 'F3', run: renameOpenChapter },
    {
      id: 'rhythm',
      title: rhythm ? 'Turn off Rhythm (sentence lengths)' : 'Turn on Rhythm (sentence lengths)',
      shortcut: `${MOD}Alt+R`,
      run: toggleRhythm,
    },
    {
      id: 'echo',
      title: echo ? 'Turn off Echo (repeated words)' : 'Turn on Echo (repeated words)',
      shortcut: `${MOD}Alt+E`,
      run: toggleEcho,
    },
    { id: 'diagnostics', title: 'Diagnostics', run: () => openPanel('diagnostics') },
    ...(world
      ? [
          {
            id: 'world-panel',
            title: 'Show the world beside the page',
            run: () => openPanel('world'),
          },
          ...world.view.entries.map((e) => ({
            id: `entry:${e.id}`,
            group: 'Go to entry',
            title: e.aliases.length ? `${e.name} (${e.aliases.join(', ')})` : e.name,
            run: () => props.onOpenWorld?.(e.id),
          })),
        ]
      : []),
    {
      id: 'quick-add',
      title: 'Add selection to the world',
      shortcut: `${MOD}Alt+N`,
      run: () => startQuickAdd(),
    },
    ...(props.onOpenWorld
      ? [{ id: 'world', title: 'Switch to World mode', run: () => props.onOpenWorld?.() }]
      : []),
    {
      id: 'scene-break',
      title: 'Insert scene break',
      run: () => editor.current?.insertSceneBreak(),
    },
    { id: 'binder', title: 'Show binder', run: () => openPanel('binder') },
    { id: 'history', title: 'Version history of this chapter', run: () => openPanel('history') },
    ...(aiOn
      ? [
          {
            id: 'ai',
            title: 'Ask the AI (chat, brainstorm, ask the story)',
            run: () => openPanel('ai'),
          },
          ...(selectedId
            ? [
                {
                  id: 'ai-grammar',
                  title: 'Check spelling and grammar (AI)',
                  run: () => setChecking(true),
                },
              ]
            : []),
        ]
      : []),
    { id: 'settings', title: 'Settings', run: () => setSettingsOpen(true) },
    ...(book
      ? []
      : [{ id: 'series', title: `Go to series page: ${series.name}`, run: props.onOpenSeries }]),
    ...(view ? chapterOrder(toContainers(view.outline)) : []).map((id) => ({
      id: `chapter:${id}`,
      group: 'Go to chapter',
      title: liveMeta[id]?.title || view?.chapters[id]?.title || 'Untitled chapter',
      run: () => {
        setFocusMode(false)
        select(id)
      },
    })),
    {
      id: 'export',
      title: 'Export… (Word, PDF, EPUB, Markdown)',
      run: () => setExporting({ chapterId: selectedId }),
    },
    ...(selectedId
      ? [
          {
            id: 'royal-road',
            title: 'Copy this chapter for Royal Road',
            run: () =>
              void copyChapterForRoyalRoad(
                { seriesId: series.id, volumeId: volume.id, chapterId: selectedId },
                actions.toast,
              ),
          },
        ]
      : []),
    { id: 'import-docx', title: 'Import from Word (.docx)…', run: () => setImporting(true) },
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
          {!book && (
            <>
              <button className="link" onClick={props.onOpenSeries} title="Open the series page">
                {series.name}
              </button>
              <span className="muted">/</span>
            </>
          )}
          <button
            className="link"
            onClick={() => openPanel('binder')}
            title={book ? 'Show the chapters' : "Show this volume's binder"}
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
        <span className="status-spacer" />
        <button
          className="icon"
          aria-label="Volume menu"
          title="Export, copy for Royal Road, import"
          onClick={(e) =>
            openMenu(e, [
              {
                label: 'Export… (Word, PDF, EPUB, Markdown)',
                onSelect: () => setExporting({ chapterId: selectedId }),
              },
              {
                label: 'Copy this chapter for Royal Road',
                disabled: !selectedId,
                onSelect: () =>
                  selectedId &&
                  void copyChapterForRoyalRoad(
                    { seriesId: series.id, volumeId: volume.id, chapterId: selectedId },
                    actions.toast,
                  ),
              },
              { label: 'Import from Word (.docx)…', onSelect: () => setImporting(true) },
              ...(aiOn
                ? [
                    {
                      label: 'Check spelling and grammar (AI)…',
                      disabled: !selectedId,
                      onSelect: () => setChecking(true),
                    },
                  ]
                : []),
              {
                label: book ? 'Chapter headings in exports' : 'This volume’s chapter headings',
                submenu: (
                  [
                    [null, 'As in Settings'],
                    ['both', 'Chapter 1: Arrival'],
                    ['number', 'Chapter 1'],
                    ['title', 'Arrival (stories, a collection)'],
                  ] as const
                ).map(([value, label]) => ({
                  label,
                  checked: (volume.settings['headings'] ?? null) === value,
                  onSelect: () =>
                    void api
                      .invoke('volume:update', { ...ref, headings: value })
                      .catch((err: unknown) => actions.toast(describeError(err).message)),
                })),
              },
              ...(book && props.worlds ? [worldLinkMenu(series, props.worlds, actions.toast)] : []),
              {
                label: 'Finished (keep less history)',
                checked: volume.settings['finished'] === true,
                onSelect: () =>
                  void api
                    .invoke('volume:update', {
                      ...ref,
                      finished: volume.settings['finished'] !== true,
                    })
                    .catch((err: unknown) => actions.toast(describeError(err).message)),
              },
            ])
          }
        >
          ⋯
        </button>
        {props.onOpenWorldBeside && (
          <button
            className="icon side-by-side"
            aria-label="Open the world beside"
            title={`Open the world beside (${MOD}\\)`}
            onClick={props.onOpenWorldBeside}
          >
            ⫽
          </button>
        )}
        {props.onOpenWorld && !props.hideModeSwitch && (
          <div className="segmented mode-switch" role="radiogroup" aria-label="Mode">
            <button role="radio" aria-checked className="active">
              Write
            </button>
            <button
              role="radio"
              aria-checked={false}
              onClick={() => props.onOpenWorld?.()}
              title="Open this series' world"
            >
              {word('world', 'World')}
            </button>
          </div>
        )}
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
        {aiOn && (
          <RailButton label="AI" active={panel === 'ai'} onClick={() => togglePanel('ai')}>
            <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
            <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />
          </RailButton>
        )}
        {world && (
          <RailButton
            label="World beside the page"
            active={panel === 'world'}
            onClick={() => togglePanel('world')}
          >
            <circle cx="12" cy="12" r="8.5" />
            <path d="M3.5 12h17M12 3.5c2.5 2.6 3.6 5.4 3.6 8.5s-1.1 5.9-3.6 8.5c-2.5-2.6-3.6-5.4-3.6-8.5s1.1-5.9 3.6-8.5z" />
          </RailButton>
        )}
        <span className="rail-spacer" />
        <RailButton
          label="Settings"
          active={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
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
              onCopyForRoyalRoad={(chapterId) =>
                void copyChapterForRoyalRoad(
                  { seriesId: series.id, volumeId: volume.id, chapterId },
                  actions.toast,
                )
              }
              onExportChapter={(chapterId) => setExporting({ chapterId, only: true })}
              onDeleteArc={(arc) => void deleteArc(arc)}
              revealArcId={revealArcId}
              entryName={(id) => world?.resolve(id)?.name}
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
              currentWords={
                selectedId
                  ? (liveWords[selectedId] ?? stats?.chapterWords[selectedId] ?? null)
                  : null
              }
              onRestored={() => setReloadToken((t) => t + 1)}
            />
          )}
          {panel === 'ai' && aiOn && (
            <AiPanel
              seriesId={series.id}
              volumeId={volume.id}
              chapterId={selectedId}
              selection={selectionParagraphs?.join('\n\n') || null}
              screenText={() => editor.current?.visibleText() ?? ''}
            />
          )}
          {panel === 'diagnostics' && (
            <DiagnosticsPanel
              seriesId={series.id}
              volumeId={volume.id}
              chapterId={selectedId}
              chapterTitle={current?.title ?? ''}
              chapterParagraphs={chapterParagraphs}
              selectionParagraphs={selectionParagraphs}
              words={words}
              highlightStem={highlightStem}
              onHighlight={setHighlightStem}
              onOpenChapter={select}
            />
          )}
          {panel === 'world' && world && (
            <WorldPanel
              world={world}
              mentions={chapterMentions}
              povEntryId={current?.povEntryId ?? null}
              chapterId={selectedId}
              at={at}
              actions={worldActions}
              record={recordUndo}
              onOpenEntry={(entryId) => props.onOpenWorld?.(entryId)}
            />
          )}
          {error && <p className="error small">{error}</p>}
        </aside>
      )}

      <main className="page-area">
        {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
        {/* The editor stays loaded behind Settings, keeping undo history and scroll position. */}
        <div className="page-area-inner" hidden={settingsOpen}>
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
              analysis={analysis}
              onToggleRhythm={toggleRhythm}
              onToggleEcho={toggleEcho}
              onParagraphs={setChapterParagraphs}
              nameIndex={nameIndex}
              linkNames={settings.linkNames}
              hoverCards={settings.world.hoverCards}
              onOpenEntry={(entryId, how) => props.onOpenWorld?.(entryId, how)}
              onSelection={setSelectionParagraphs}
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
        </div>
      </main>

      <StatusBar
        seriesId={series.id}
        volume={volume}
        chapterWords={
          selectedId ? (liveWords[selectedId] ?? stats?.chapterWords[selectedId] ?? null) : null
        }
        sessionWords={sessionWords}
        projectWords={projectWords}
        chapterStats={chapterStats}
        saveState={save.state}
        saveError={save.error}
        onOpenDiagnostics={() => openPanel('diagnostics')}
      />
      {quickAdd !== null && (
        <QuickAddDialog
          templates={world ? shownTemplates(world) : []}
          existing={world?.view.entries.flatMap((e) => [e.name, ...e.aliases]) ?? []}
          name={quickAdd.name}
          template={quickAdd.guess}
          noWorld={
            worldId
              ? undefined
              : {
                  seriesName: series.name,
                  onCreateWorld: async () => {
                    try {
                      const created = await api.invoke('world:create', {
                        name: `${series.name} world`,
                      })
                      await api.invoke('series:setWorld', {
                        seriesId: series.id,
                        worldId: created.id,
                      })
                    } catch (err) {
                      actions.toast(describeError(err).message)
                    }
                  },
                }
          }
          onCreate={async (name, template) => {
            const created = await worldActions.create(name, template)
            return !!created
          }}
          onCancel={() => setQuickAdd(null)}
        />
      )}
      {checking && selectedId && (
        <GrammarDialog
          seriesId={series.id}
          volumeId={volume.id}
          chapterId={selectedId}
          worldId={worldId}
          blocks={() => editor.current?.textBlocks() ?? null}
          apply={(expected, changes) => editor.current?.applyBlockChanges(expected, changes) ?? 0}
          onClose={() => setChecking(false)}
          toast={actions.toast}
        />
      )}
      {exporting && (
        <ExportDialog
          series={series}
          volume={volume}
          chapterId={exporting.chapterId}
          startWithChapter={exporting.only}
          onClose={() => setExporting(null)}
        />
      )}
      {importing && (
        <ImportDialog
          series={series}
          volumeId={volume.id}
          onClose={() => setImporting(false)}
          onImported={() => refresh()}
        />
      )}
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
