import { useMemo, useRef, useState } from 'react'
import type { ConversationFile } from '@shared/schema'
import { parse } from './markdown'
import { Blocks } from './FormattedAnswer'
import { formatWhen } from '../components/TrashPage'

/** "23 Oct – 6 Nov 2026": the dates of the first and last messages. */
function span(first: string | undefined, last: string | undefined): string {
  if (!first || !last) return ''
  const a = new Date(first)
  const b = new Date(last)
  const day = (d: Date, year: boolean) =>
    d.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      ...(year ? { year: 'numeric' } : {}),
    })
  if (a.toDateString() === b.toDateString()) return day(b, true)
  return `${day(a, a.getFullYear() !== b.getFullYear())} – ${day(b, true)}`
}

/** Messages shown at first, and how many more each "Show earlier" adds. */
const PAGE = 40

/**
 * A chat brought in from ChatGPT, read-only. These run to hundreds of pages,
 * so it opens at the end and shows earlier messages on request; a search box
 * finds a word anywhere in it.
 */
export function ImportedChat(props: {
  chat: ConversationFile
  busy: boolean
  /** A newer saved copy of the page (picked or dropped): replaces this chat. */
  onUpdate: (file: File) => void
  onClose: () => void
  /** Carry on talking, with this chat as the start. */
  onContinue: () => void
  /** Read this chat into the story's memory. */
  onMakeNodes: () => void
}) {
  const { chat } = props
  const picker = useRef<HTMLInputElement>(null)
  const [shown, setShown] = useState(PAGE)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const found = useMemo(
    () =>
      q.length >= 2
        ? chat.messages
            .map((m, i) => ({ m, i }))
            .filter(({ m }) => m.content.toLowerCase().includes(q))
        : null,
    [chat.messages, q],
  )
  const list =
    found ??
    chat.messages.slice(-shown).map((m, k, all) => ({
      m,
      i: chat.messages.length - all.length + k,
    }))
  const earlier = found ? 0 : Math.max(0, chat.messages.length - shown)

  return (
    <div
      className="imported-chat"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        const file = e.dataTransfer.files[0]
        if (!file) return
        e.preventDefault()
        props.onUpdate(file)
      }}
    >
      <header className="imported-chat-head">
        <div>
          <strong>{chat.title}</strong>
          <div className="muted small">
            From ChatGPT · {chat.messages.length.toLocaleString()} messages,{' '}
            {span(chat.messages[0]?.at, chat.messages.at(-1)?.at)} · read-only
          </div>
        </div>
        <span className="status-spacer" />
        <button
          disabled={props.busy}
          title="After more chatting: in ChatGPT use Share → Update link, open the link in your browser, save the page (Ctrl+S), and pick that file. You can also drop it here."
          onClick={() => picker.current?.click()}
        >
          {props.busy ? 'Updating…' : 'Update…'}
        </button>
        <input
          ref={picker}
          type="file"
          accept=".html,.htm,text/html"
          hidden
          aria-label="Newer saved page"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) props.onUpdate(file)
          }}
        />
        <button
          className="primary"
          title="Keep talking where this chat left off. The AI gets its latest messages word for word and looks back through the rest."
          onClick={props.onContinue}
        >
          Continue this chat
        </button>
        <button
          title="Read this chat into the story's memory, as topics with what's fixed, unfixed and your whims"
          onClick={props.onMakeNodes}
        >
          Make nodes…
        </button>
        <button onClick={props.onClose}>Close</button>
      </header>
      <p className="muted small imported-chat-note">
        When you ask the AI about this story, it looks through this chat for the parts that matter.
      </p>
      <input
        type="search"
        aria-label="Find in this chat"
        placeholder="Find in this chat"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {found && (
        <p className="muted small" role="status">
          {found.length === 0
            ? 'Not in this chat.'
            : `${found.length} ${found.length === 1 ? 'message' : 'messages'}`}
        </p>
      )}
      <div className="imported-chat-scroll">
        {earlier > 0 && (
          <button className="link small" onClick={() => setShown((n) => n + PAGE)}>
            Show earlier ({earlier.toLocaleString()} more)
          </button>
        )}
        {list.slice(0, 200).map(({ m, i }) => (
          <div key={i} className={`ai-message ${m.role}`}>
            <div className="ai-who muted small">
              {m.role === 'user' ? 'You' : 'ChatGPT'} · {formatWhen(m.at)}
            </div>
            <div className="ai-text">
              <Blocks blocks={parse(m.content)} />
            </div>
          </div>
        ))}
        {found && found.length > 200 && (
          <p className="muted small">The first 200 are shown; add a word to narrow it.</p>
        )}
      </div>
    </div>
  )
}
