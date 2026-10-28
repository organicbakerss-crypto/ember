import type { EntrySummary } from '@shared/ipc'
import { Portrait } from '../Portrait'
import type { WorldData } from '../useWorld'
import { unplacedPeople } from './mapModel'

/** People with no location wait at the edge of the map; drag one onto a place to put them there. */
export function UnplacedTray(props: { world: WorldData; onOpenEntry: (entryId: string) => void }) {
  const people: EntrySummary[] = unplacedPeople(props.world)
  return (
    <aside className="unplaced-tray" aria-label="Unplaced">
      <h3 className="panel-heading small muted">Unplaced</h3>
      {people.length === 0 ? (
        <p className="muted small">Everyone has a place.</p>
      ) : (
        <>
          <p className="muted small">Drag someone onto a place.</p>
          <ul>
            {people.map((p) => (
              <li
                key={p.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/x-entry', p.id)
                  e.dataTransfer.effectAllowed = 'link'
                }}
                onDoubleClick={() => props.onOpenEntry(p.id)}
                title={`${p.name}: drag onto a place (double-click to open)`}
              >
                <Portrait
                  worldId={props.world.view.world.id}
                  name={p.name}
                  portrait={p.portrait}
                  size="small"
                />
                <span>{p.name}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}
