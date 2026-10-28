import { useState, type FormEvent } from 'react'
import type { Template } from '@shared/schema'
import { DEFAULT_TEMPLATE, type Lens } from '@shared/world/templates'
import { TemplatePicker } from './TemplatePicker'

/**
 * Quick add: a name and a template, from anywhere (the writing page, World
 * mode). From a lens's button, the lens's likeliest template is chosen and
 * only that lens is listed (with "Something else…"); from the page, every
 * template is listed and the default is a guess from context, or Person.
 * The caller does the creating (with undo).
 */
export function QuickAddDialog(props: {
  templates: Template[]
  /** Names already in the world, to warn about duplicates. */
  existing: string[]
  name?: string
  lens?: Lens
  /** The template to start with (a guess from context, or a map's likely kind of place). */
  template?: string | null
  /** Shown when there's no world yet: makes one first. */
  noWorld?: { seriesName: string; onCreateWorld: () => Promise<void> }
  onCreate: (name: string, template: string) => Promise<boolean>
  onCancel: () => void
}) {
  const [name, setName] = useState(props.name ?? '')
  const [template, setTemplate] = useState(
    () =>
      [props.template, props.lens && DEFAULT_TEMPLATE[props.lens], 'person'].find(
        (id): id is string => !!id && props.templates.some((t) => t.id === id),
      ) ??
      props.templates[0]?.id ??
      'person',
  )
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
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.defaultPrevented) props.onCancel()
        }}
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
            <div className="field">
              <span id="quick-add-kind">What is it?</span>
              <TemplatePicker
                label="What is it?"
                templates={props.templates}
                value={template}
                lens={props.lens}
                onChange={setTemplate}
              />
            </div>
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
