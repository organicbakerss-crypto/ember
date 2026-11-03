/** Shown above a document another window or pane is editing. */
export function ReadOnlyNote(props: { what: string; onTake: () => void }) {
  return (
    <div className="read-only-note small" role="status">
      <span>
        This {props.what} is being edited in another window or pane. It updates here as it changes.
      </span>
      <button className="link" onClick={props.onTake}>
        Edit here
      </button>
    </div>
  )
}
