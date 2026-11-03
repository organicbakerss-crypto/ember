import { useEffect, useRef, useState } from 'react'
import { api, describeError, useIpcEvent } from '../api'

type Mode = 'chat' | 'brainstorm' | 'ask'
interface Message {
  role: 'user' | 'assistant'
  content: string
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

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/**
 * The AI beside the page: chat, brainstorm or ask the story. It reads only
 * what the chip says (the selection, what's on screen, or the whole chapter
 * when asked) and never changes the chapter.
 */
export function AiPanel(props: {
  seriesId: string
  volumeId: string
  chapterId: string | null
  /** Selected text in the chapter, if any. */
  selection: string | null
  /** What's on screen now. */
  screenText: () => string
  provider: 'ollama' | 'chatgpt'
}) {
  const [mode, setMode] = useState<Mode>('chat')
  const [threads, setThreads] = useState<Record<Mode, Message[]>>({
    chat: [],
    brainstorm: [],
    ask: [],
  })
  const [draft, setDraft] = useState('')
  const [wholeChapter, setWholeChapter] = useState(false)
  const [busy, setBusy] = useState<{ id: string; mode: Mode } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [read, setRead] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const messages = threads[mode]

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [messages])

  // The answer arrives piece by piece.
  useIpcEvent('ai:token', ({ requestId, text }) => {
    if (requestId !== busy?.id) return
    const into = busy.mode
    setThreads((t) => {
      const thread = [...t[into]]
      const last = thread[thread.length - 1]
      if (last?.role === 'assistant')
        thread[thread.length - 1] = { ...last, content: last.content + text }
      return { ...t, [into]: thread }
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

  const send = async (text: string) => {
    const question = text.trim()
    if (!question || busy) return
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const history: Message[] = [...messages, { role: 'user', content: question }]
    setThreads((t) => ({ ...t, [mode]: [...history, { role: 'assistant', content: '' }] }))
    setDraft('')
    setError(null)
    setBusy({ id: requestId, mode })
    const scopeText =
      scopeKind === 'selection'
        ? props.selection!
        : scopeKind === 'screen'
          ? props.screenText()
          : ''
    setRead(
      scopeKind === 'chapter'
        ? 'Read the whole chapter'
        : `Read ${scopeKind === 'selection' ? 'your selection' : 'what was on screen'}, ~${words(scopeText)} words`,
    )
    try {
      await api.invoke('ai:ask', {
        requestId,
        mode,
        messages: history.slice(-20),
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
    } catch (err) {
      const e = describeError(err)
      if (e.code !== 'cancelled') setError(e.message)
      // Drop an empty answer bubble.
      setThreads((t) => {
        const thread = t[mode]
        const last = thread[thread.length - 1]
        return last?.role === 'assistant' && !last.content
          ? { ...t, [mode]: thread.slice(0, -1) }
          : t
      })
    } finally {
      setBusy(null)
    }
  }

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
          </div>
        ))}
      </div>
      {read && <p className="muted small ai-read">{read}</p>}
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
              onClick={() => setThreads((t) => ({ ...t, [mode]: [] }))}
            >
              Clear
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
