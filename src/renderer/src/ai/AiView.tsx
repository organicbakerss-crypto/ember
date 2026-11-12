import { useEffect, useRef, useState } from 'react'
import type { AiJobInfo, ConversationSummary } from '@shared/ipc'
import type { PaneRoute } from '@shared/panes'
import type { AiCharacterFile, ConversationFile, ConversationMessage } from '@shared/schema'
import { newId } from '@shared/ids'
import {
  DEFAULT_PERSONA_ID,
  GUESTS,
  PERSONAS,
  REGULARS,
  guestNotice,
  isGuest,
  persona,
} from '@shared/ai/personas'
import { useOverlays } from '../components/overlays'
import { RoundtableView } from './RoundtableView'
import { QuestionFlow, QuestionRecord, type QuestionProgress } from './QuestionFlow'
import { ANSWERS_INSTRUCTION_RE, answersMessage, findQuestions } from '@shared/ai/questions'
import { loadLocal, saveLocal } from '../storage'
import { api, describeError, useIpcEvent } from '../api'
import { formatWhen } from '../components/TrashPage'
import { useSettings } from '../useTheme'
import { parse } from './markdown'
import { Blocks } from './FormattedAnswer'
import { docToMarkdown, editedDoc, type DocNode } from '@shared/ai/chapterEdit'
import { flushAll } from '../saving'
import { CompareDialog, type EditResult } from './CompareDialog'
import { worldUpdateNote } from './worldUpdate'
import {
  editRequest,
  fetchScope,
  localEditor,
  promptRequest,
  takePrompt,
  useLocalScope,
} from './scope'

type Mode = 'chat' | 'brainstorm' | 'ask'
type Message = Pick<ConversationMessage, 'role' | 'content' | 'at' | 'read'> & {
  /** A second opinion: the character who wrote it. */
  by?: string
  /** How far the writer got through the questions in this answer. */
  qa?: QuestionProgress
}
interface Thread {
  /** Set once the conversation has been saved (or a file attached). */
  id: string | null
  createdAt: string | null
  /** Conversations never share character identities. */
  characterId: string
  messages: Message[]
  /** Files attached (their text stays on the computer they were attached on). */
  attachments?: Attached[]
}

interface Attached {
  id: string
  name: string
  words: number
}

/** A conversation's attachment notes, as saved (loosely: unknown shapes are skipped). */
const attachedOf = (c: { [key: string]: unknown }): Attached[] =>
  Array.isArray(c['attachments'])
    ? (c['attachments'] as unknown[]).filter(
        (a): a is Attached =>
          !!a && typeof (a as Attached).id === 'string' && typeof (a as Attached).name === 'string',
      )
    : []

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'chat', label: 'Chat', hint: 'Talk about the story or your writing.' },
  { mode: 'brainstorm', label: 'Brainstorm', hint: 'Names, plot turns, what-ifs.' },
  { mode: 'ask', label: 'Ask the story', hint: 'Answers from your chapter and world.' },
]
const MODE_LABEL: Record<Mode, string> = { chat: 'Chat', brainstorm: 'Brainstorm', ask: 'Ask' }

const STARTERS: Record<Mode, string[]> = {
  chat: ['Is this scene working?', 'What is this passage doing for the story?'],
  brainstorm: ['What could happen next?', 'Give me names for a new character', 'What if…'],
  ask: ['Who is in this scene?', 'What do we know about this place?'],
}

/** How many earlier messages go with each new one (the model's memory of the conversation). */
const CONTEXT_MESSAGES = 20
/** Within this many pixels of the bottom, new text keeps the view at the bottom. */
const STICK_PX = 48

const words = (s: string) => s.split(/\s+/).filter(Boolean).length
/** How much the AI reads: what's selected or on screen, the whole chapter, or the whole story. */
type Reach = 'here' | 'chapter' | 'story' | 'full'

