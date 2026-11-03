import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '@shared/ipc'
import type { ConversationFile, ConversationMessage } from '@shared/schema'
import { newId } from '@shared/ids'
import { api, describeError, useIpcEvent } from '../api'
import { formatWhen } from '../components/TrashPage'

type Mode = 'chat' | 'brainstorm' | 'ask'
type Message = Pick<ConversationMessage, 'role' | 'content' | 'at' | 'read'>
interface Thread {
  /** Set once the conversation has been saved. */
  id: string | null
  createdAt: string | null
  messages: Message[]
}

const MODES: { mode: Mode; label: string; hint: string }[] = [
  { mode: 'chat', label: 'Chat', hint: 'Talk about the story or your writing.' },
  { mode: 'brainstorm', label: 'Brainstorm', hint: 'Names, plot turns, what-ifs.' },
  { mode: 'ask', label: 'Ask the story', hint: 'Answers from your chapter and world.' },
]

const STARTERS: Record<Mode, string[]> = {
  chat: ['Is this scene working?', 'What is this passage doing for the story?'],
  brainstorm: ['What could happen next?', 'Give me names for a new character', 'What if…'],
  ask: ['Who is in this scene?', 'What do we know about this place?'],
}

/** How many earlier messages go with each new one (the model's memory of the conversation). */
const CONTEXT_MESSAGES = 20

const words = (s: string) => s.split(/\s+/).filter(Boolean).length
const empty = (): Thread => ({ id: null, createdAt: null, messages: [] })

/**
 * The AI beside the page: chat, brainstorm or ask the story. It reads only
 * what the chip says (the selection, what's on screen, or the whole chapter
 * when asked) and never changes the chapter. Conversations are saved with
 * the story (and sync with it), so old brainstorms can be reopened.
 */
