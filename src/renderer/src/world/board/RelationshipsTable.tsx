import { useState } from 'react'
import type { RelationshipFile } from '@shared/schema'
import { chapterName } from '@shared/world/story'
import type { UndoStep } from '../useUndo'
import type { WorldData } from '../useWorld'
import { RelationshipEditor } from './RelationshipEditor'
import { useRelationships } from './useRelationships'

/** The board as a plain sortable list: every relationship, one per row. */
export function RelationshipsTable(props: {
  world: WorldData
  record: (step: UndoStep) => void
  onOpenEntry: (entryId: string) => void
}) {
  const { world } = props
  const relationships = useRelationships(world, props.record)
  const [sort, setSort] = useState<'from' | 'type' | 'to'>('from')
  const [editing, setEditing] = useState<RelationshipFile | null>(null)
  const name = (id: string) => world.resolve(id)?.name ?? '(missing)'
  const type = (id: string) => world.view.relationshipTypes.find((t) => t.id === id)
  const when = (a: RelationshipFile['start']) => {
    if (!a) return ''
    if (a.kind === 'event') return name(a.entryId)
    const at = world.positions.get(a.chapterId)
    return at === undefined ? 'a chapter' : chapterName(world.index!.chapters[at]!)
  }
  const rows = [...world.view.relationships].sort((a, b) =>
    sort === 'type'
      ? (type(a.type)?.label ?? '').localeCompare(type(b.type)?.label ?? '')
      : name(a[sort]).localeCompare(name(b[sort])),
  )
  if (!rows.length) return null
  const head = (key: typeof sort, label: string) => (
    <th aria-sort={sort === key ? 'ascending' : 'none'}>
      <button className="link" onClick={() => setSort(key)}>
        {label}
        {sort === key ? ' ↑' : ''}
      </button>
    </th>
  )
  return (
    <section aria-label="Relationships">
      <h2>Relationships</h2>
      <table className="entry-table small">
        <thead>
          <tr>
            {head('from', 'From')}
            {head('type', 'Type')}
            {head('to', 'To')}
            <th>Words</th>
            <th>When</th>
            <th>Now</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <button className="link" onClick={() => props.onOpenEntry(r.from)}>
                  {name(r.from)}
                </button>
              </td>
              <td>
                <button className="link" onClick={() => setEditing(r)}>
                  <span className="swatch" style={{ background: type(r.type)?.colour }} />
                  {type(r.type)?.label ?? r.type}
                </button>
              </td>
              <td>
                <button className="link" onClick={() => props.onOpenEntry(r.to)}>
                  {name(r.to)}
                </button>
              </td>
              <td>{r.label}</td>
              <td>
                {[r.start && `from ${when(r.start)}`, r.end && `until ${when(r.end)}`]
                  .filter(Boolean)
                  .join(', ')}
              </td>
              <td>{r.over || r.end ? 'Over' : 'Current'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <RelationshipEditor
          world={world}
          relationship={editing}
          onSave={(draft) => void relationships.save(draft).then(() => setEditing(null))}
          onDelete={() => void relationships.remove(editing).then(() => setEditing(null))}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  )
}
