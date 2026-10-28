import { useState, type FormEvent } from 'react'
import type { WorldCategory } from '@shared/schema'
import { api, describeError } from '../api'

/** Create a category, or edit one's name and section template. */
export function CategoryDialog(props: {
  worldId: string
  category?: WorldCategory
  onDone: () => void
}) {
  const { category } = props
  const [name, setName] = useState(category?.name ?? '')
  const [sections, setSections] = useState(
    category ? category.sections.map((s) => s.name).join('\n') : 'Overview',
  )
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const lines = sections
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    try {
      if (category) {
        await api.invoke('category:update', {
          worldId: props.worldId,
          categoryId: category.id,
          name,
          // Keep ids for sections whose name is unchanged.
          sections: lines.map((line) => ({
            id: category.sections.find((s) => s.name === line)?.id,
            name: line,
          })),
        })
      } else {
        await api.invoke('category:create', { worldId: props.worldId, name, sections: lines })
      }
      props.onDone()
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onDone}>
      <form
        className="card stack dialog"
        role="dialog"
        aria-label={category ? 'Edit category' : 'New category'}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => e.key === 'Escape' && props.onDone()}
      >
        <h3>{category ? `Edit “${category.name}”` : 'New category'}</h3>
        <label>
          Name
          <input
            autoFocus
            required
            value={name}
            placeholder="e.g. Characters, Magic, Ships"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          Sections for new entries (one per line)
          <textarea rows={5} value={sections} onChange={(e) => setSections(e.target.value)} />
        </label>
        <p className="muted small">
          New entries in this category start with these sections. Each entry can add, rename or
          remove its own.
          {category ? ' Existing entries keep theirs.' : ''}
        </p>
        {error && <p className="error">{error}</p>}
        <div className="dialog-choices">
          <button className="primary" type="submit">
            {category ? 'Save' : 'Create'}
          </button>
          <button type="button" onClick={props.onDone}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
