import { useState } from 'react'
import type { FactAnchor, RelationshipFile } from '@shared/schema'
import { chapterName } from '@shared/world/story'
import { EntryPicker } from '../EntryPicker'
import { lensOf } from '../model'
import { anchorOf } from '@shared/world/timeline'
import { useTime } from '../time/TimeContext'
import type { WorldData } from '../useWorld'
import type { RelationshipDraft } from './useRelationships'

type Kin = 'parentOf' | 'childOf' | 'sibling' | 'partner'

const anchorKey = (a: FactAnchor | null) =>
  !a ? '' : a.kind === 'chapter' ? `c:${a.chapterId}` : `e:${a.entryId}`
const anchorFrom = (key: string): FactAnchor | null =>
  key.startsWith('c:')
    ? { kind: 'chapter', chapterId: key.slice(2) }
    : key.startsWith('e:')
      ? { kind: 'event', entryId: key.slice(2) }
      : null

/**
 * Says how two entries are linked: the type (coloured as on the board),
 * optional words ("sister of"), for family whether one is the other's
 * parent, siblings or partners, whether it's over, and when it starts and ends.
 */
export function RelationshipEditor(props: {
  world: WorldData
  /** Start from a relationship (editing), or from two entries (new). */
  relationship?: RelationshipFile
  from?: string
  to?: string
  onSave: (draft: RelationshipDraft) => void
  onDelete?: () => void
  onCancel: () => void
}) {
  const { world, relationship: rel } = props
  const [from, setFrom] = useState(rel?.from ?? props.from ?? '')
  const [to, setTo] = useState(rel?.to ?? props.to ?? '')
  const [type, setType] = useState(rel?.type ?? 'friends')
  const [label, setLabel] = useState(rel?.label ?? '')
  const [kin, setKin] = useState<Kin>(
    rel?.kin === 'parent' ? 'parentOf' : rel?.kin === 'partner' ? 'partner' : 'sibling',
  )
  const [over, setOver] = useState(rel?.over ?? false)
  // A new link made with the scrubber at a moment starts there.
  const { stop } = useTime()
  const [start, setStart] = useState(anchorKey(rel ? rel.start : stop && anchorOf(stop)))
  const [end, setEnd] = useState(anchorKey(rel?.end ?? null))
  const chapters = world.index?.chapters ?? []
  const events = world.view.entries.filter((e) => lensOf(world, e) === 'when')
  const name = (id: string) => world.resolve(id)?.name ?? '…'

  const save = () => {
    if (!from || !to) return
    const swap = type === 'family' && kin === 'childOf'
    props.onSave({
      id: rel?.id,
      from: swap ? to : from,
      to: swap ? from : to,
      type,
      label,
      kin:
        type === 'family'
          ? kin === 'sibling'
            ? 'sibling'
            : kin === 'partner'
              ? 'partner'
              : 'parent'
          : null,
      over: over || !!end,
      start: anchorFrom(start),
      end: anchorFrom(end),
    })
  }

  const when = (value: string, onChange: (v: string) => void, none: string, label: string) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {chapters.length > 0 && (
        <optgroup label="A chapter">
          {chapters.map((c) => (
            <option key={c.id} value={`c:${c.id}`}>
              {chapterName(c)}
            </option>
          ))}
        </optgroup>
      )}
      {events.length > 0 && (
        <optgroup label="An event">
          {events.map((e) => (
            <option key={e.id} value={`e:${e.id}`}>
              {e.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )

  return (
    <div className="modal-backdrop" onMouseDown={props.onCancel}>
      <div
        className="card stack dialog relationship-editor"
        role="dialog"
        aria-label="Relationship"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && props.onCancel()}
      >
        <h3>
          {from && to ? (
            <>
              {name(from)} <span className="muted">and</span> {name(to)}
            </>
          ) : (
            'Link to someone'
          )}
        </h3>
        {(!from || !to) && (
          <EntryPicker
            world={world}
            lenses={['who']}
            exclude={[from || to]}
            placeholder="Who?"
            onPick={(e) => (from ? setTo(e.id) : setFrom(e.id))}
            onCancel={props.onCancel}
          />
        )}
        <div className="type-choices" role="radiogroup" aria-label="Type">
          {world.view.relationshipTypes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={type === t.id}
              className={`type-choice ${type === t.id ? 'active' : ''}`}
              onClick={() => setType(t.id)}
            >
              <span className="swatch" style={{ background: t.colour }} />
              {t.label}
            </button>
          ))}
        </div>
        {type === 'family' && from && to && (
          <div className="kin-choices small" role="radiogroup" aria-label="Family">
            {(
              [
                ['parentOf', `${name(from)} is ${name(to)}’s parent`],
                ['childOf', `${name(to)} is ${name(from)}’s parent`],
                ['sibling', 'Siblings'],
                ['partner', 'Partners'],
              ] as [Kin, string][]
            ).map(([value, text]) => (
              <label key={value} className="radio">
                <input
                  type="radio"
                  name="kin"
                  checked={kin === value}
                  onChange={() => setKin(value)}
                />
                {text}
              </label>
            ))}
          </div>
        )}
        <label>
          In words (optional)
          <input
            value={label}
            placeholder={
              type === 'family'
                ? 'sister of'
                : type === 'mentor'
                  ? 'mentor to'
                  : 'e.g. owes a debt to'
            }
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
          />
        </label>
        <div className="row wrap small">
          <label className="field">
            Starts
            {when(start, setStart, 'From the start', 'Starts')}
          </label>
          <label className="field">
            Ends
            {when(end, setEnd, 'Not ended', 'Ends')}
          </label>
          <label className="radio">
            <input
              type="checkbox"
              checked={over || !!end}
              disabled={!!end}
              onChange={(e) => setOver(e.target.checked)}
            />
            It’s over (shown dashed)
          </label>
        </div>
        <div className="dialog-choices">
          <button className="primary" disabled={!from || !to} onClick={save}>
            {rel ? 'Save' : 'Link'}
          </button>
          {props.onDelete && (
            <button className="danger" onClick={props.onDelete}>
              Remove
            </button>
          )}
          <button onClick={props.onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
