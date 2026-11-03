import { useState, type FormEvent } from 'react'
import type { IpcInput } from '@shared/ipc'
import type { WorldFile } from '@shared/schema'
import { api, describeError } from '../api'

type WorldChoice = 'none' | 'new' | string

/**
 * New story: a single book or a series, and the world it uses, if any (none
 * by default; one can be linked or made later).
 */
export function NewSeriesForm(props: {
  worlds: WorldFile[]
  onDone: (created?: { seriesId: string; volumeId?: string }) => void
}) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'book' | 'series'>('book')
  const [world, setWorld] = useState<WorldChoice>('none')
  const [worldName, setWorldName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    let choice: IpcInput<'series:create'>['world']
    if (world === 'none') choice = { mode: 'none' }
    else if (world === 'new') choice = { mode: 'new', name: worldName || `${name} world` }
    else choice = { mode: 'existing', worldId: world }
    try {
      const series = await api.invoke('series:create', { name, world: choice, kind })
      props.onDone({ seriesId: series.id, volumeId: series.volumeOrder[0] })
    } catch (err) {
      setError(describeError(err).message)
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)}>
      <h3>New story</h3>
      <div className="segmented" role="radiogroup" aria-label="Kind">
        {(
          [
            ['book', 'A single book'],
            ['series', 'A series'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            className={kind === value ? 'active' : ''}
            onClick={() => setKind(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="muted small">
        {kind === 'book'
          ? 'A novel, a short story or a collection. It can become a series later.'
          : 'Several books (volumes) that belong together.'}
      </p>
      <label>
        Name
        <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        World
        <select value={world} onChange={(e) => setWorld(e.target.value)}>
          <option value="none">No world</option>
          <option value="new">Create a new world</option>
          {props.worlds.map((w) => (
            <option key={w.id} value={w.id}>
              Use {w.name}
            </option>
          ))}
        </select>
      </label>
      {world === 'none' && (
        <p className="muted small">
          You can link or make a world any time (right-click the story on the shelf).
        </p>
      )}
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
