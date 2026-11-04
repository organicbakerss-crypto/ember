import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isBook, worldLinkMenu } from './worldLink'
import { offerScope, requestEdit, requestPrompt, useScopeAnswers } from '../ai/scope'
import { STORY_PROMPTS } from '../ai/storyPrompts'
import { updateWorld } from '../ai/worldUpdate'
import { Recap } from '../ai/Recap'
import { ReadAloud } from '../voice/ReadAloud'
import { StudioReader } from '../voice/StudioReader'
import { Dictation } from '../voice/Dictation'
import { CastDialog } from '../voice/CastDialog'
import { SpeakersDialog } from '../voice/SpeakersDialog'
import type {
  WorldSummary,
  CaptureContext,
  OutlineView,
  SeriesSummary,
  VolumeStats,
  VolumeSummary,
} from '@shared/ipc'
import type {
  ChapterLabel,
  ChapterStatus,
  OutlineArc,
  OutlineFile,
  PublishInfo,
  RichTextDoc,
} from '@shared/schema'
import { api, describeError, useIpcEvent } from '../api'
import { Binder, STATUS_NAMES } from '../binder/Binder'
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
import { isMac, MOD, modKey, useCommands, type Command } from './commands'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { ChapterNotesPanel } from './ChapterNotesPanel'
import { CommentsPanel } from './CommentsPanel'
import { PublishingPanel } from './PublishingPanel'
import type { CommentInfo } from '../editor/comments'
import { ManuscriptView } from '../manuscript/ManuscriptView'
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

type Panel =
  | 'binder'
  | 'search'
  | 'notes'
  | 'comments'
  | 'publishing'
  | 'history'
  | 'diagnostics'
  | 'world'
  | 'ai'

