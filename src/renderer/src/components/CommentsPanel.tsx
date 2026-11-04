import { useEffect, useRef, useState } from 'react'
import type { CommentInfo } from '../editor/comments'
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
  onAdd: () => void
  onNote: (id: string, note: string) => void
  onRemove: (id: string) => void
  onShow: (id: string) => void
}) {
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
    <li ref={card} className={`comment-card ${props.active ? 'active' : ''}`}>
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
          Resolve
        </button>
      )}
    </li>
  )
}
