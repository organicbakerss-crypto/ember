import { useState } from 'react'
import type { RelationshipType } from '@shared/schema'
import { BUILT_IN_RELATIONSHIP_TYPES } from '@shared/world/relationships'
import { api, describeError } from '../../api'
import type { WorldData } from '../useWorld'

/** Renames, recolours and adds relationship types (saved in the world folder). */
export function RelationshipTypesDialog(props: { world: WorldData; onClose: () => void }) {
  const { world } = props
  const [types, setTypes] = useState<RelationshipType[]>(world.view.relationshipTypes)
  const [error, setError] = useState<string | null>(null)
  const used = new Set(world.view.relationships.map((r) => r.type))
  const builtIn = new Set(BUILT_IN_RELATIONSHIP_TYPES.map((t) => t.id))

  const change = (i: number, patch: Partial<RelationshipType>) =>
    setTypes((list) => list.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const add = () => {
    let n = 1
    while (types.some((t) => t.id === `custom-${n}`)) n++
    setTypes([...types, { id: `custom-${n}`, label: 'New type', colour: '#2f8f8f' }])
  }
  const save = async () => {
    try {
      await api.invoke('relationship:types', {
        worldId: world.view.world.id,
        types: types.map((t) => ({ ...t, label: t.label.trim() || t.id })),
      })
      props.onClose()
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card stack dialog"
        role="dialog"
        aria-label="Relationship types"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h3>Relationship types</h3>
        <ul className="types-list">
          {types.map((t, i) => (
            <li key={t.id}>
              <input
                type="color"
                aria-label={`Colour for ${t.label}`}
                value={t.colour}
                onChange={(e) => change(i, { colour: e.target.value })}
              />
              <input
                aria-label="Type name"
                value={t.label}
                onChange={(e) => change(i, { label: e.target.value })}
              />
              {!builtIn.has(t.id) && (
                <button
                  className="icon"
                  aria-label={`Remove ${t.label}`}
                  disabled={used.has(t.id)}
                  title={used.has(t.id) ? 'Some links use this type' : 'Remove this type'}
                  onClick={() => setTypes(types.filter((x) => x.id !== t.id))}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        <button className="link" onClick={add}>
          + Add a type
        </button>
        <p className="muted small">
          Pick colours that are easy to tell apart: lines with several types show each colour in its
          own band.
        </p>
        {error && <p className="error small">{error}</p>}
        <div className="dialog-choices">
          <button className="primary" onClick={() => void save()}>
            Save
          </button>
          <button onClick={props.onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