/** A chapter to open, optionally showing the first use of a name. */
export interface ChapterTarget {
  chapterId: string
  find?: string
  /** A search match to select (with the find panel open), from a search of the whole story. */
  hit?: { node: number; start: number; end: number }
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
  /** Opens or closes the AI beside the page. */
  onToggleAi?: () => void
  /** The AI is open beside the page. */
  aiBeside?: boolean
  /** Beside the world already: no Write/World switch. */
  hideModeSwitch?: boolean
  onOpenSeries: () => void
  /** Opens another volume of this story at a chapter (a match from a whole-story search). */
  onOpenVolumeAt?: (volumeId: string, target: ChapterTarget) => void
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
  const [comments, setComments] = useState<CommentInfo[]>([])
  const [activeComment, setActiveComment] = useState<string | null>(null)
  const [newComment, setNewComment] = useState<string | null>(null)
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
  // Full screen (F11, the View menu, or the palette): just the page, filling the screen.
  const [fullScreen, setFullScreen] = useState(false)
  useIpcEvent('window:fullScreen', (on) => {
    setFullScreen(on)
    if (pane.active || !on) setFocusMode(on)
  })
  const leaveFocus = () => {
    setFocusMode(false)
    if (fullScreen) void api.invoke('window:fullScreen', { on: false })
  }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [manuscriptOpen, setManuscriptOpen] = useState(false)
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
  const { settings, update: updateSettings } = useSettings()
  const { choose, openMenu } = useOverlays()
  // Export and import dialogs (export can start with one chapter chosen).
  const aiOn = settings.ai.enabled
  // Offer the AI what this view shows (it reads it when asked).
  useScopeAnswers()
  /** "Edit with AI": opens the AI beside the page with Edit chapter ticked. */
  const editWithAi = (draft: string) => {
    requestEdit(series.id, draft)
    if (!props.aiBeside) props.onToggleAi?.()
  }
  // Voice: reading aloud (the blocks being read), and the audiobook script for VoiceStudio.
  const voiceOn = settings.voice.enabled
  const [reading, setReading] = useState<{
    studio: boolean
    blocks: { pos: number; text: string | null }[]
  } | null>(null)
  const [dictating, setDictating] = useState(false)
  const [castOpen, setCastOpen] = useState(false)
  const [speakersOpen, setSpeakersOpen] = useState(false)
  const stopDictating = useCallback(() => setDictating(false), [])
  const markReading = useCallback((pos: number | null) => editor.current?.markReading(pos), [])
  const stopReading = useCallback(() => setReading(null), [])
  const readAloud = async () => {
    const blocks = editor.current?.readingBlocks() ?? []
    if (!blocks.some((b) => b.text?.trim())) {
      actions.toast('There’s nothing here to read.')
      return
    }
    // VoiceStudio's voices when it's running; else this computer's.
    const studio = settings.voice.useStudio
      ? await api.invoke('voice:status').then(
          (s) => s.studio,
          () => false,
        )
      : false
    if (studio) await flushAll()
    setReading({ studio, blocks })
  }
  const dictate = async () => {
    const studio = await api.invoke('voice:status').then(
      (s) => s.studio,
      () => false,
    )
    if (studio) setDictating(true)
    else {
      actions.toast(
        'Dictation needs VoiceStudio running (Settings → Voice). On a Mac you can also use the Mac’s own dictation: press Fn twice.',
      )
    }
  }
  const audiobookScript = (chapterId: string | null) => {
    actions.toast(
      'Making the audiobook script: the AI marks who says each line. You’ll be asked where to save it.',
    )
    void flushAll().then(() =>
      api
        .invoke('voice:script', {
          requestId: `${Date.now()}-script`,
          seriesId: series.id,
          volumeId: volume.id,
          chapterId,
        })
        .catch(() => {}),
    )
  }
  /** Asks the AI (beside the page) for something about the whole story: a blurb, a synopsis. */
  const askAboutStory = (text: string) => {
    requestPrompt(series.id, text, 'story')
    if (!props.aiBeside) props.onToggleAi?.()
  }
  /** Reads the chapter for the world, in the background; what it finds waits in the world's inbox. */
  const worldFromChapter = async (chapterId: string) => {
    const title = liveMeta[chapterId]?.title || view?.chapters[chapterId]?.title || ''
    actions.toast(
      `Reading “${title || 'Untitled'}” for the world. Carry on; you’ll be told when it’s done.`,
    )
    await flushAll()
    // Done (or not) is announced wherever the writer is then.
    void updateWorld({ seriesId: series.id, volumeId: volume.id, chapterId }).catch(() => {})
  }
  const [exporting, setExporting] = useState<{ chapterId: string | null; only?: boolean } | null>(
    null,
  )
  const [importing, setImporting] = useState(false)
  const actions = useLibraryActions()
  const toast = actions.toast
  const dictated = useCallback(
    (text: string) => {
      if (!editor.current?.insertText(text)) toast(`Dictated (copy it in): ${text}`)
    },
    [toast],
  )

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
    if (open.hit) {
      setReveal({ ...open.hit, chapterId: open.chapterId, token: open.token })
      setPanel('search')
    }
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
    setManuscriptOpen(false)
    setScenes([])
    setSelectionParagraphs(null)
    saveLocal(lastChapterKey, chapterId)
  }

  const openPanel = (next: Panel | null) => {
    setPanel(next)
    // Remembered for the full-width view only; a split pane always starts with it closed.
    if (!pane.split) saveLocal('writing.panel', next ? 'open' : 'closed')
  }

  /** Comments on the selected text, then opens the comments with its note box ready. */
  const addComment = () => {
    const id = editor.current?.addComment() ?? null
    if (!id) {
      actions.toast('Select some text first, then add a comment to it.')
      return
    }
    setNewComment(id)
    openPanel('comments')
  }
  useIpcEvent('text:comment', () => {
    if (pane.active) addComment()
  })

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
      if (e.key === 'F2' || e.key === 'F3') renameOpenChapter()
      else if (modKey(e) && e.shiftKey && key === 'f') setFocusMode((f) => !f)
      else if (modKey(e) && !e.shiftKey && (key === 'f' || key === 'h')) openSearch()
      else if (modKey(e) && e.altKey && e.code === 'KeyR') toggleRhythm()
      else if (modKey(e) && e.altKey && e.code === 'KeyE') toggleEcho()
      else if (modKey(e) && e.altKey && e.code === 'KeyN') startQuickAdd()
      else if (modKey(e) && e.altKey && e.code === 'KeyM') addComment()
      else if (e.key === 'Escape' && focusMode) leaveFocus()
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

  /** Cuts the open chapter in two at the cursor; the rest becomes the next chapter. */
  const splitHere = async () => {
    if (!selectedId) return
    const halves = editor.current?.splitAtCursor() ?? null
    if (!halves) {
      actions.toast(
        'Put the cursor where the new chapter should start (not at the very start or end).',
      )
      return
    }
    try {
      await flushAll()
      const second = await api.invoke('chapter:split', {
        ...ref,
        chapterId: selectedId,
        before: halves.before as RichTextDoc,
        after: halves.after as RichTextDoc,
      })
      setReloadToken((t) => t + 1)
      actions.toast(
        `Split: the rest is now “${second.title || 'Untitled chapter'}”, right after it.`,
      )
    } catch (err) {
      actions.toast(describeError(err).message)
    }
  }
  useIpcEvent('text:split', () => {
    if (pane.active) void splitHere()
  })

  /** Joins the next chapter onto the end of this one (that one goes to the trash). */
  const mergeNext = async (chapterId: string) => {
    if (!view) return
    const order = chapterOrder(toContainers(view.outline))
    const nextId = order[order.indexOf(chapterId) + 1]
    if (!nextId) return
    const name = (id: string) =>
      `“${liveMeta[id]?.title || view.chapters[id]?.title || 'Untitled chapter'}”`
    const answer = await choose(
      `Join ${name(nextId)} onto the end of ${name(chapterId)}?`,
      [{ value: 'join', label: 'Join them', primary: true }],
      `A scene break goes between them. ${name(nextId)} goes to the trash, so you can get it back, and ${name(chapterId)} keeps its text from before in its history.`,
    )
    if (!answer) return
    try {
      await flushAll()
      await api.invoke('chapter:mergeNext', { ...ref, chapterId })
      if (selectedId === nextId) select(chapterId)
      setReloadToken((t) => t + 1)
    } catch (err) {
      actions.toast(describeError(err).message)
    }
  }

  const duplicate = async (chapterId: string) => {
    try {
      await flushAll()
      const copy = await api.invoke('chapter:duplicate', { ...ref, chapterId })
      select(copy.id)
    } catch (err) {
      actions.toast(describeError(err).message)
    }
  }

  // Optional modules this story uses (off unless turned on).
  const publishingOn = !!series.modules?.publishing
  const authorNotesOn = !!series.modules?.authorNotes
  const setModule = async (change: { publishing?: boolean; authorNotes?: boolean }) => {
    try {
      await api.invoke('series:modules', { seriesId: series.id, ...change })
      if (change.publishing) openPanel('publishing')
      if (change.authorNotes) openPanel('notes')
    } catch (err) {
      actions.toast(describeError(err).message)
    }
  }

  /** Sets a chapter's status or colour label (only that field is saved). */
  const markChapter = async (
    chapterId: string,
    patch: {
      status?: ChapterStatus | null
      label?: ChapterLabel | null
      publish?: PublishInfo | null
    },
  ) => {
    try {
      await api.invoke('chapter:save', { ...ref, chapterId, patch })
      refresh()
    } catch (err) {
      actions.toast(describeError(err).message)
    }
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
  const currentTitle = current?.title ?? ''
  const selectedText = selectionParagraphs?.join('\n\n') || null
  useEffect(() => {
    offerScope(series.id, {
      volumeId: volume.id,
      chapterId: selectedId,
      chapterTitle: currentTitle,
      selection: selectedText,
      screen: () => editor.current?.visibleText() ?? '',
      doc: () => editor.current?.getDoc() ?? null,
      replace: (doc) => editor.current?.replaceDoc(doc) ?? false,
    })
  }, [series.id, volume.id, selectedId, currentTitle, selectedText])
  useEffect(() => () => offerScope(series.id, null), [series.id])

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
  // The manuscript's chapters in reading order (kept the same array while the order is).
  const idsKey = view
    ? chapterOrder(toContainers(view.outline))
        .filter((id) => id in view.chapters)
        .join(',')
    : ''
  const manuscriptIds = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey])
  const ownHeadings = volume.settings['headings']
  const headings =
    ownHeadings === 'both' || ownHeadings === 'number' || ownHeadings === 'title'
      ? ownHeadings
      : settings.export.headings
  const arc = view?.outline.items.find(
    (i) => i.type === 'arc' && selectedId && i.chapterIds.includes(selectedId),
  )

  const voiceCommands = voiceOn
    ? [
        ...(selectedId
          ? [
              { id: 'voice-read', title: 'Read aloud from here', run: () => void readAloud() },
              { id: 'voice-dictate', title: 'Dictate (VoiceStudio)', run: () => void dictate() },
            ]
          : []),
        { id: 'voice-cast', title: 'Voices for this story…', run: () => setCastOpen(true) },
        ...(selectedId && aiOn
          ? [
              {
                id: 'voice-speakers',
                title: 'Who’s speaking in this chapter…',
                run: () => void flushAll().then(() => setSpeakersOpen(true)),
              },
            ]
          : []),
        ...(aiOn
          ? [
              ...(selectedId
                ? [
                    {
                      id: 'voice-script-chapter',
                      title: 'Audiobook script for VoiceStudio: this chapter',
                      run: () => audiobookScript(selectedId),
                    },
                  ]
                : []),
              {
                id: 'voice-script-book',
                title: `Audiobook script for VoiceStudio: ${book ? 'the book' : 'this volume'}`,
                run: () => audiobookScript(null),
              },
            ]
          : []),
      ]
    : []
  const commands: Command[] = [
    { id: 'new-chapter', title: 'New chapter', run: () => void createChapter() },
    { id: 'find', title: 'Find in volume', shortcut: `${MOD}F`, run: openSearch },
    { id: 'replace', title: 'Find and replace in volume', shortcut: `${MOD}H`, run: openSearch },
    {
      id: 'focus',
      title: focusMode ? 'Leave focus mode' : 'Focus mode',
      shortcut: `${MOD}Shift+F`,
      run: () => (focusMode ? leaveFocus() : setFocusMode(true)),
    },
    {
      id: 'fullscreen',
      title: fullScreen ? 'Leave full screen' : 'Full screen (just the page)',
      shortcut: isMac ? '⌃⌘F' : 'F11',
      run: () => void api.invoke('window:fullScreen', { on: !fullScreen }),
    },
    {
      id: 'typewriter',
      title: settings.typewriter ? 'Turn off typewriter scrolling' : 'Turn on typewriter scrolling',
      run: () => updateSettings({ typewriter: !settings.typewriter }),
    },
    { id: 'rename', title: 'Rename chapter', shortcut: 'F2', run: renameOpenChapter },
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
    { id: 'notes', title: 'Chapter synopsis and notes', run: () => openPanel('notes') },
    {
      id: 'comment',
      title: 'Comment on the selected text',
      shortcut: `${MOD}Alt+M`,
      run: addComment,
    },
    { id: 'comments', title: 'Show the comments', run: () => openPanel('comments') },
    publishingOn
      ? { id: 'publishing', title: 'Publishing tracker', run: () => openPanel('publishing') }
      : {
          id: 'publishing-on',
          title: 'Turn on the publishing tracker for this story',
          run: () => void setModule({ publishing: true }),
        },
    authorNotesOn
      ? { id: 'author-notes', title: 'Author’s notes', run: () => openPanel('notes') }
      : {
          id: 'author-notes-on',
          title: 'Turn on author’s notes for this story',
          run: () => void setModule({ authorNotes: true }),
        },
    ...(selectedId
      ? [
          { id: 'split', title: 'Split the chapter at the cursor', run: () => void splitHere() },
          {
            id: 'merge',
            title: 'Join the next chapter onto this one',
            run: () => void mergeNext(selectedId),
          },
          {
            id: 'duplicate',
            title: 'Duplicate this chapter',
            run: () => void duplicate(selectedId),
          },
        ]
      : []),
    ...(selectedId
      ? (['draft', 'revised', 'done'] as const).map((status) => ({
          id: `status-${status}`,
          title: `Mark this chapter as ${STATUS_NAMES[status]}`,
          run: () => void markChapter(selectedId, { status }),
        }))
      : []),
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
            run: () => props.onToggleAi?.(),
          },
          ...(selectedId
            ? [
                {
                  id: 'ai-edit',
                  title: 'Edit this chapter with AI (fix spelling and grammar, add a scene…)',
                  run: () => editWithAi('Fix the spelling, grammar and punctuation.'),
                },
                ...STORY_PROMPTS.map((p) => ({
                  id: `ai-${p.id}`,
                  title: `${p.label} (AI)`,
                  run: () => askAboutStory(p.text),
                })),
                ...(series.worldId
                  ? [
                      {
                        id: 'ai-world',
                        title: 'Update the world from this chapter (AI)',
                        run: () => void worldFromChapter(selectedId),
                      },
                    ]
                  : []),
              ]
            : []),
        ]
      : []),
    ...voiceCommands,
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
    <div
      className={`writing-view ${panel ? 'panel-open' : ''} ${focusMode ? 'focus-mode' : ''} ${settings.typewriter ? 'typewriter' : ''}`}
    >
      {focusMode && (
        <button className="focus-exit small" onClick={leaveFocus}>
          {fullScreen ? 'Leave full screen (Esc)' : 'Leave focus mode (Esc)'}
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
          title="Export & import, AI, voice, and this book’s settings"
          onClick={(e) =>
            openMenu(e, [
              {
                label: 'Export & import',
                submenu: [
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
                ],
              },
              ...(aiOn
                ? [
                    {
                      label: 'AI',
                      submenu: [
                        {
                          label: 'Edit with AI (spelling, grammar…)…',
                          disabled: !selectedId,
                          onSelect: () => editWithAi('Fix the spelling, grammar and punctuation.'),
                        },
                        ...(series.worldId
                          ? [
                              {
                                label: 'Update the world from this chapter',
                                disabled: !selectedId,
                                onSelect: () => selectedId && void worldFromChapter(selectedId),
                              },
                            ]
                          : []),
                        ...STORY_PROMPTS.map((p) => ({
                          label: `${p.label}…`,
                          onSelect: () => askAboutStory(p.text),
                        })),
                      ],
                    },
                  ]
                : []),
              ...(voiceCommands.length
                ? [
                    {
                      label: 'Voice',
                      submenu: voiceCommands.map((c) => ({ label: c.title, onSelect: c.run })),
                    },
                  ]
                : []),
              {
                label: book ? 'This book' : 'This volume',
                submenu: [
                  {
                    label: 'Chapter headings in exports',
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
                  ...(book && props.worlds
                    ? [worldLinkMenu(series, props.worlds, actions.toast)]
                    : []),
                  {
                    label: 'Publishing tracker',
                    checked: publishingOn,
                    onSelect: () => void setModule({ publishing: !publishingOn }),
                  },
                  {
                    label: 'Author’s notes',
                    checked: authorNotesOn,
                    onSelect: () => void setModule({ authorNotes: !authorNotesOn }),
                  },
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
                ],
              },
            ])
          }
        >
          ⋯
        </button>
        {view && (
          <button
            className="small"
            aria-pressed={manuscriptOpen}
            title={`The whole ${book ? 'book' : 'volume'} as one manuscript, cover first`}
            onClick={() => setManuscriptOpen((open) => !open)}
          >
            Manuscript
          </button>
        )}
        {props.onOpenWorldBeside && (
          <button
            className="side-by-side small"
            aria-label="Open the world beside"
            title={`Open the world beside the page, split screen (${MOD}\\)`}
            onClick={props.onOpenWorldBeside}
          >
            ◫ {word('world', 'World')} beside
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
          label="Synopsis and notes"
          active={panel === 'notes'}
          onClick={() => togglePanel('notes')}
        >
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M9 10h7M9 14h7M9 18h4" />
        </RailButton>
        {publishingOn && (
          <RailButton
            label="Publishing"
            active={panel === 'publishing'}
            onClick={() => togglePanel('publishing')}
          >
            <path d="M4 5h16v14H4z" />
            <path d="M8 3v4M16 3v4M4 10h16M9 15l2 2 4-4" />
          </RailButton>
        )}
        <RailButton
          label="Comments"
          active={panel === 'comments'}
          onClick={() => togglePanel('comments')}
        >
          <path d="M4 5h16v11H9l-5 4z" />
        </RailButton>
        <RailButton
          label="History"
          active={panel === 'history'}
          onClick={() => togglePanel('history')}
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </RailButton>
        <RailButton
          label="Diagnostics: words, sentences, repeated words"
          active={panel === 'diagnostics'}
          onClick={() => togglePanel('diagnostics')}
        >
          <path d="M5 20V11M10 20V5M15 20v-7M20 20V8" />
        </RailButton>
        {aiOn && (
          <RailButton
            label={props.aiBeside ? 'Close the AI' : 'AI beside the page'}
            active={!!props.aiBeside}
            onClick={() => props.onToggleAi?.()}
          >
            <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
            <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />
          </RailButton>
        )}
        {world && (
          <RailButton
            label="Who and where in this chapter"
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
              onOpenManuscript={() => setManuscriptOpen(true)}
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
              onSetStatus={(chapterId, status) => void markChapter(chapterId, { status })}
              onSetPublished={
                publishingOn
                  ? (chapterId, publish) => void markChapter(chapterId, { publish })
                  : undefined
              }
              onSplit={() => void splitHere()}
              onMergeNext={(chapterId) => void mergeNext(chapterId)}
              onDuplicate={(chapterId) => void duplicate(chapterId)}
              onSetLabel={(chapterId, label) => void markChapter(chapterId, { label })}
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
              multiVolume={series.volumes.length > 1}
              onOpenElsewhere={
                props.onOpenVolumeAt
                  ? (hit) =>
                      props.onOpenVolumeAt?.(hit.volumeId, {
                        chapterId: hit.chapterId,
                        hit: { node: hit.node, start: hit.start, end: hit.end },
                        token: Date.now(),
                      })
                  : undefined
              }
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
          {panel === 'notes' && (
            <ChapterNotesPanel
              seriesId={series.id}
              volumeId={volume.id}
              chapterId={selectedId}
              chapterTitle={current?.title ?? ''}
              aiOn={aiOn}
              authorNotes={authorNotesOn}
            />
          )}
          {panel === 'publishing' && publishingOn && (
            <PublishingPanel
              seriesId={series.id}
              onChanged={refresh}
              onOpenChapter={(volumeId, chapterId) => {
                if (volumeId === volume.id) select(chapterId)
                else props.onOpenVolumeAt?.(volumeId, { chapterId, token: Date.now() })
              }}
            />
          )}
          {panel === 'comments' && (
            <CommentsPanel
              comments={comments}
              activeId={activeComment}
              focusId={newComment}
              readOnly={false}
              onAdd={addComment}
              onNote={(id, note) => editor.current?.setCommentNote(id, note)}
              onRemove={(id) => editor.current?.removeComment(id)}
              onShow={(id) => editor.current?.showComment(id)}
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
        {aiOn && !focusMode && <Recap seriesId={series.id} chapterId={selectedId} />}
        {reading &&
          (reading.studio && selectedId ? (
            <StudioReader
              key={selectedId}
              seriesId={series.id}
              volumeId={volume.id}
              chapterId={selectedId}
              blocks={reading.blocks}
              mark={markReading}
              onClose={stopReading}
            />
          ) : (
            <ReadAloud
              key={selectedId ?? ''}
              blocks={reading.blocks}
              settings={settings.voice}
              mark={markReading}
              onClose={stopReading}
            />
          ))}
        {dictating && <Dictation seriesId={series.id} onText={dictated} onClose={stopDictating} />}
        {speakersOpen && selectedId && (
          <SpeakersDialog
            seriesId={series.id}
            volumeId={volume.id}
            chapterId={selectedId}
            chapterTitle={liveMeta[selectedId]?.title || view?.chapters[selectedId]?.title || ''}
            names={[
              ...new Set(
                (world?.view.entries ?? [])
                  .filter((e) => e.template === 'person')
                  .map((e) => e.name),
              ),
            ]}
            onClose={() => setSpeakersOpen(false)}
          />
        )}
        {castOpen && (
          <CastDialog
            seriesId={series.id}
            characters={[
              ...new Set(
                (world?.view.entries ?? [])
                  .filter((e) => e.template === 'person')
                  .map((e) => e.name),
              ),
            ].sort()}
            onClose={() => setCastOpen(false)}
          />
        )}
        {/* The editor stays loaded behind Settings, keeping undo history and scroll position. */}
        <div className="page-area-inner" hidden={settingsOpen}>
          {manuscriptOpen && view ? (
            <ManuscriptView
              series={series}
              volume={volume}
              chapterIds={manuscriptIds}
              headings={headings}
              author={settings.export.author}
              onClose={() => setManuscriptOpen(false)}
            />
          ) : selectedId && view && selectedId in view.chapters ? (
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
              onComments={setComments}
              onActiveComment={setActiveComment}
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