export function AiPanel(props: {
  seriesId: string
  volumeId: string
  chapterId: string | null
  chapterTitle: string
  /** Selected text in the chapter, if any. */
  selection: string | null
  /** What's on screen now. */
  screenText: () => string
  provider: 'ollama' | 'chatgpt'
}) {
  const [mode, setMode] = useState<Mode>('chat')
  const [threads, setThreads] = useState<Record<Mode, Thread>>({
    chat: empty(),
    brainstorm: empty(),
    ask: empty(),
  })
  const [draft, setDraft] = useState('')
  const [wholeChapter, setWholeChapter] = useState(false)
  const [busy, setBusy] = useState<{ id: string; mode: Mode } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [past, setPast] = useState<ConversationSummary[] | null>(null)
  const list = useRef<HTMLDivElement>(null)
  // The answer as it streams in (to keep what came if it's stopped).
  const partial = useRef('')
  const thread = threads[mode]
  const messages = thread.messages

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [messages])

  // The answer arrives piece by piece.
  useIpcEvent('ai:token', ({ requestId, text }) => {
    if (requestId !== busy?.id) return
    const into = busy.mode
    partial.current += text
    setThreads((t) => {
      const msgs = [...t[into].messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant')
        msgs[msgs.length - 1] = { ...last, content: last.content + text }
      return { ...t, [into]: { ...t[into], messages: msgs } }
    })
  })

  const scopeKind = wholeChapter ? 'chapter' : props.selection ? 'selection' : 'screen'
  const chip = !props.chapterId
    ? 'Reading: nothing (no chapter open)'
    : scopeKind === 'chapter'
      ? 'Reading: the whole chapter'
      : scopeKind === 'selection'
        ? `Reading: your selection, ~${words(props.selection!)} words`
        : 'Reading: what’s on screen'

  const showPast = async () => {
    if (past) {
      setPast(null)
      return
    }
    try {
      setPast(await api.invoke('ai:conversations', { seriesId: props.seriesId }))
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const open = async (id: string) => {
    try {
      const c = await api.invoke('ai:conversation', {
        seriesId: props.seriesId,
        conversationId: id,
      })
      setMode(c.mode)
      setThreads((t) => ({
        ...t,
        [c.mode]: { id: c.id, createdAt: c.createdAt, messages: c.messages },
      }))
      setPast(null)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const remove = async (id: string) => {
    await api
      .invoke('ai:deleteConversation', { seriesId: props.seriesId, conversationId: id })
      .catch((err) => setError(describeError(err).message))
    setPast((p) => p?.filter((c) => c.id !== id) ?? null)
    setThreads((t) => {
      const next = { ...t }
      for (const m of Object.keys(next) as Mode[]) if (next[m].id === id) next[m] = empty()
      return next
    })
  }

  /** Saves a conversation with the story (after each answer). */
  const save = (into: Mode, current: Thread, msgs: Message[]) => {
    const now = new Date().toISOString()
    const id = current.id ?? newId('conversation')
    const createdAt = current.createdAt ?? now
    const first = msgs.find((m) => m.role === 'user')?.content ?? 'Conversation'
    const conversation: ConversationFile = {
      formatVersion: 1,
      id,
      mode: into,
      title: first.replace(/\s+/g, ' ').slice(0, 80),
      createdAt,
      updatedAt: now,
      messages: msgs,
    }
    setThreads((t) => ({ ...t, [into]: { id, createdAt, messages: msgs } }))
    void api
      .invoke('ai:saveConversation', { seriesId: props.seriesId, conversation })
      .catch((err) => setError(`Couldn’t save the conversation: ${describeError(err).message}`))
  }

  const send = async (text: string) => {
    const question = text.trim()
    if (!question || busy) return
    const into = mode
    const current = thread
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const scopeText =
      scopeKind === 'selection'
        ? props.selection!
        : scopeKind === 'screen'
          ? props.screenText()
          : ''
    const where = props.chapterTitle ? ` in “${props.chapterTitle}”` : ''
    const read = !props.chapterId
      ? null
      : scopeKind === 'chapter'
        ? `the whole chapter${where}`
        : `${scopeKind === 'selection' ? 'your selection' : 'what was on screen'}${where}, ~${words(scopeText)} words`
    const now = new Date().toISOString()
    const history: Message[] = [
      ...current.messages,
      { role: 'user', content: question, at: now, read },
    ]
    setThreads((t) => ({
      ...t,
      [into]: {
        ...current,
        messages: [...history, { role: 'assistant', content: '', at: now, read: null }],
      },
    }))
    setDraft('')
    setError(null)
    setBusy({ id: requestId, mode: into })
    partial.current = ''
    try {
      const answer = await api.invoke('ai:ask', {
        requestId,
        mode: into,
        messages: history
          .slice(-CONTEXT_MESSAGES)
          .map((m) => ({ role: m.role, content: m.content })),
        scope: props.chapterId
          ? {
              kind: scopeKind,
              seriesId: props.seriesId,
              volumeId: props.volumeId,
              chapterId: props.chapterId,
              text: scopeText,
            }
          : null,
      })
      save(into, current, [
        ...history,
        { role: 'assistant', content: answer.text, at: new Date().toISOString(), read: null },
      ])
    } catch (err) {
      const e = describeError(err)
      if (e.code !== 'cancelled') setError(e.message)
      const got = partial.current
      if (got) {
        // Stopped part-way: keep what came.
        save(into, current, [
          ...history,
          { role: 'assistant', content: got, at: new Date().toISOString(), read: null },
        ])
      } else {
        // Nothing came: keep the question, drop the empty answer.
        setThreads((t) => ({ ...t, [into]: { ...t[into], messages: history } }))
      }
    } finally {
      setBusy(null)
    }
  }

  const shown = past?.filter((c) => c.mode === mode) ?? null

  return (
    <div className="ai-panel">
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
      <div className="ai-past-bar row small">
        <button className="link" aria-expanded={!!past} onClick={() => void showPast()}>
          {past ? 'Hide past conversations' : 'Past conversations'}
        </button>
        {thread.id && <span className="muted">Saved with this story</span>}
      </div>
      {shown && (
        <ul className="ai-past">
          {shown.length === 0 && <li className="muted small">None yet in this tab.</li>}
          {shown.map((c) => (
            <li key={c.id}>
              <button className="ai-past-open" onClick={() => void open(c.id)}>
                <span className="ai-past-title">{c.title}</span>
                <span className="muted small">
                  {formatWhen(c.updatedAt)} · {Math.ceil(c.count / 2)}{' '}
                  {Math.ceil(c.count / 2) === 1 ? 'exchange' : 'exchanges'}
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
      )}
      <div className="ai-scope small">
        <span className="ai-chip" title="What the AI reads with your message">
          {chip}
        </span>
        <label className="ai-whole">
          <input
            type="checkbox"
            checked={wholeChapter}
            disabled={!props.chapterId}
            onChange={(e) => setWholeChapter(e.target.checked)}
          />
          Whole chapter
        </label>
      </div>
      <div className="ai-messages" ref={list} aria-live="polite">
        {messages.length === 0 && (
          <div className="ai-empty muted small">
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
          <div key={i} className={`ai-message ${m.role}`}>
            {m.content || (busy ? '…' : '')}
            {m.read && <div className="ai-read muted small">Read {m.read}</div>}
          </div>
        ))}
      </div>
      {error && <p className="error small">{error}</p>}
      <form
        className="ai-input"
        onSubmit={(e) => {
          e.preventDefault()
          void send(draft)
        }}
      >
        <textarea
          aria-label="Message to the AI"
          placeholder={mode === 'ask' ? 'Ask about your story…' : 'Message…'}
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
        <div className="row">
          {messages.length > 0 && !busy && (
            <button
              type="button"
              className="link small"
              onClick={() => setThreads((t) => ({ ...t, [mode]: empty() }))}
              title="Start a new conversation (this one stays in Past)"
            >
              New conversation
            </button>
          )}
          <span className="status-spacer" />
          {busy ? (
            <button
              type="button"
              onClick={() => void api.invoke('ai:cancel', { requestId: busy.id })}
            >
              Stop
            </button>
          ) : (
            <button className="primary" type="submit" disabled={!draft.trim()}>
              Send
            </button>
          )}
        </div>
      </form>
      <p className="muted small">
        {props.provider === 'chatgpt'
          ? 'Answers from ChatGPT (your plan).'
          : 'Runs on this computer (Ollama).'}{' '}
        Nothing in your chapter changes.
      </p>
    </div>
  )
}
