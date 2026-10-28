import { useState } from 'react'
import type { Template } from '@shared/schema'
import { LENSES } from '@shared/world/lenses'
import { LENS_LABELS, isBuiltIn } from '@shared/world/templates'
import { api, describeError } from '../api'
import type { WorldData } from './useWorld'

type Draft = {
  id?: string
  name: string
  lens: Template['lens']
  fields: {
    id?: string
    label: string
    kind: 'text' | 'link'
    quick: boolean
    multiple: boolean
    reverse?: string
  }[]
}

/**
 * Templates: which details an entry offers and which show as quick facts.
 * Changes are saved into the world folder, so they travel with the world.
 */
export function TemplateDialog(props: { world: WorldData; onClose: () => void }) {
  const { world } = props
  const worldId = world.view.world.id
  const [selected, setSelected] = useState<string>(world.view.templates[0]?.id ?? '')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const template = world.templates.get(selected)
  const custom = world.view.customTemplates.includes(selected)

  const edit = (t: Template | undefined) =>
    setDraft(
      t
        ? { id: t.id, name: t.name, lens: t.lens, fields: t.fields.map((f) => ({ ...f })) }
        : {
            name: '',
            lens: 'who',
            fields: [{ label: '', kind: 'text', quick: true, multiple: false }],
          },
    )

  const save = async () => {
    if (!draft) return
    try {
      const saved = await api.invoke('template:save', {
        worldId,
        template: { ...draft, fields: draft.fields.filter((f) => f.label.trim()) },
      })
      setSelected(saved.id)
      setDraft(null)
      setError(null)
    } catch (err) {
      setError(describeError(err).message)
    }
  }
  const reset = async () => {
    try {
      await api.invoke('template:delete', { worldId, templateId: selected })
      if (!isBuiltIn(selected)) setSelected(world.view.templates[0]?.id ?? '')
    } catch (err) {
      setError(describeError(err).message)
    }
  }
  const setField = (i: number, change: Partial<Draft['fields'][number]>) =>
    draft &&
    setDraft({ ...draft, fields: draft.fields.map((f, j) => (j === i ? { ...f, ...change } : f)) })

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card dialog template-dialog"
        role="dialog"
        aria-label="Templates"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <nav className="template-list" aria-label="Templates">
          {LENSES.map((lens) => (
            <div key={lens}>
              <h4 className="small muted">{LENS_LABELS[lens]}</h4>
              {world.view.templates
                .filter((t) => t.lens === lens)
                .map((t) => (
                  <button
                    key={t.id}
                    className={`settings-nav-item ${t.id === selected ? 'active' : ''}`}
                    onClick={() => {
                      setSelected(t.id)
                      setDraft(null)
                    }}
                  >
                    {t.name}
                    {world.view.customTemplates.includes(t.id) && (
                      <span className="muted small">
                        {' '}
                        · {isBuiltIn(t.id) ? 'changed' : 'yours'}
                      </span>
                    )}
                  </button>
                ))}
            </div>
          ))}
          <button className="link" onClick={() => edit(undefined)}>
            + New template
          </button>
        </nav>
        <div className="template-body stack">
          {draft ? (
            <>
              <label>
                Name
                <input
                  autoFocus
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                Lens
                <select
                  value={draft.lens}
                  onChange={(e) => setDraft({ ...draft, lens: e.target.value as Draft['lens'] })}
                >
                  {LENSES.map((l) => (
                    <option key={l} value={l}>
                      {LENS_LABELS[l]}
                    </option>
                  ))}
                </select>
              </label>
              <table className="entry-table small">
                <thead>
                  <tr>
                    <th>Detail</th>
                    <th>Kind</th>
                    <th>Quick fact</th>
                    <th>Several</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.fields.map((f, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          aria-label="Detail name"
                          value={f.label}
                          onChange={(e) => setField(i, { label: e.target.value })}
                        />
                      </td>
                      <td>
                        <select
                          aria-label="Kind"
                          value={f.kind}
                          onChange={(e) => setField(i, { kind: e.target.value as 'text' | 'link' })}
                        >
                          <option value="text">Text</option>
                          <option value="link">Link to an entry</option>
                        </select>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label="Quick fact"
                          checked={f.quick}
                          onChange={(e) => setField(i, { quick: e.target.checked })}
                        />
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          aria-label="Several values"
                          checked={f.multiple}
                          onChange={(e) => setField(i, { multiple: e.target.checked })}
                        />
                      </td>
                      <td>
                        <button
                          className="icon"
                          aria-label="Remove detail"
                          onClick={() =>
                            setDraft({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })
                          }
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                className="link"
                onClick={() =>
                  setDraft({
                    ...draft,
                    fields: [
                      ...draft.fields,
                      { label: '', kind: 'text', quick: false, multiple: false },
                    ],
                  })
                }
              >
                + Add a detail
              </button>
              <p className="muted small">
                Removing a detail never deletes what entries already hold; it still shows on their
                pages.
              </p>
              {error && <p className="error small">{error}</p>}
              <div className="dialog-choices">
                <button
                  className="primary"
                  disabled={!draft.name.trim()}
                  onClick={() => void save()}
                >
                  Save template
                </button>
                <button onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </>
          ) : template ? (
            <>
              <h3>{template.name}</h3>
              <p className="muted small">
                {LENS_LABELS[template.lens]} · {template.fields.filter((f) => f.quick).length} quick
                facts. Every entry also has a free page.
              </p>
              <ul className="small">
                {template.fields.map((f) => (
                  <li key={f.id}>
                    {f.label}
                    <span className="muted">
                      {' '}
                      · {f.kind === 'link' ? 'link' : 'text'}
                      {f.quick ? ' · quick fact' : ''}
                      {f.multiple ? ' · several' : ''}
                    </span>
                  </li>
                ))}
              </ul>
              {error && <p className="error small">{error}</p>}
              <div className="dialog-choices">
                <button onClick={() => edit(template)}>Edit</button>
                {custom && (
                  <button onClick={() => void reset()}>
                    {isBuiltIn(selected) ? 'Back to the original' : 'Delete template'}
                  </button>
                )}
                <button className="primary" onClick={props.onClose}>
                  Close
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}
