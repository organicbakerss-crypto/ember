import { useState, type FormEvent } from 'react'
import { describeError } from '../api'

/** A small "+ Add" button that turns into a name field. */
export function InlineCreate(props: {
  label: string
  placeholder: string
  onCreate: (name: string) => Promise<unknown>
  allowEmpty?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!props.allowEmpty && !name.trim()) return
    try {
      await props.onCreate(name)
      setName('')
      setOpen(false)
      setError(null)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  if (!open) {
    return (
      <button className="link" onClick={() => setOpen(true)}>
        + {props.label}
      </button>
    )
  }
  return (
    <form className="inline-create" onSubmit={(e) => void submit(e)}>
      <input
        autoFocus
        value={name}
        placeholder={props.placeholder}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
      {error && <span className="error">{error}</span>}
    </form>
  )
}