/** One-click prompts above the message box (they read what the "Reads" choice says). */
const QUICK: { label: string; mode: Mode; text: string }[] = [
  {
    label: 'Beta read',
    mode: 'chat',
    text: 'Read this as a beta reader: what works, what’s confusing, and where it drags. For each problem, give a specific fix.',
  },
  {
    label: 'Pacing',
    mode: 'chat',
    text: 'Check the pacing of this: where it rushes, where it drags, and what to change.',
  },
  {
    label: 'What happens next?',
    mode: 'brainstorm',
    text: 'What could happen next? Give several distinct options that fit what has happened so far.',
  },
  {
    label: 'Ask me questions',
    mode: 'brainstorm',
    text: 'Ask me questions to help me work this out: plan them first, as many as you need, with ready answers only where they help.',
  },
  {
    label: 'Names that fit',
    mode: 'brainstorm',
    text: 'Suggest names that fit this world for a new character, place or group (say which each is for), in the style of the names already in it.',
  },
]
/** An id for one request to the AI. */
const newRequestId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`
/** A conversation to open as soon as the AI panel shows (saved from the Roundtable). */
const pendingOpen: { id: string | null } = { id: null }

/** The other character who wrote a second opinion, if this message is one. */
const by = (m: Message): string | null => (typeof m.by === 'string' ? m.by : null)

/** What a message shows: the answers to questions without the instruction that went with them. */
const shown = (m: Message) =>
  m.role === 'user' ? m.content.replace(ANSWERS_INSTRUCTION_RE, '').trimEnd() : m.content

/** Messages as the model reads them: second opinions are marked as someone else's. */
const forModel = (msgs: Message[], nameOf: (id: string) => string) =>
  msgs.map((m) => ({
    role: m.role,
    content: by(m) ? `(A second opinion from ${nameOf(by(m)!)}:)\n${m.content}` : m.content,
  }))

const empty = (characterId = DEFAULT_PERSONA_ID): Thread => ({
  id: null,
  createdAt: null,
  characterId,
  messages: [],
})

/* ---------- formatted answers ---------- */

/**
 * The AI beside the page (or in a window of its own): chat, brainstorm or
 * ask the story, with room to read. It reads only what the chip says (the
 * selection, what's on screen, or the whole chapter when asked) and never
 * changes the chapter. Conversations are saved with the story (and sync with
 * it). Highlight part of an answer to reply to just that.
 */
export function AiView(props: {
  seriesId: string
  volumeId: string
  onRoute?: (route: PaneRoute) => void
  /** Opens the story's world at its inbox (after it was updated). */
  onOpenInbox?: (worldId: string) => void
  /** Controlled by Home when the Roundtable takes over the full AI workspace. */
  roundtableActive?: boolean
  onRoundtableChange?: (active: boolean) => void
}) {
  const { seriesId } = props
  const { settings, update } = useSettings()
  const provider = settings.ai.provider
  const [mode, setMode] = useState<Mode>('chat')
  const { choose, openMenu } = useOverlays()
  const [localRoundtableOpen, setLocalRoundtableOpen] = useState(false)
  const roundtableOpen = props.onRoundtableChange ? !!props.roundtableActive : localRoundtableOpen
  const setRoundtableOpen = props.onRoundtableChange ?? setLocalRoundtableOpen
  const [threads, setThreads] = useState<Record<Mode, Thread>>({
    chat: empty(),
    brainstorm: empty(),
    ask: empty(),
  })
  const [draft, setDraft] = useState('')
  const [quote, setQuote] = useState<string | null>(null)
  /** How much the AI reads: what's selected or on screen, the whole chapter, or the whole story. */
  const [reach, setReach] = useState<Reach>('here')
  /** Attachments of the open conversation that were attached on another computer. */
  const [missing, setMissing] = useState<Set<string>>(() => new Set())
  /** What a long job is doing now ("Summarising chapters…"). */
  const [progress, setProgress] = useState('')
  /** Reading a chapter for the world: the job, and what it found. */
  const [worldJob, setWorldJob] = useState<{ id: string; title: string } | null>(null)
  const [worldNote, setWorldNote] = useState<string | null>(null)
  /** After an edit is kept: offer to update the world from that chapter. */
  const [offer, setOffer] = useState<{ volumeId: string; chapterId: string; title: string } | null>(
    null,
  )
  const [worldId, setWorldId] = useState<string | null>(null)
  // The writer's own story characters (World → a person → AI character); null until loaded.
  const [cast, setCast] = useState<AiCharacterFile[] | null>(null)
  const [worldChecked, setWorldChecked] = useState(false)
  /**
   * Who an id names: a story character (`chr_…`) or a built-in personality.
   * A story character that no longer exists falls back to the default.
   */
  const who = (id: string | null | undefined): { id: string; name: string } => {
    if (id?.startsWith('chr_')) {
      const c = cast?.find((x) => x.id === id)
      if (c) return { id: c.id, name: c.name }
      // Not loaded yet: keep it (a story without a world has none).
      if (cast === null && (!worldChecked || worldId)) return { id, name: 'Your character' }
    }
    return persona(id)
  }
  const nameOf = (id: string) => who(id).name
  const [busy, setBusy] = useState<{ id: string; mode: Mode; edit?: boolean } | null>(null)
  /** Edit chapter: the AI may change the open chapter, as asked. */
  const [editMode, setEditMode] = useState(false)
  const [editWords, setEditWords] = useState(0)
  const [compare, setCompare] = useState<{
    result: EditResult
    chapterTitle: string
    volumeId: string
    chapterId: string
    finish: (summary: string) => void
  } | null>(null)
  const [handledRequest, setHandledRequest] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [past, setPast] = useState<ConversationSummary[]>([])
  const [listOpen, setListOpen] = useState(false)
  const [copied, setCopied] = useState<number | null>(null)
  const [replyAt, setReplyAt] = useState<{ x: number; y: number; text: string } | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  // The answer as it streams in (to keep what came if it's stopped).
  const partial = useRef('')
  /** Requests this pane is waiting on itself (the rest it picks up from the background). */
  const awaiting = useRef(new Set<string>())
  /** Requests whose answer already came back here (a late job event mustn't redo them). */
  const answered = useRef(new Set<string>())
  const mounted = useRef(false)
  const local = useLocalScope(seriesId)
  // "Edit with AI" from the ⋯ menu: tick Edit chapter and fill in the request.
  const asked = editRequest(seriesId)
  if (asked && asked.id !== handledRequest) {
    setHandledRequest(asked.id)
    setEditMode(true)
    setMode('chat')
    setDraft(asked.draft)
  }
  const thread = threads[mode]
  const messages = thread.messages

  // Settings can change from another window. Never reuse messages across personalities.
  // Hold any active request until it finishes; its identity was captured on submission.
  // (Adjusted while rendering, not in an effect.)
  const selectedCharacter = who(settings.ai.characterId).id
  if (
    !busy &&
    Object.values(threads).some(
      (t) =>
        t.characterId !== selectedCharacter && (t.id || t.messages.length || t.attachments?.length),
    )
  ) {
    setThreads({
      chat: empty(selectedCharacter),
      brainstorm: empty(selectedCharacter),
      ask: empty(selectedCharacter),
    })
  }

  const { onRoute, volumeId } = props
  useEffect(() => {
    onRoute?.({ kind: 'ai', seriesId, volumeId })
  }, [onRoute, seriesId, volumeId])

  // The story's world, if it has one (Update the world needs it).
  const loadWorld = () => {
    api.invoke('library:snapshot').then(
      (snap) => {
        setWorldId(snap.series.find((s) => s.id === seriesId)?.worldId ?? null)
        setWorldChecked(true)
      },
      () => {},
    )
  }
  useEffect(loadWorld, [seriesId])
  const loadCast = () => {
    if (!worldId) return
    api.invoke('character:list', { worldId }).then(setCast, () => setCast([]))
  }
  useEffect(loadCast, [worldId])
  useIpcEvent('library:changed', (c) => {
    if (c.kind === 'world' && c.worldId === worldId) loadCast()
  })
  useIpcEvent('library:changed', (c) => {
    if (c.kind === 'library' || (c.kind === 'series' && c.seriesId === seriesId)) loadWorld()
  })
  useIpcEvent('ai:progress', ({ requestId, text }) => {
    if (requestId === busy?.id || requestId === worldJob?.id) setProgress(text)
  })

  const refreshPast = () => {
    api.invoke('ai:conversations', { seriesId }).then(
      (all) => setPast(all.filter((c) => !c.roundtable)),
      () => {},
    )
  }
  useEffect(refreshPast, [seriesId])

  // Stay at the bottom while answers come in, unless the writer scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    setReplyAt(null)
  }

  useIpcEvent('ai:token', ({ requestId, text }) => {
    if (requestId !== busy?.id) return
    const into = busy.mode
    partial.current += text
    if (busy.edit) {
      setEditWords(words(partial.current))
      return
    }
    setThreads((t) => {
      const msgs = [...t[into].messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant')
        msgs[msgs.length - 1] = { ...last, content: last.content + text }
      return { ...t, [into]: { ...t[into], messages: msgs } }
    })
  })

  const scopeKind =
    reach === 'story' || reach === 'full'
      ? reach
      : reach === 'chapter'
        ? 'chapter'
        : local?.selection
          ? 'selection'
          : 'screen'
  const chip = editMode
    ? local?.chapterId
      ? `Editing: all of “${local.chapterTitle || 'Untitled'}”`
      : 'Editing: open a chapter beside the AI'
    : scopeKind === 'story'
      ? 'Reading: the whole story (a summary of each chapter)'
      : scopeKind === 'full'
        ? 'Reading: the whole story, word for word (in parts if it’s long)'
        : !local
          ? 'Reading: the chapter open in the writing view'
          : !local.chapterId
            ? 'Reading: nothing (no chapter open)'
            : scopeKind === 'chapter'
              ? `Reading: all of “${local.chapterTitle || 'Untitled'}”`
              : scopeKind === 'selection'
                ? `Reading: your selection, ~${words(local.selection!)} words`
                : `Reading: what’s on screen in “${local.chapterTitle || 'Untitled'}”`

  const open = async (id: string) => {
    try {
      const c = await api.invoke('ai:conversation', { seriesId, conversationId: id })
      setMode(c.mode)
      // Opening a saved chat restores its original character, not the current global choice.
      update(({ ai }) => ({ ai: { ...ai, characterId: who(c.characterId).id } }))
      setThreads({
        chat: empty(who(c.characterId).id),
        brainstorm: empty(who(c.characterId).id),
        ask: empty(who(c.characterId).id),
        [c.mode]: {
          id: c.id,
          createdAt: c.createdAt,
          characterId: who(c.characterId).id,
          messages: c.messages,
          attachments: attachedOf(c),
        },
      })
      // Attachments are kept on the computer they were attached on.
      const ids = attachedOf(c).map((a) => a.id)
      if (ids.length) {
        void api
          .invoke('ai:attachmentsHere', { conversationId: c.id, ids })
          .then((here) => setMissing(new Set(ids.filter((x) => !here.includes(x)))))
          .catch(() => {})
      } else setMissing(new Set())
      stick.current = true
      setListOpen(false)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  useEffect(() => {
    if (roundtableOpen || !pendingOpen.id) return
    const timer = setTimeout(() => {
      const id = pendingOpen.id
      pendingOpen.id = null
      if (id) void open(id)
    }, 0)
    return () => clearTimeout(timer)
    // Only when the Roundtable closes (or this panel first shows).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundtableOpen])

  const remove = async (id: string) => {
    await api
      .invoke('ai:deleteConversation', { seriesId, conversationId: id })
      .catch((err) => setError(describeError(err).message))
    setPast((p) => p.filter((c) => c.id !== id))
    setThreads((t) => {
      const next = { ...t }
      for (const m of Object.keys(next) as Mode[])
        if (next[m].id === id) next[m] = empty(settings.ai.characterId)
      return next
    })
  }

  /** A conversation as a file (a new one gets its id here). */
  const asFile = (into: Mode, current: Thread, msgs: Message[]): ConversationFile => {
    const now = new Date().toISOString()
    const first = msgs.find((m) => m.role === 'user')?.content ?? 'Conversation'
    return {
      formatVersion: 1,
      id: current.id ?? newId('conversation'),
      mode: into,
      characterId: current.id ? current.characterId : settings.ai.characterId,
      title:
        first.replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Conversation',
      createdAt: current.createdAt ?? now,
      updatedAt: now,
      messages: msgs,
      attachments: current.attachments ?? [],
    }
  }
  const threadOf = (c: ConversationFile): Thread => ({
    id: c.id,
    createdAt: c.createdAt,
    characterId: who(c.characterId).id,
    messages: c.messages,
    attachments: attachedOf(c),
  })

  /** Attaches files to the current conversation (their text stays on this computer). */
  const attach = async (files: FileList | null) => {
    if (!files?.length) return
    const current = threads[mode]
    const conversationId = current.id ?? newId('conversation')
    const createdAt = current.createdAt ?? new Date().toISOString()
    const added: Attached[] = []
    for (const file of Array.from(files)) {
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        added.push(await api.invoke('ai:attach', { conversationId, name: file.name, data }))
      } catch (err) {
        setError(describeError(err).message)
      }
    }
    if (!added.length) return
    setThreads((t) => ({
      ...t,
      [mode]: {
        ...t[mode],
        id: conversationId,
        createdAt,
        characterId: current.id ? current.characterId : settings.ai.characterId,
        attachments: [...(t[mode].attachments ?? []), ...added],
      },
    }))
  }
  const detach = (id: string) =>
    setThreads((t) => ({
      ...t,
      [mode]: { ...t[mode], attachments: (t[mode].attachments ?? []).filter((a) => a.id !== id) },
    }))

  /** Saves a conversation with the story (after an edit is reviewed). */
  const save = (into: Mode, current: Thread, msgs: Message[]) => {
    const conversation = asFile(into, current, msgs)
    setThreads((t) => ({ ...t, [into]: threadOf(conversation) }))
    void api
      .invoke('ai:saveConversation', { seriesId, conversation })
      .then(refreshPast)
      .catch((err) => setError(`Couldn’t save the conversation: ${describeError(err).message}`))
  }

  /** Edit chapter: the AI edits the open chapter (in the background); then it goes in, side by side. */
  const runEdit = async (instruction: string) => {
    const into = mode
    const current = thread
    const editor = localEditor(seriesId)
    if (!editor?.chapterId) {
      setError(
        'Open a chapter beside the AI to edit it (Edit chapter works when the AI is beside the page).',
      )
      return
    }
    const oldDoc = editor.doc()
    if (!oldDoc) {
      setError('This chapter is being edited in another window or pane. Edit it there.')
      return
    }
    const { volumeId, chapterId, chapterTitle } = editor
    const md = docToMarkdown(oldDoc as { content?: DocNode[] })
    const requestId = newRequestId()
    const now = new Date().toISOString()
    const read = `Edit chapter: “${chapterTitle || 'Untitled'}”, ~${words(md)} words`
    const conversation = asFile(into, current, [
      ...current.messages,
      { role: 'user', content: instruction, at: now, read },
    ])
    setThreads((t) => ({ ...t, [into]: threadOf(conversation) }))
    setDraft('')
    setError(null)
    setBusy({ id: requestId, mode: into, edit: true })
    setEditWords(0)
    stick.current = true
    partial.current = ''
    awaiting.current.add(requestId)
    try {
      // The version before goes into History first.
      await flushAll()
      await api.invoke('history:keep', { seriesId, volumeId, chapterId, reason: 'before-ai' })
      const answer = await api.invoke('ai:editChapter', {
        requestId,
        seriesId,
        volumeId,
        chapterId,
        conversation,
        instruction,
        chapterTitle,
        chapter: md,
        messages: current.messages
          .slice(-CONTEXT_MESSAGES)
          .map((m) => ({ role: m.role, content: m.content })),
      })
      // Closed meanwhile: the edit waits for the AI to be opened again.
      if (!mounted.current) return
      void api.invoke('ai:jobSeen', { id: requestId })
      applyEdit({
        text: answer.text,
        sent: md,
        volumeId,
        chapterId,
        chapterTitle,
        mode: into,
        conversation,
      })
    } catch (err) {
      if (!mounted.current) return
      void api.invoke('ai:jobSeen', { id: requestId })
      const e = describeError(err)
      if (e.code !== 'cancelled') setError(e.message)
    } finally {
      awaiting.current.delete(requestId)
      if (mounted.current) setBusy(null)
    }
  }

  /** An edit the AI made: into the chapter (if it's still as sent), then side by side. */
  const applyEdit = (job: {
    text: string
    sent: string
    volumeId: string
    chapterId: string
    chapterTitle: string
    mode: Mode
    conversation: ConversationFile
  }) => {
    const current = threadOf(job.conversation)
    const reply = (content: string) =>
      save(job.mode, current, [
        ...job.conversation.messages,
        { role: 'assistant', content, at: new Date().toISOString(), read: null },
      ])
    const name = job.chapterTitle || 'Untitled'
    const editor = localEditor(seriesId)
    const now = editor?.chapterId === job.chapterId ? editor.doc() : null
    if (!editor || !now) {
      reply(
        `The edit of “${name}” was ready, but the chapter wasn’t open beside the AI, so nothing was changed. Open it and ask again.`,
      )
      return
    }
    if (docToMarkdown(now as { content?: DocNode[] }) !== job.sent) {
      reply('The chapter changed while the AI was working, so nothing was changed. Ask again.')
      return
    }
    const result = editedDoc(now as { content?: DocNode[] }, job.text)
    if (!result.pairs.some((p) => !p.same)) {
      reply(`No changes needed in “${name}”.`)
      return
    }
    if (!editor.replace(result.doc)) {
      reply('The chapter couldn’t be edited here (another window has it).')
      return
    }
    setCompare({
      result,
      chapterTitle: job.chapterTitle,
      volumeId: job.volumeId,
      chapterId: job.chapterId,
      finish: reply,
    })
  }

  const finishCompare = async (outcome: { kept: boolean; undone: number; changes: number }) => {
    const c = compare
    setCompare(null)
    if (!c) return
    const name = `“${c.chapterTitle || 'Untitled'}”`
    if (outcome.kept && outcome.undone < outcome.changes) {
      await flushAll()
      await api
        .invoke('history:keep', {
          seriesId,
          volumeId: c.volumeId,
          chapterId: c.chapterId,
          reason: 'after-ai',
        })
        .catch(() => {})
      const kept = outcome.changes - outcome.undone
      c.finish(
        `Edited ${name}: kept ${kept} ${kept === 1 ? 'change' : 'changes'}${outcome.undone ? `, undid ${outcome.undone}` : ''}. The versions before and after are in History.`,
      )
      if (worldId) setOffer({ volumeId: c.volumeId, chapterId: c.chapterId, title: c.chapterTitle })
    } else {
      c.finish(`Undid the edit to ${name}: your text is back. The version before is in History.`)
    }
  }

  /** Reads a chapter for the world (in the background): what it finds goes to the world's inbox. */
  const updateWorld = async (target?: { volumeId: string; chapterId: string; title: string }) => {
    if (worldJob || busy) return
    let at = target
    if (!at) {
      const scope = await fetchScope(seriesId)
      if (!scope?.chapterId) {
        setError('Open a chapter in the writing view to update the world from it.')
        return
      }
      at = { volumeId: scope.volumeId, chapterId: scope.chapterId, title: scope.chapterTitle }
    }
    const id = newRequestId()
    setOffer(null)
    setError(null)
    setWorldNote(null)
    setProgress('')
    setWorldJob({ id, title: at.title })
    awaiting.current.add(id)
    try {
      const r = await api.invoke('ai:updateWorld', {
        requestId: id,
        seriesId,
        volumeId: at.volumeId,
        chapterId: at.chapterId,
      })
      if (!mounted.current) return
      void api.invoke('ai:jobSeen', { id })
      setWorldNote(worldUpdateNote(at.title, r))
    } catch (err) {
      if (!mounted.current) return
      void api.invoke('ai:jobSeen', { id })
      const e = describeError(err)
      if (e.code !== 'cancelled') setError(e.message)
    } finally {
      awaiting.current.delete(id)
      if (mounted.current) {
        setWorldJob(null)
        setProgress('')
      }
    }
  }

  /** Sends a message (a one-click prompt may pick the mode and how much is read). */
  const send = async (text: string, as?: { mode?: Mode; reach?: Reach; messages?: Message[] }) => {
    const question = text.trim()
    if (!question || busy || worldJob) return
    if (editMode && !as) {
      await runEdit(question)
      return
    }
    const into = as?.mode ?? mode
    const reads = as?.reach ?? reach
    if (into !== mode) setMode(into)
    if (as?.reach && as.reach !== reach) setReach(as.reach)
    const current = as?.messages ? { ...threads[into], messages: as.messages } : threads[into]
    const requestId = newRequestId()
    const scope = await fetchScope(seriesId)
    const kind =
      reads === 'story' || reads === 'full'
        ? reads
        : reads === 'chapter'
          ? 'chapter'
          : scope?.selection
            ? 'selection'
            : 'screen'
    const scopeText =
      kind === 'selection' ? scope!.selection! : kind === 'screen' ? (scope?.screen ?? '') : ''
    const where = scope?.chapterTitle ? ` in “${scope.chapterTitle}”` : ''
    const read =
      kind === 'story'
        ? 'the whole story (chapter summaries)'
        : kind === 'full'
          ? 'the whole story, word for word'
          : !scope?.chapterId
            ? null
            : kind === 'chapter'
              ? `the whole chapter${where}`
              : `${kind === 'selection' ? 'your selection' : 'what was on screen'}${where}, ~${words(scopeText)} words`
    const content = quote
      ? `${quote
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}\n\n${question}`
      : question
    const now = new Date().toISOString()
    const history: Message[] = [...current.messages, { role: 'user', content, at: now, read }]
    const conversation = asFile(into, current, history)
    setThreads((t) => ({
      ...t,
      [into]: {
        ...threadOf(conversation),
        messages: [...history, { role: 'assistant', content: '', at: now, read: null }],
      },
    }))
    setDraft('')
    setQuote(null)
    setError(null)
    setBusy({ id: requestId, mode: into })
    stick.current = true
    partial.current = ''
    awaiting.current.add(requestId)
    try {
      // It runs in the background: closing the AI doesn't stop it, and the answer is saved there.
      const answer = await api.invoke('ai:ask', {
        requestId,
        seriesId,
        conversation,
        mode: into,
        messages: forModel(history.slice(-CONTEXT_MESSAGES), nameOf),
        cutoffChapterId: scope?.chapterId ?? null,
        attachmentIds: (current.attachments ?? []).map((a) => a.id),
        scope:
          kind === 'story' || kind === 'full'
            ? { kind, seriesId, volumeId: null, chapterId: null, text: '' }
            : scope?.chapterId
              ? {
                  kind,
                  seriesId,
                  volumeId: scope.volumeId,
                  chapterId: scope.chapterId,
                  text: scopeText,
                }
              : null,
      })
      if (!mounted.current) return
      void api.invoke('ai:jobSeen', { id: requestId })
      answered.current.add(requestId)
      finishAnswer(into, conversation, answer.text, null, answer.lookedAt)
    } catch (err) {
      if (!mounted.current) return
      void api.invoke('ai:jobSeen', { id: requestId })
      finishAnswer(into, conversation, partial.current, err)
    } finally {
      awaiting.current.delete(requestId)
      if (mounted.current) {
        setBusy(null)
        setProgress('')
      }
    }
  }

  /** An answer finished (or stopped part-way, keeping what came); it's already saved. */
  const finishAnswer = (
    into: Mode,
    conversation: ConversationFile,
    text: string,
    err: unknown,
    lookedAt: string[] = [],
  ) => {
    if (err) {
      const e = describeError(err)
      if (e.code !== 'cancelled') setError(e.message)
    }
    const msgs: Message[] = text
      ? [
          ...conversation.messages,
          {
            role: 'assistant',
            content: text,
            at: new Date().toISOString(),
            read: lookedAt.length ? lookedAt.join(', ') : null,
          },
        ]
      : conversation.messages
    setThreads((t) => ({ ...t, [into]: { ...threadOf(conversation), messages: msgs } }))
    refreshPast()
  }

  /** Work that was running (or finished) while this pane was closed: carry on showing it. */
  const resume = (job: AiJobInfo) => {
    if (awaiting.current.has(job.id) || answered.current.has(job.id)) return
    const conv = job.conversation
    const into = (conv?.mode ?? 'chat') as Mode
    if (job.kind === 'world') {
      if (job.state === 'running') {
        setWorldJob({ id: job.id, title: job.chapterTitle })
        setProgress(job.progress)
        return
      }
      void api.invoke('ai:jobSeen', { id: job.id })
      setWorldJob((w) => (w?.id === job.id ? null : w))
      setProgress('')
      if (job.result) setWorldNote(worldUpdateNote(job.chapterTitle, job.result))
      else if (job.state === 'failed') setError(job.error)
      return
    }
    if (!conv) return
    if (job.state === 'running') {
      setMode(into)
      partial.current = job.text
      if (job.kind === 'edit') {
        setEditMode(true)
        setEditWords(words(job.text))
        setThreads((t) => ({ ...t, [into]: threadOf(conv) }))
      } else {
        const now = new Date().toISOString()
        setThreads((t) => ({
          ...t,
          [into]: {
            ...threadOf(conv),
            messages: [
              ...conv.messages,
              { role: 'assistant', content: job.text, at: now, read: null },
            ],
          },
        }))
      }
      setBusy({ id: job.id, mode: into, edit: job.kind === 'edit' })
      return
    }
    // Finished while closed.
    void api.invoke('ai:jobSeen', { id: job.id })
    setBusy((b) => (b?.id === job.id ? null : b))
    setMode(into)
    if (job.kind === 'ask') {
      finishAnswer(into, conv, job.text, job.state === 'failed' ? new Error(job.error ?? '') : null)
    } else if (job.state === 'done' && job.volumeId && job.chapterId && job.sent !== null) {
      applyEdit({
        text: job.text,
        sent: job.sent,
        volumeId: job.volumeId,
        chapterId: job.chapterId,
        chapterTitle: job.chapterTitle,
        mode: into,
        conversation: conv,
      })
    } else {
      setThreads((t) => ({ ...t, [into]: threadOf(conv) }))
      if (job.state === 'failed') setError(job.error)
    }
  }
  useEffect(() => {
    mounted.current = true
    api.invoke('ai:jobs', { seriesId }).then(
      (jobs) => {
        if (mounted.current) for (const j of jobs) resume(j)
      },
      () => {},
    )
    return () => {
      mounted.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesId])
  // A prompt asked for from the ⋯ menu (a blurb, a synopsis): sent once, here.
  const promptId = promptRequest(seriesId)?.id ?? 0
  useEffect(() => {
    const p = takePrompt(seriesId)
    if (p) queueMicrotask(() => void send(p.text, { mode: 'chat', reach: p.reach }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptId, seriesId])
  useIpcEvent('ai:job', (job) => {
    if (job.seriesId !== seriesId) return
    // Work started elsewhere (the ⋯ menu), or finished while this pane only watched it.
    if (job.kind === 'world' || (job.state !== 'running' && job.id === busy?.id)) resume(job)
  })

  /** Highlighting part of an answer offers to reply to just that. */
  const onMouseUp = () => {
    const sel = window.getSelection()
    const text = sel?.toString().trim() ?? ''
    if (!sel || !text || sel.rangeCount === 0) {
      setReplyAt(null)
      return
    }
    const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement
    if (!node?.closest('.ai-message.assistant') || !root.current) {
      setReplyAt(null)
      return
    }
    const r = sel.getRangeAt(0).getBoundingClientRect()
    const box = root.current.getBoundingClientRect()
    setReplyAt({ x: r.left - box.left + r.width / 2, y: r.top - box.top, text })
  }

  /** Switches character. A guest star first says what you trade for their lens (once each). */
  const pickCharacter = async (characterId: string) => {
    if (characterId === who(settings.ai.characterId).id) return
    if (characterId.startsWith('chr_')) {
      setThreads({
        chat: empty(characterId),
        brainstorm: empty(characterId),
        ask: empty(characterId),
      })
      setMissing(new Set())
      setQuote(null)
      setListOpen(false)
      update(({ ai }) => ({ ai: { ...ai, characterId } }))
      return
    }
    const next = persona(characterId)
    if (isGuest(next)) {
      const seen = (loadLocal('ai.guestsSeen') ?? '').split(',').filter(Boolean)
      if (!seen.includes(next.id)) {
        const ok = await choose(
          `${next.name} sees your story through their own lens`,
          [{ value: 'use', label: `Use ${next.name}`, primary: true }],
          `${guestNotice(next)} This is an AI portrayal, not the real person.`,
        )
        if (ok !== 'use') return
        saveLocal('ai.guestsSeen', [...seen, next.id].join(','))
      }
    }
    // Never feed one character's conversation into another's prompt.
    setThreads({ chat: empty(next.id), brainstorm: empty(next.id), ask: empty(next.id) })
    setMissing(new Set())
    setQuote(null)
    setListOpen(false)
    update(({ ai }) => ({
      ai: {
        ...ai,
        characterId: next.id,
        lastPartnerId: next.kind === 'regular' ? next.id : ai.lastPartnerId,
      },
    }))
  }

  /** Asks another character the question that led to answer `i`; their reply goes under it. */
  const secondOpinion = async (i: number, characterId: string) => {
    const into = mode
    const current = threads[into]
    const upTo = current.messages.slice(0, i)
    if (!upTo.some((m) => m.role === 'user')) return
    const scope = await fetchScope(seriesId)
    const kind =
      reach === 'story' || reach === 'full'
        ? reach
        : reach === 'chapter'
          ? 'chapter'
          : scope?.selection
            ? 'selection'
            : 'screen'
    const text =
      kind === 'selection' ? scope!.selection! : kind === 'screen' ? (scope?.screen ?? '') : ''
    const requestId = newRequestId()
    setBusy({ id: requestId, mode: into })
    setProgress(`Asking ${nameOf(characterId)}…`)
    setError(null)
    try {
      const answer = await api.invoke('ai:secondOpinion', {
        requestId,
        seriesId,
        characterId,
        mode: into,
        messages: forModel(upTo.slice(-CONTEXT_MESSAGES), nameOf),
        cutoffChapterId: scope?.chapterId ?? null,
        conversationId: current.id,
        attachmentIds: (current.attachments ?? []).map((a) => a.id),
        scope:
          kind === 'story' || kind === 'full'
            ? { kind, seriesId, volumeId: null, chapterId: null, text: '' }
            : scope?.chapterId
              ? { kind, seriesId, volumeId: scope.volumeId, chapterId: scope.chapterId, text }
              : null,
      })
      if (!mounted.current) return
      const reply: Message = {
        role: 'assistant',
        content: answer.text,
        at: new Date().toISOString(),
        read: null,
        by: characterId,
      }
      // Under the answer it's a second opinion on (after any earlier second opinions).
      let at = i + 1
      while (at < current.messages.length && by(current.messages[at]!)) at++
      const msgs = [...current.messages.slice(0, at), reply, ...current.messages.slice(at)]
      save(into, current, msgs)
    } catch (err) {
      if (!mounted.current) return
      const e = describeError(err)
      if (e.code !== 'cancelled') setError(e.message)
    } finally {
      if (mounted.current) {
        setBusy(null)
        setProgress('')
      }
    }
  }

  /** The questions waiting for answers (the latest unfinished set), shown in place of the message box. */
  const lastIndex = messages.length - 1
  const asking = (() => {
    if (busy && busy.mode === mode) return null
    for (let j = lastIndex; j >= 0; j--) {
      const m = messages[j]!
      if (m.role !== 'assistant') continue
      const found = findQuestions(m.content)
      if (!found) return null
      const progress = m.qa ?? { answers: [], done: false }
      if (progress.done || progress.answers.length >= found.set.questions.length) return null
      return { index: j, set: found.set, progress }
    }
    return null
  })()

  /** An answer to the next question in message `i` (null: skipped); the last one sends them all. */
  const answerQuestion = (i: number, answer: string | null) => {
    const current = threads[mode]
    const m = current.messages[i]
    const found = m && findQuestions(m.content)
    if (!m || !found) return
    const answers = [...(m.qa?.answers ?? []), answer]
    const finished = answers.length >= found.set.questions.length
    const msgs = current.messages.map((x, j) =>
      j === i ? { ...x, qa: { answers, done: finished } } : x,
    )
    if (finished) {
      void send(answersMessage(found.set, answers, false), { mode, messages: msgs })
    } else save(mode, current, msgs)
  }
  /** “That's enough”: stop and send what's been answered. */
  const stopQuestions = (i: number) => {
    const current = threads[mode]
    const m = current.messages[i]
    const found = m && findQuestions(m.content)
    if (!m || !found) return
    const answers = m.qa?.answers ?? []
    const msgs = current.messages.map((x, j) =>
      j === i ? { ...x, qa: { answers, done: true } } : x,
    )
    void send(answersMessage(found.set, answers, true), { mode, messages: msgs })
  }

  const replyTo = (text: string) => {
    setQuote(text)
    setReplyAt(null)
    window.getSelection()?.removeAllRanges()
    input.current?.focus()
  }

  const copy = async (i: number, text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {})
    setCopied(i)
    setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500)
  }

  const history = (
    <aside className={`ai-history ${listOpen ? 'open' : ''}`} aria-label="Past conversations">
      <div className="ai-history-head">
        <strong className="small">Conversations</strong>
        <button
          className="link small"
          onClick={() => {
            setThreads((t) => ({ ...t, [mode]: empty(settings.ai.characterId) }))
            setListOpen(false)
          }}
        >
          + New
        </button>
      </div>
      {past.length === 0 && <p className="muted small">Your conversations are kept here.</p>}
      <ul>
        {past.map((c) => (
          <li key={c.id} className={threads[c.mode].id === c.id ? 'current' : ''}>
            <button className="ai-past-open" onClick={() => void open(c.id)}>
              <span className="ai-past-title">{c.title}</span>
              <span className="muted small">
                {MODE_LABEL[c.mode]} · {formatWhen(c.updatedAt)}
              </span>
            </button>
            <button
              className="icon"
              aria-label={`Delete “${c.title}”`}
              title="Delete this conversation"
              onClick={() => void remove(c.id)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )

  if (roundtableOpen) {
    return (
      <div className="ai-view ai-roundtable-view">
        <RoundtableView
          seriesId={seriesId}
          onBack={() => setRoundtableOpen(false)}
          onOpenConversation={(id) => {
            // The Roundtable can run in its own full-width copy of this panel: the panel
            // that comes back when it closes opens the chat.
            pendingOpen.id = id
            setRoundtableOpen(false)
          }}
        />
      </div>
    )
  }

  return (
    <div className={`ai-view ${settings.lookAi === 'margins' ? 'ai-look-margins' : ''}`} ref={root}>
      {history}
      <section className="ai-main">
        <header className="ai-head">
          <button
            className="icon ai-history-toggle"
            aria-label="Conversations"
            aria-expanded={listOpen}
            title="Past conversations"
            onClick={() => setListOpen((o) => !o)}
          >
            ☰
          </button>
          <div className="segmented ai-modes" role="radiogroup" aria-label="AI mode">
            {MODES.map((m) => (
              <button
                key={m.mode}
                role="radio"
                aria-checked={mode === m.mode}
                className={mode === m.mode ? 'active' : ''}
                title={m.hint}
                onClick={() => setMode(m.mode)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <span className="status-spacer" />
          <select
            className="ai-character"
            aria-label="Current AI character"
            title={
              isGuest(persona(settings.ai.characterId))
                ? guestNotice(persona(settings.ai.characterId) as Parameters<typeof guestNotice>[0])
                : 'Who answers'
            }
            value={who(settings.ai.characterId).id}
            disabled={!!busy}
            onChange={(e) => void pickCharacter(e.target.value)}
          >
            <optgroup label="Brainstorming partners">
              {REGULARS.map((p) => (
                <option key={p.id} value={p.id} title={p.summary}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Guest stars (AI portrayals)">
              {GUESTS.map((p) => (
                <option key={p.id} value={p.id} title={p.knownFor}>
                  {p.name} ★
                </option>
              ))}
            </optgroup>
            {!!cast?.length && (
              <optgroup label="Your characters">
                {cast.map((c) => (
                  <option key={c.id} value={c.id} title="From your story">
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            className="icon ai-more"
            aria-label="More AI actions"
            title="More"
            onClick={(e) =>
              openMenu(e, [
                {
                  label: 'New conversation',
                  disabled: !messages.length || !!busy,
                  onSelect: () =>
                    setThreads((t) => ({ ...t, [mode]: empty(settings.ai.characterId) })),
                },
                {
                  label: 'Roundtable…',
                  disabled: !!busy || !!worldJob,
                  onSelect: () => setRoundtableOpen(true),
                },
                ...(worldId
                  ? [
                      {
                        label: 'Update the world from this chapter',
                        disabled: !!worldJob || !!busy,
                        onSelect: () => void updateWorld(),
                      },
                    ]
                  : []),
              ])
            }
          >
            ⋯
          </button>
        </header>

        <div className="ai-scroll" ref={scroller} onScroll={onScroll} onMouseUp={onMouseUp}>
          <div className="ai-column">
            {messages.length === 0 && (
              <div className="ai-empty muted">
                <p>{MODES.find((m) => m.mode === mode)!.hint}</p>
                <div className="ai-starters">
                  {STARTERS[mode].map((s) => (
                    <button key={s} className="link" onClick={() => setDraft(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`ai-message ${m.role} ${by(m) ? 'second' : ''}`}>
                {by(m) ? (
                  <div className="ai-by muted small">Second opinion from {nameOf(by(m)!)}</div>
                ) : (
                  settings.lookAi === 'margins' && (
                    <div className="ai-who">
                      {m.role === 'user' ? 'You' : nameOf(thread.characterId)}
                    </div>
                  )
                )}
                {m.content ? (
                  <div className="ai-text">
                    {(() => {
                      const streaming = !!busy && i === messages.length - 1
                      // While it's still arriving, the question list isn't shown as raw code.
                      const cut = streaming ? m.content.indexOf('```questions') : -1
                      if (cut >= 0) {
                        const before = m.content.slice(0, cut).trim()
                        return (
                          <>
                            {before && <Blocks blocks={parse(before)} />}
                            <p className="qa-writing muted small">Writing questions…</p>
                          </>
                        )
                      }
                      const found =
                        m.role === 'assistant' && !streaming ? findQuestions(m.content) : null
                      if (!found) return <Blocks blocks={parse(shown(m))} />
                      return (
                        <>
                          {found.before && <Blocks blocks={parse(found.before)} />}
                          <QuestionRecord set={found.set} progress={m.qa} />
                          {found.after && <Blocks blocks={parse(found.after)} />}
                        </>
                      )
                    })()}
                  </div>
                ) : (
                  <p className="muted">{(busy && i === messages.length - 1 && progress) || '…'}</p>
                )}
                {m.read && (
                  <div className="ai-read muted small">
                    {m.role === 'assistant' ? 'Looked at' : 'Read'} {m.read}
                  </div>
                )}
                {m.role === 'assistant' && m.content && !(busy && i === messages.length - 1) && (
                  <div className="ai-actions small">
                    <button className="link" onClick={() => void copy(i, m.content)}>
                      {copied === i ? 'Copied' : 'Copy'}
                    </button>
                    <button className="link" onClick={() => replyTo(m.content.slice(0, 400))}>
                      Reply to this
                    </button>
                    {!busy && messages.slice(0, i).some((x) => x.role === 'user') && (
                      <button
                        className="link"
                        title="Ask another character the same question"
                        onClick={(e) =>
                          openMenu(e, [
                            ...PERSONAS.filter((p) => p.id !== thread.characterId).map((p) => ({
                              label: `${p.name}${isGuest(p) ? ' (guest star)' : p.kind === 'specialist' ? ' (specialist)' : ''}`,
                              onSelect: () => void secondOpinion(i, p.id),
                            })),
                            ...(cast ?? [])
                              .filter((c) => c.id !== thread.characterId)
                              .map((c) => ({
                                label: `${c.name} (your character)`,
                                onSelect: () => void secondOpinion(i, c.id),
                              })),
                          ])
                        }
                      >
                        Second opinion
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {worldJob && (
              <div className="ai-message assistant ai-world-note">
                <p className="muted">
                  Updating the world from “{worldJob.title || 'Untitled'}”… {progress}
                </p>
              </div>
            )}
            {worldNote && !worldJob && (
              <div className="ai-message assistant ai-world-note">
                <p>{worldNote}</p>
                {worldId && props.onOpenInbox && (
                  <div className="ai-actions small">
                    <button className="link" onClick={() => props.onOpenInbox!(worldId)}>
                      Open the inbox
                    </button>
                  </div>
                )}
              </div>
            )}
            {offer && !worldJob && (
              <div className="ai-message assistant ai-world-note">
                <p>Update the world from “{offer.title || 'Untitled'}” too?</p>
                <div className="row">
                  <button onClick={() => void updateWorld(offer)}>Update the world</button>
                  <button className="link" onClick={() => setOffer(null)}>
                    Not now
                  </button>
                </div>
              </div>
            )}
            {busy?.edit && (
              <div className="ai-message assistant">
                <p className="muted">
                  Editing the chapter…{' '}
                  {editWords ? `${editWords.toLocaleString()} words written` : ''}
                </p>
              </div>
            )}
          </div>
        </div>
        {replyAt && (
          <button
            className="ai-reply-pop"
            style={{ left: replyAt.x, top: replyAt.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => replyTo(replyAt.text)}
          >
            Reply to this
          </button>
        )}

        {asking ? (
          <div className="ai-input ai-column ai-asking">
            <QuestionFlow
              set={asking.set}
              progress={asking.progress}
              disabled={!!busy || !!worldJob}
              onAnswer={(a) => answerQuestion(asking.index, a)}
              onStop={() => stopQuestions(asking.index)}
            />
          </div>
        ) : (
          <form
            className="ai-input ai-column"
            onSubmit={(e) => {
              e.preventDefault()
              void send(draft)
            }}
          >
            {error && <p className="error small">{error}</p>}
            {quote && (
              <div className="ai-quote small">
                <blockquote>{quote}</blockquote>
                <button
                  type="button"
                  className="icon"
                  aria-label="Don’t reply to this"
                  onClick={() => setQuote(null)}
                >
                  ✕
                </button>
              </div>
            )}
            {(threads[mode].attachments?.length ?? 0) > 0 && (
              <div className="ai-attachments small">
                {threads[mode].attachments!.map((a) => (
                  <span
                    key={a.id}
                    className={`ai-attachment ${missing.has(a.id) ? 'missing' : ''}`}
                    title={
                      missing.has(a.id)
                        ? 'Attached on another computer: the AI can’t read it here'
                        : `~${a.words.toLocaleString()} words, kept on this computer`
                    }
                  >
                    📎 {a.name}
                    <button
                      aria-label={`Remove ${a.name}`}
                      type="button"
                      onClick={() => detach(a.id)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              aria-label="Message to the AI"
              placeholder={
                editMode
                  ? 'What should change? e.g. “fix the spelling and grammar”, or “add the scene above where they reach the harbour”'
                  : quote
                    ? 'Reply to that part…'
                    : mode === 'ask'
                      ? 'Ask about your story…'
                      : 'Message…'
              }
              value={draft}
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(draft)
                }
              }}
            />
            <div className="row ai-controls small">
              {!editMode && (
                <button
                  type="button"
                  className="ai-prompts"
                  disabled={!!busy || !!worldJob}
                  title="One-click prompts"
                  onClick={(e) =>
                    openMenu(
                      e,
                      [
                        ...QUICK,
                        ...settings.ai.prompts.map((text) => ({
                          label: text.length > 40 ? `${text.slice(0, 38)}…` : text,
                          mode,
                          text,
                        })),
                      ].map((q) => ({
                        label: q.label,
                        onSelect: () => void send(q.text, { mode: q.mode }),
                      })),
                    )
                  }
                >
                  Prompts ▾
                </button>
              )}
              {editMode ? (
                <span className="muted ai-chip-text">{chip}</span>
              ) : (
                <select
                  className="ai-reads"
                  aria-label="What the AI reads"
                  title={chip}
                  value={reach}
                  onChange={(e) => setReach(e.target.value as typeof reach)}
                >
                  <option value="here">Reads: selection or screen</option>
                  <option value="chapter">Reads: whole chapter</option>
                  <option value="story">Reads: whole story (summaries)</option>
                  <option value="full">Reads: whole story, word for word</option>
                </select>
              )}
              {!editMode && (
                <label
                  className="icon ai-attach"
                  aria-label="Attach a file"
                  title="Attach a file (.txt, .md, .docx): the AI reads it with this conversation. The file stays on this computer."
                >
                  📎
                  <input
                    type="file"
                    multiple
                    hidden
                    accept=".txt,.md,.markdown,.docx,.html,.htm,.json,.csv"
                    onChange={(e) => {
                      void attach(e.target.files)
                      e.target.value = ''
                    }}
                  />
                </label>
              )}
              <label
                className="ai-edit-toggle"
                title={
                  local
                    ? 'Let the AI change the open chapter as you ask (you see every change after, and can undo it)'
                    : 'Works when the AI is beside the page'
                }
              >
                <input
                  type="checkbox"
                  checked={editMode}
                  disabled={!local}
                  onChange={(e) => setEditMode(e.target.checked)}
                />
                Edit chapter
              </label>
              <span className="status-spacer" />
              {busy || worldJob ? (
                <button
                  type="button"
                  onClick={() =>
                    void api.invoke('ai:cancel', { requestId: (busy ?? worldJob)!.id })
                  }
                >
                  Stop
                </button>
              ) : (
                <button
                  className="primary"
                  type="submit"
                  disabled={!draft.trim()}
                  title={`Sends to ${provider === 'chatgpt' ? 'ChatGPT' : 'Ollama'}. Nothing in your chapter changes unless Edit chapter is ticked; conversations are saved with this story.`}
                >
                  {editMode ? 'Edit chapter' : 'Send'}
                </button>
              )}
            </div>
          </form>
        )}
      </section>
      {compare && (
        <CompareDialog
          chapterTitle={compare.chapterTitle}
          result={compare.result}
          apply={(doc) => localEditor(seriesId)?.replace(doc)}
          onDone={(o) => void finishCompare(o)}
        />
      )}
    </div>
  )
}
