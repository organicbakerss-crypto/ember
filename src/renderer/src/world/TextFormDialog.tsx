import { useState } from 'react'

/** Shows a text form of the world (an entry, or the digest), as a language model would read it. */
export function TextFormDialog(props: { title: string; text: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card stack dialog text-form"
        role="dialog"
        aria-label={props.title}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h3>{props.title}</h3>
        <p className="muted small">
          Plain text with entry ids: what an AI model is given instead of pictures.
        </p>
        <pre tabIndex={0}>{props.text}</pre>
        <div className="dialog-choices">
          <button
            onClick={() =>
              void navigator.clipboard.writeText(props.text).then(() => setCopied(true))
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="primary" autoFocus onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
