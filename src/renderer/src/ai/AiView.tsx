import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConversationSummary } from '@shared/ipc'
import type { PaneRoute } from '@shared/panes'
import type { ConversationFile, ConversationMessage } from '@shared/schema'
import { newId } from '@shared/ids'
import { api, describeError, useIpcEvent } from '../api'
import { formatWhen } from '../components/TrashPage'
import { useSettings } from '../useTheme'
import { parse, type Block, type Inline } from './markdown'
import { fetchScope, useLocalScope } from './scope'

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
const empty = (): Thread => ({ id: null, createdAt: null, messages: [] })

/* ---------- formatted answers ---------- */

function Inlines(props: { c: Inline[] }): ReactNode {
  return props.c.map((x, i) =>
    x.t === 'text' ? (
      x.s
    ) : x.t === 'code' ? (
      <code key={i}>{x.s}</code>
    ) : x.t === 'b' ? (
      <strong key={i}>
        <Inlines c={x.c} />
      </strong>
    ) : (
      <em key={i}>
        <Inlines c={x.c} />
      </em>
    ),
  )
}

function Blocks(props: { blocks: Block[] }): ReactNode {
  return props.blocks.map((b, i) => {
    switch (b.t) {
      case 'p':
        return (
          <p key={i}>
            <Inlines c={b.c} />
          </p>
        )
      case 'h': {
        const H = (b.level <= 2 ? 'h3' : 'h4') as 'h3' | 'h4'
        return (
          <H key={i}>
            <Inlines c={b.c} />
          </H>
        )
      }
      case 'ul':
        return (
          <ul key={i}>
            {b.items.map((it, k) => (
              <li key={k}>
                <Inlines c={it} />
              </li>
            ))}
          </ul>
        )
      case 'ol':
        return (
          <ol key={i} start={b.start}>
            {b.items.map((it, k) => (
              <li key={k}>
                <Inlines c={it} />
              </li>
            ))}
          </ol>
        )
      case 'quote':
        return (
          <blockquote key={i}>
            <Blocks blocks={b.blocks} />
          </blockquote>
        )
      case 'pre':
        return <pre key={i}>{b.s}</pre>
      case 'hr':
        return <hr key={i} />
    }
  })
}

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
}) {
  const { seriesId } = props
  const { settings } = useSettings()
  const provider = settings.ai.provider
  const [mode, setMode] = useState<Mode>('chat')
  const [threads, setThreads] = useState<Record<Mode, Thread>>({
    chat: empty(),
    brainstorm: empty(),
    ask: empty(),
  })
  const [draft, setDraft] = useState('')
  const [quote, setQuote] = useState<string | null>(null)
  const [wholeChapter, setWholeChapter] = useState(false)
  const [busy, setBusy] = useState<{ id: string; mode: Mode } | null>(null)
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
  const local = useLocalScope(seriesId)
  const thread = threads[mode]
  const messages = thread.messages

  const { onRoute, volumeId } = props
  useEffect(() => {
    onRoute?.({ kind: 'ai', seriesId, volumeId })
  }, [onRoute, seriesId, volumeId])

  const refreshPast = () => {
    api.invoke('ai:conversations', { seriesId }).then(setPast, () => {})
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
    setThreads((t) => {
      const msgs = [...t[into].messages]
      const last = msgs[msgs.length - 1]
      if (last?.role === 'assistant')
        msgs[msgs.length - 1] = { ...last, content: last.content + text }
      return { ...t, [into]: { ...t[into], messages: msgs } }
    })
  })

  const scopeKind = wholeChapter ? 'chapter' : local?.selection ? 'selection' : 'screen'
  const chip = !local
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
      setThreads((t) => ({
        ...t,
        [c.mode]: { id: c.id, createdAt: c.createdAt, messages: c.messages },
      }))
      stick.current = true
      setListOpen(false)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const remove = async (id: string) => {
    await api
      .invoke('ai:deleteConversation', { seriesId, conversationId: id })
      .catch((err) => setError(describeError(err).message))
    setPast((p) => p.filter((c) => c.id !== id))
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
      title:
        first.replace(/^>.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Conversation',
      createdAt,
      updatedAt: now,
      messages: msgs,
    }
    setThreads((t) => ({ ...t, [into]: { id, createdAt, messages: msgs } }))
    void api
      .invoke('ai:saveConversation', { seriesId, conversation })
      .then(refreshPast)
      .catch((err) => setError(`Couldn’t save the conversation: ${describeError(err).message}`))
  }

  const send = async (text: string) => {
    const question = text.trim()
    if (!question || busy) return
    const into = mode
    const current = thread
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const scope = await fetchScope(seriesId)
    const kind = wholeChapter ? 'chapter' : scope?.selection ? 'selection' : 'screen'
    const scopeText =
      kind === 'selection' ? scope!.selection! : kind === 'screen' ? (scope?.screen ?? '') : ''
    const where = scope?.chapterTitle ? ` in “${scope.chapterTitle}”` : ''
    const read = !scope?.chapterId
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
    setThreads((t) => ({
      ...t,
      [into]: {
        ...current,
        messages: [...history, { role: 'assistant', content: '', at: now, read: null }],
      },
    }))
    setDraft('')
    setQuote(null)
    setError(null)
    setBusy({ id: requestId, mode: into })
    stick.current = true
    partial.current = ''
    try {
      const answer = await api.invoke('ai:ask', {
        requestId,
        mode: into,
        messages: history
          .slice(-CONTEXT_MESSAGES)
          .map((m) => ({ role: m.role, content: m.content })),
        scope: scope?.chapterId
          ? {
              kind,
              seriesId,
              volumeId: scope.volumeId,
              chapterId: scope.chapterId,
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
        setThreads((t) => ({ ...t, [into]: { ...t[into], messages: history } }))
      }
    } finally {
      setBusy(null)
    }
  }

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
            setThreads((t) => ({ ...t, [mode]: empty() }))
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

  return (
    <div className="ai-view" ref={root}>
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
          {messages.length > 0 && !busy && (
            <button
              className="link small"
              title="Start a new conversation (this one stays in the list)"
              onClick={() => setThreads((t) => ({ ...t, [mode]: empty() }))}
            >
              New conversation
            </button>
          )}
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
              <div key={i} className={`ai-message ${m.role}`}>
                {m.content ? (
                  <div className="ai-text">
                    <Blocks blocks={parse(m.content)} />
                  </div>
                ) : (
                  <p className="muted">…</p>
                )}
                {m.read && <div className="ai-read muted small">Read {m.read}</div>}
                {m.role === 'assistant' && m.content && !(busy && i === messages.length - 1) && (
                  <div className="ai-actions small">
                    <button className="link" onClick={() => void copy(i, m.content)}>
                      {copied === i ? 'Copied' : 'Copy'}
                    </button>
                    <button className="link" onClick={() => replyTo(m.content.slice(0, 400))}>
                      Reply to this
                    </button>
                  </div>
                )}
              </div>
            ))}
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
          <div className="ai-scope small">
            <span className="ai-chip" title="What the AI reads with your message">
              {chip}
            </span>
            <label className="ai-whole">
              <input
                type="checkbox"
                checked={wholeChapter}
                onChange={(e) => setWholeChapter(e.target.checked)}
              />
              Whole chapter
            </label>
          </div>
          <textarea
            ref={input}
            aria-label="Message to the AI"
            placeholder={
              quote ? 'Reply to that part…' : mode === 'ask' ? 'Ask about your story…' : 'Message…'
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
          <div className="row">
            <span className="muted small">
              {provider === 'chatgpt' ? 'ChatGPT (your plan)' : 'Ollama, on this computer'} ·
              Nothing in your chapter changes. Saved with this story.
            </span>
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
      </section>
    </div>
  )
}
