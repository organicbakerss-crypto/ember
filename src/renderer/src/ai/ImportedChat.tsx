import { useMemo, useState } from 'react'
import type { ConversationFile } from '@shared/schema'
import { parse } from './markdown'
import { Blocks } from './FormattedAnswer'
import { formatWhen } from '../components/TrashPage'

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
  onUpdate: () => void
  onClose: () => void
}) {
  const { chat } = props
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
    <div className="imported-chat">
      <header className="imported-chat-head">
        <div>
          <strong>{chat.title}</strong>
          <div className="muted small">
            From ChatGPT · {chat.messages.length.toLocaleString()} messages · last message{' '}
            {formatWhen(chat.updatedAt)} · read-only
          </div>
        </div>
        <span className="status-spacer" />
        <button
          disabled={props.busy}
          title="Read the share link again (after you've updated it in ChatGPT)"
          onClick={props.onUpdate}
        >
          {props.busy ? 'Updating…' : 'Update from link'}
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
