import { useState, type FormEvent } from 'react'
import type { Template } from '@shared/schema'
import { LENSES } from '@shared/world/lenses'
import { DEFAULT_TEMPLATE, LENS_LABELS, type Lens } from '@shared/world/templates'

/**
 * Quick add: a name and a template, from anywhere (the writing page, World
 * mode). The caller does the creating (with undo).
 */
export function QuickAddDialog(props: {
  templates: Template[]
  /** Names already in the world, to warn about duplicates. */
  existing: string[]
  name?: string
  lens?: Lens
  /** Shown when there's no world yet: makes one first. */
  noWorld?: { seriesName: string; onCreateWorld: () => Promise<void> }
  onCreate: (name: string, template: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [name, setName] = useState(props.name ?? '')
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE[props.lens ?? 'who'])
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    const ok = await props.onCreate(name.trim(), template)
    setBusy(false)
    if (ok) props.onCancel()
  }
  const exists = props.existing.some((n) => n.toLowerCase() === name.trim().toLowerCase())

  return (
    <div className="modal-backdrop" onMouseDown={props.onCancel}>
      <form
        className="card stack dialog"
        role="dialog"
        aria-label="Add to the world"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}
      >
        <h3>Add to the world</h3>
        {props.noWorld ? (
          <>
            <p className="muted">“{props.noWorld.seriesName}” isn’t linked to a world yet.</p>
            <button
              type="button"
              className="primary"
              onClick={() => void props.noWorld!.onCreateWorld()}
            >
              Create “{props.noWorld.seriesName} world”
            </button>
          </>
        ) : (
          <>
            <label>
              Name
              <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              What is it?
              <select value={template} onChange={(e) => setTemplate(e.target.value)}>
                {LENSES.map((lens) => (
                  <optgroup key={lens} label={LENS_LABELS[lens]}>
                    {props.templates
                      .filter((t) => t.lens === lens)
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {exists && <p className="warning small">“{name.trim()}” is already in this world.</p>}
          </>
        )}
        <div className="dialog-choices">
          {!props.noWorld && (
            <button className="primary" type="submit" disabled={busy}>
              Add
            </button>
          )}
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
