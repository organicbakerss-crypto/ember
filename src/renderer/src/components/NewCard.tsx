import { useState, type FormEvent } from 'react'
import { describeError } from '../api'

/** The "+ New …" card at the end of a shelf. Either asks for a name inline or runs `onClick`. */
export function NewCard(
  props: { label: string } & (
    | { onClick: () => void; onCreate?: never; placeholder?: never; startNaming?: never }
    | {
        onCreate: (name: string) => Promise<unknown>
        placeholder: string
        onClick?: never
        /** Open with the name field ready. */
        startNaming?: boolean
      }
  ),
) {
  const [naming, setNaming] = useState(props.startNaming ?? false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !props.onCreate) return
    try {
      await props.onCreate(name)
      setName('')
      setNaming(false)
      setError(null)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <div className="shelf-item">
      {naming ? (
        <form className="new-card naming" onSubmit={(e) => void submit(e)}>
          <input
            autoFocus
            value={name}
            placeholder={props.placeholder}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setNaming(false)}
            onBlur={() => !name.trim() && setNaming(false)}
          />
          {error && <span className="error small">{error}</span>}
        </form>
      ) : (
        <button
          className="new-card"
          onClick={() => (props.onClick ? props.onClick() : setNaming(true))}
        >
          + {props.label}
        </button>
      )}
    </div>
  )
}
