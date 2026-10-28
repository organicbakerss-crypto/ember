import { useState, type FormEvent } from 'react'
import type { SeriesSummary, WorldView } from '@shared/ipc'
import { api, describeError } from '../api'

/**
 * Quick add: turn a name selected in a chapter into a stub entry in the
 * series' world. If the series has no world yet, offers to make one.
 */
export function QuickAddDialog(props: {
  series: SeriesSummary
  world: WorldView | null
  name: string
  onDone: (created?: { entryId: string; name: string; category: string | null }) => void
}) {
  const { series } = props
  const [world, setWorld] = useState(props.world)
  const [name, setName] = useState(props.name)
  const [categoryId, setCategoryId] = useState<string>(() => {
    const categories = props.world?.world.categories ?? []
    return (
      (categories.find((c) => /character|people|cast/i.test(c.name)) ?? categories[0])?.id ?? ''
    )
  })
  const [error, setError] = useState<string | null>(null)

  const makeWorld = async () => {
    try {
      const created = await api.invoke('world:create', { name: `${series.name} world` })
      await api.invoke('series:setWorld', { seriesId: series.id, worldId: created.id })
      setWorld({ world: created, entries: [] })
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!world) return
    try {
      const entry = await api.invoke('entry:create', {
        worldId: world.world.id,
        name,
        categoryId: categoryId || null,
      })
      props.onDone({
        entryId: entry.id,
        name: entry.name,
        category: world.world.categories.find((c) => c.id === categoryId)?.name ?? null,
      })
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  const existing = world?.entries.find(
    (e) => e.name === name.trim() || e.aliases.includes(name.trim()),
  )

  return (
    <div className="modal-backdrop" onMouseDown={() => props.onDone()}>
      <form
        className="card stack dialog"
        role="dialog"
        aria-label="Add to world"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => e.key === 'Escape' && props.onDone()}
      >
        <h3>Add to the world</h3>
        {!world ? (
          <>
            <p className="muted">“{series.name}” isn’t linked to a world yet.</p>
            <button type="button" className="primary" onClick={() => void makeWorld()}>
              Create “{series.name} world”
            </button>
          </>
        ) : (
          <>
            <label>
              Name
              <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Category in {world.world.name}
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">No category</option>
                {world.world.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            {existing && (
              <p className="warning small">“{existing.name}” is already in this world.</p>
            )}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="dialog-choices">
          {world && (
            <button className="primary" type="submit">
              Add
            </button>
          )}
          <button type="button" onClick={() => props.onDone()}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  )
}
