import { useState } from 'react'
import { describeError } from '../api'

/**
 * Text that turns into a field when renamed (double-click, F2 or a menu).
 * `editing` is controlled so menus and shortcuts can start a rename.
 * Renaming only changes the display name.
 */
export function EditableText(props: {
  value: string
  placeholder?: string
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onRename: (name: string) => Promise<unknown> | void
  className?: string
  /** Allow an empty name (chapters can be untitled). */
  allowEmpty?: boolean
}) {
  const [draft, setDraft] = useState(props.value)
  const [error, setError] = useState<string | null>(null)
  const [wasEditing, setWasEditing] = useState(props.editing)
  if (props.editing !== wasEditing) {
    setWasEditing(props.editing)
    if (props.editing) setDraft(props.value)
  }

  const commit = async () => {
    const name = draft.trim()
    if ((!name && !props.allowEmpty) || name === props.value) {
      props.onEditingChange(false)
      return
    }
    try {
      await props.onRename(name)
      setError(null)
      props.onEditingChange(false)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  if (!props.editing) {
    return (
      <span
        className={props.className}
        title="Double-click to rename"
        onDoubleClick={(e) => {
          e.stopPropagation()
          props.onEditingChange(true)
        }}
      >
        {props.value || props.placeholder}
      </span>
    )
  }
  return (
    <span className="editable-field">
      <input
        autoFocus
        aria-label="New name"
        value={draft}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        // Keep drag-and-drop from grabbing the row while typing or selecting.
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') void commit()
          if (e.key === 'Escape') props.onEditingChange(false)
        }}
        onBlur={() => void commit()}
      />
      {error && <span className="error small">{error}</span>}
    </span>
  )
}
