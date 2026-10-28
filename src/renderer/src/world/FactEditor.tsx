import { useState } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { FactAnchor, FactValue, TemplateField } from '@shared/schema'
import { newId } from '@shared/ids'
import { chapterName } from '@shared/world/story'
import { DEFAULT_TEMPLATE, type Lens } from '@shared/world/templates'
import { EntryPicker } from './EntryPicker'
import { lensOf } from './model'
import type { WorldData } from './useWorld'

/** Which lens a link field points into, to rank the picker and create the right kind of entry. */
const LINK_LENS: Record<string, Lens> = {
  within: 'where',
  location: 'where',
  home: 'where',
  territory: 'where',
  where: 'where',
  worksIn: 'where',
  ruledBy: 'who',
  memberOf: 'who',
  leader: 'who',
  involved: 'who',
  usedBy: 'who',
  era: 'when',
}
const CREATE_TEMPLATE: Record<string, string> = {
  memberOf: 'faction',
  era: 'era',
  ruledBy: 'person',
}

export function linkLens(field: TemplateField): Lens | undefined {
  return LINK_LENS[field.id]
}

function anchorKey(anchor: FactAnchor | null): string {
  if (!anchor) return ''
  return anchor.kind === 'chapter' ? `c:${anchor.chapterId}` : `e:${anchor.entryId}`
}

function anchorFromKey(key: string): FactAnchor | null {
  if (key.startsWith('c:')) return { kind: 'chapter', chapterId: key.slice(2) }
  if (key.startsWith('e:')) return { kind: 'event', entryId: key.slice(2) }
  return null
}

/**
 * Edits one field of an entry: its value, or its values over time. Each value
 * can say when it starts ("from Ch 8", "from the Flood").
 */
export function FactEditor(props: {
  world: WorldData
  entryId: string
  field: TemplateField
  values: FactValue[]
  /** New values start from this chapter (the one being written), if any. */
  defaultFrom?: string | null
  onSave: (values: FactValue[]) => void
  onCancel: () => void
  onCreateEntry: (name: string, template: string) => Promise<EntrySummary | null>
}) {
  const { world, field } = props
  const blank = (from: FactAnchor | null = null): FactValue => ({
    id: newId('fact'),
    from,
    ...(field.kind === 'text' ? { text: '' } : {}),
  })
  const [values, setValues] = useState<FactValue[]>(() =>
    props.values.length ? props.values : [blank()],
  )
  const [picking, setPicking] = useState<string | null>(() =>
    field.kind === 'link' && !props.values.length ? (values[0]?.id ?? null) : null,
  )
  const chapters = world.index?.chapters ?? []
  const events = world.view.entries.filter(
    (e) => lensOf(world, e) === 'when' && e.id !== props.entryId,
  )

  const update = (id: string, change: Partial<FactValue>) =>
    setValues((list) => list.map((v) => (v.id === id ? { ...v, ...change } : v)))
  const remove = (id: string) => setValues((list) => list.filter((v) => v.id !== id))
  const add = () => {
    const from: FactAnchor | null =
      values.length && props.defaultFrom ? { kind: 'chapter', chapterId: props.defaultFrom } : null
    const value = blank(from)
    setValues((list) => [...list, value])
    if (field.kind === 'link') setPicking(value.id)
  }
  const lens = linkLens(field)

  const save = () =>
    props.onSave(values.filter((v) => (field.kind === 'link' ? !!v.link : !!v.text?.trim())))

  return (
    <div
      className="fact-editor card"
      role="group"
      aria-label={`Edit ${field.label}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !picking) props.onCancel()
      }}
    >
      <div className="fact-editor-head">
        <strong>{field.label}</strong>
        <span className="muted small">
          {field.multiple
            ? 'Several at once. Each can start later in the story.'
            : 'One at a time. Add a change to record when it becomes different.'}
        </span>
      </div>
      {values.map((v, i) => (
        <div key={v.id} className="fact-row">
          {field.kind === 'text' ? (
            <input
              autoFocus={i === values.length - 1}
              aria-label={`${field.label} value`}
              value={v.text ?? ''}
              placeholder={field.label}
              onChange={(e) => update(v.id, { text: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          ) : picking === v.id ? (
            <EntryPicker
              world={world}
              lenses={lens ? [lens] : undefined}
              exclude={[props.entryId]}
              placeholder={`Link ${field.label.toLowerCase()}…`}
              onPick={(entry) => {
                update(v.id, { link: entry.id })
                setPicking(null)
              }}
              onCreate={async (name) => {
                const created = await props.onCreateEntry(
                  name,
                  CREATE_TEMPLATE[field.id] ?? DEFAULT_TEMPLATE[lens ?? 'who'],
                )
                if (created) update(v.id, { link: created.id })
                setPicking(null)
              }}
              onCancel={() => {
                setPicking(null)
                if (!v.link) remove(v.id)
              }}
            />
          ) : (
            <button className="fact-link" onClick={() => setPicking(v.id)} title="Change">
              {v.link ? (world.resolve(v.link)?.name ?? '(missing entry)') : 'Choose…'}
            </button>
          )}
          <select
            aria-label="Starting when"
            value={anchorKey(v.from)}
            onChange={(e) => update(v.id, { from: anchorFromKey(e.target.value) })}
          >
            <option value="">From the start</option>
            {chapters.length > 0 && (
              <optgroup label="From a chapter">
                {chapters.map((c) => (
                  <option key={c.id} value={`c:${c.id}`}>
                    From {chapterName(c)}
                  </option>
                ))}
              </optgroup>
            )}
            {events.length > 0 && (
              <optgroup label="From an event">
                {events.map((e) => (
                  <option key={e.id} value={`e:${e.id}`}>
                    From {e.name}
                  </option>
                ))}
              </optgroup>
            )}
            {v.from && !chapters.length && !events.length && (
              <option value={anchorKey(v.from)}>From somewhere not in the story</option>
            )}
          </select>
          <button className="icon" aria-label="Remove this value" onClick={() => remove(v.id)}>
            ✕
          </button>
        </div>
      ))}
      <div className="row">
        <button className="link small" onClick={add}>
          {field.multiple ? '+ Add another' : values.length ? '+ Changes later…' : '+ Add'}
        </button>
        <span className="status-spacer" />
        <button onClick={props.onCancel}>Cancel</button>
        <button className="primary" onClick={save}>
          Done
        </button>
      </div>
    </div>
  )
}
