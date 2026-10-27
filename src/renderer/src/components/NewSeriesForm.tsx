import { useState, type FormEvent } from 'react'
import type { IpcInput } from '@shared/ipc'
import type { WorldFile } from '@shared/schema'
import { api, describeError } from '../api'

type WorldChoice = 'none' | 'new' | string

/** New story flow: name the series, then connect it to a world (existing, new, or none). */
export function NewSeriesForm(props: { worlds: WorldFile[]; onDone: (seriesId?: string) => void }) {
  const [name, setName] = useState('')
  const [world, setWorld] = useState<WorldChoice>('new')
  const [worldName, setWorldName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    let choice: IpcInput<'series:create'>['world']
    if (world === 'none') choice = { mode: 'none' }
    else if (world === 'new') choice = { mode: 'new', name: worldName || `${name} world` }
    else choice = { mode: 'existing', worldId: world }
    try {
      const series = await api.invoke('series:create', { name, world: choice })
      props.onDone(series.id)
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h3>New series</h3>
      <label>
        Name
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        World
        <select value={world} onChange={(e) => setWorld(e.target.value)}>
          <option value="new">Create a new world</option>
          {props.worlds.map((w) => (
            <option key={w.id} value={w.id}>
              Use {w.name}
            </option>
          ))}
          <option value="none">Skip for now</option>
        </select>
      </label>
      {world === 'new' && (
        <label>
          World name
          <input
            value={worldName}
            placeholder={name ? `${name} world` : 'World name'}
            onChange={(e) => setWorldName(e.target.value)}
          />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="primary" type="submit">
          Create
        </button>
        <button type="button" onClick={() => props.onDone()}>
          Cancel
        </button>
      </div>
    </form>
  )
}
