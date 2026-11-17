import { useEffect, useRef, useState } from 'react'
import type { CommentInfo } from '../editor/comments'
import type { PhoneNote } from '@shared/phone'
import { ARCHIVE_DAYS } from '@shared/phone'
import { MOD } from './commands'

/**
 * The open chapter's comments, in reading order: the passage, and the note
 * (saved when you click away). Clicking a passage shows it on the page.
 */
export function CommentsPanel(props: {
  comments: CommentInfo[]
  /** The comment the cursor is in. */
  activeId: string | null
  /** A comment just made: its note box is focused. */
  focusId: string | null
  readOnly: boolean
  /** AI notes (only while the AI is on): read the chapter, stop, take them all off. */
  ai?: {
    busy: string | null
    onRead: () => void
    onStop: () => void
    onClear: () => void
  } | null
  onAdd: () => void
  onNote: (id: string, note: string) => void
  onRemove: (id: string) => void
  onShow: (id: string) => void
  /** Notes left on the phone reader for this chapter (only once it's set up). */
  phone?: {
    notes: PhoneNote[]
    onDone: (id: string, done: boolean) => void
    onShow: (note: PhoneNote) => void
  } | null
}) {
  const phoneOpen = props.phone?.notes.filter((n) => !n.archivedAt) ?? []
  const phoneDone = props.phone?.notes.filter((n) => n.archivedAt) ?? []
  return (
    <div className="comments-panel">
      <h2>Comments</h2>
      <p className="muted small">
        Notes to yourself on the text. Select a passage, then right-click and choose “Add a
        comment”, or press {MOD}Alt+M.
      </p>
      {!props.readOnly && (
        <button className="small" onClick={props.onAdd}>
          Comment on the selected text
        </button>
      )}
      {props.ai && !props.readOnly && (
        <div className="comments-ai">
          {props.ai.busy ? (
            <div className="row">
              <span className="muted small">{props.ai.busy}</span>
              <span className="status-spacer" />
              <button className="link small" onClick={props.ai.onStop}>
                Stop
              </button>
            </div>
          ) : (
            <div className="row">
              <button
                className="small"
                onClick={props.ai.onRead}
                title="The AI reads the chapter and notes continuity slips, unclear bits and accidental repeats. Nothing in the text changes."
              >
                AI notes on this chapter
              </button>
              {props.comments.some((c) => c.by === 'ai') && (
                <button className="link small" onClick={props.ai.onClear}>
                  Clear AI notes
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {props.phone && (phoneOpen.length > 0 || phoneDone.length > 0) && (
        <section className="phone-notes" aria-label="Notes from iPhone">
          <h3 className="small">Notes from iPhone ({phoneOpen.length})</h3>
          <ol className="comment-list">
            {[...phoneOpen, ...phoneDone].map((n) => (
              <li key={n.id} className={`comment-card phone-note ${n.archivedAt ? 'done' : ''}`}>
                <div className="row phone-note-head">
                  <span className="comment-by small">Note from iPhone</span>
                  <span className="muted small">{new Date(n.createdAt).toLocaleString()}</span>
                  <span className="status-spacer" />
                  <button
                    className={`icon phone-check ${n.archivedAt ? 'on' : ''}`}
                    aria-label={n.archivedAt ? 'Put back' : 'Done'}
                    title={
                      n.archivedAt
                        ? `Done: deleted ${ARCHIVE_DAYS} days after you ticked it. Click to put it back.`
                        : `Done (archived, then deleted after ${ARCHIVE_DAYS} days)`
                    }
                    onClick={() => props.phone!.onDone(n.id, !n.archivedAt)}
                  >
                    ✓
                  </button>
                </div>
                {n.quote ? (
                  <button
                    className="comment-passage"
                    title="Show it on the page"
                    onClick={() => props.phone!.onShow(n)}
                  >
                    “{n.quote.length > 160 ? `${n.quote.slice(0, 157)}…` : n.quote}”
                  </button>
                ) : (
                  <div className="muted small">On the whole chapter</div>
                )}
                <p className="phone-note-text">{n.text}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
      {props.comments.length === 0 ? (
        <p className="muted small">No comments in this chapter.</p>
      ) : (
        <ol className="comment-list">
          {props.comments.map((c) => (
            <CommentCard
              key={c.id}
              comment={c}
              active={c.id === props.activeId}
              focus={c.id === props.focusId}
              readOnly={props.readOnly}
              onNote={(note) => props.onNote(c.id, note)}
              onRemove={() => props.onRemove(c.id)}
              onShow={() => props.onShow(c.id)}
            />
          ))}
        </ol>
      )}
    </div>
  )
}

function CommentCard(props: {
  comment: CommentInfo
  active: boolean
  focus: boolean
  readOnly: boolean
  onNote: (note: string) => void
  onRemove: () => void
  onShow: () => void
}) {
  const { comment } = props
  const [draft, setDraft] = useState(comment.note)
  const [editing, setEditing] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const card = useRef<HTMLLIElement>(null)
  // Follow changes made elsewhere (undo, sync) while not typing here.
  const shown = editing ? draft : comment.note
  useEffect(() => {
    if (props.focus) box.current?.focus()
  }, [props.focus])
  useEffect(() => {
    if (props.active) card.current?.scrollIntoView({ block: 'nearest' })
  }, [props.active])
  const commit = () => {
    setEditing(false)
    if (draft !== comment.note) props.onNote(draft)
  }
  const passage = comment.text.length > 160 ? `${comment.text.slice(0, 157)}…` : comment.text
  return (
    <li
      ref={card}
      className={`comment-card ${props.active ? 'active' : ''} ${comment.by === 'ai' ? 'ai-note' : ''}`}
    >
      {comment.by === 'ai' && <span className="comment-by small">AI note</span>}
      <button className="comment-passage" title="Show it on the page" onClick={props.onShow}>
        “{passage}”
      </button>
      <textarea
        ref={box}
        aria-label="Comment"
        rows={2}
        value={shown}
        readOnly={props.readOnly}
        placeholder="Your note…"
        onFocus={() => {
          setDraft(comment.note)
          setEditing(true)
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
      />
      {!props.readOnly && (
        <button
          className="small link"
          onClick={props.onRemove}
          title="Remove the comment (the text stays)"
        >
          {comment.by === 'ai' ? 'Dismiss' : 'Resolve'}
        </button>
      )}
    </li>
  )
}
