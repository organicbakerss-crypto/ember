import { useState } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { FactValue, TemplateField } from '@shared/schema'
import { lastSeen, presence } from '@shared/world/story'
import { currentValue } from '@shared/world/facts'
import { api, describeError } from '../api'
import { useOverlays } from '../components/overlays'
import { useSettings } from '../useTheme'
import { EntryCard } from './EntryCard'
import { FactEditor } from './FactEditor'
import { lensOf, templateOf, valueLabel } from './model'
import { Portrait } from './Portrait'
import type { UndoStep } from './useUndo'
import type { WorldData } from './useWorld'
import type { WorldActions } from './useWorldActions'

export interface ChapterMention {
  entry: EntrySummary
  count: number
}

const GROUPS: { label: string; lenses: string[] }[] = [
  { label: 'People and groups', lenses: ['who'] },
  { label: 'Places', lenses: ['where'] },
  { label: 'Events and systems', lenses: ['when', 'how'] },
]

/**
 * The world beside the page. "In this chapter" lists who and what the
 * chapter mentions (click one for its card, add a fact without leaving the
 * page); "Waiting and gone quiet" lists characters due to enter or not seen
 * for a while.
 */
export function WorldPanel(props: {
  world: WorldData
  /** Entries mentioned in the chapter being written, most mentioned first. */
  mentions: ChapterMention[]
  povEntryId: string | null
  chapterId: string | null
  /** Position of the chapter in the story (facts are shown as of it). */
  at: number | null
  actions: WorldActions
  record: (step: UndoStep) => void
  onOpenEntry: (entryId: string) => void
}) {
  const { world } = props
  const [tab, setTab] = useState<'chapter' | 'waiting'>('chapter')
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ entry: EntrySummary; field: TemplateField } | null>(null)
  const { settings } = useSettings()
  const { openMenu, toast } = useOverlays()

  const pov = props.povEntryId ? world.resolve(props.povEntryId) : undefined
  const mentioned = props.mentions.filter((m) => m.entry.id !== pov?.id)

  const saveFact = async (entry: EntrySummary, field: TemplateField, values: FactValue[]) => {
    setEditing(null)
    const worldId = world.view.world.id
    const before = entry.facts
    const facts = { ...entry.facts }
    if (values.length) facts[field.id] = values
    else delete facts[field.id]
    try {
      await api.invoke('entry:save', { worldId, entryId: entry.id, patch: { facts } })
      props.record({
        label: `Changed ${field.label.toLowerCase()} of ${entry.name}`,
        undo: () =>
          api.invoke('entry:save', { worldId, entryId: entry.id, patch: { facts: before } }),
      })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const row = (entry: EntrySummary, note: string) => (
    <li key={entry.id} className={`world-panel-item ${open === entry.id ? 'open' : ''}`}>
      <button
        className="world-nav-item"
        aria-expanded={open === entry.id}
        onClick={() => setOpen(open === entry.id ? null : entry.id)}
      >
        <Portrait
          worldId={world.view.world.id}
          name={entry.name}
          portrait={entry.portrait}
          size="small"
        />
        <span className="world-nav-label">{entry.name}</span>
        <span className="muted small">{note}</span>
      </button>
      {open === entry.id && (
        <div className="world-panel-card">
          <EntryCard world={world} entry={entry} at={props.at} onOpenEntry={props.onOpenEntry} />
          <div className="row small">
            <button
              className="link"
              onClick={(e) =>
                openMenu(
                  e,
                  templateOf(world, entry).fields.map((field) => ({
                    label: field.label,
                    onSelect: () => setEditing({ entry, field }),
                  })),
                )
              }
            >
              + Add a fact
            </button>
            <span className="status-spacer" />
            <button className="link" onClick={() => props.onOpenEntry(entry.id)}>
              Open page
            </button>
          </div>
          {editing?.entry.id === entry.id && (
            <FactEditor
              world={world}
              entryId={entry.id}
              field={editing.field}
              values={entry.facts[editing.field.id] ?? []}
              defaultFrom={props.chapterId}
              onSave={(values) => void saveFact(entry, editing.field, values)}
              onCancel={() => setEditing(null)}
              onCreateEntry={async (name, template) => {
                const created = await props.actions.create(name, template)
                return created && { ...created, snippet: '', links: [] }
              }}
            />
          )}
        </div>
      )}
    </li>
  )

  // Waiting in the wings and gone quiet: people only, from certain data.
  const index = world.index
  const quietAfter = settings.world.quietAfter
  const people = world.view.entries.filter((e) => lensOf(world, e) === 'who')
  const states = index
    ? people.map((e) => ({
        e,
        state: presence(e.facts, index.mentions[e.id], index, quietAfter, world.positions),
      }))
    : []
  const waiting = states.filter((s) => s.state === 'waiting').map((s) => s.e)
  const quiet = states
    .filter((s) => s.state === 'quiet')
    .map((s) => s.e)
    .sort((a, b) => (lastSeen(index?.mentions[a.id]) ?? 0) - (lastSeen(index?.mentions[b.id]) ?? 0))

  return (
    <div className="world-panel-tabs">
      <div className="segmented" role="tablist" aria-label="World">
        <button
          role="tab"
          aria-selected={tab === 'chapter'}
          className={tab === 'chapter' ? 'active' : ''}
          onClick={() => setTab('chapter')}
        >
          In this chapter
        </button>
        <button
          role="tab"
          aria-selected={tab === 'waiting'}
          className={tab === 'waiting' ? 'active' : ''}
          onClick={() => setTab('waiting')}
        >
          Waiting and gone quiet
        </button>
      </div>

      {tab === 'chapter' ? (
        <>
          {pov && (
            <section aria-label="Point of view">
              <h3 className="panel-heading small muted">Point of view</h3>
              <ul className="world-side-list">{row(pov, '')}</ul>
            </section>
          )}
          {GROUPS.map((g) => {
            const list = mentioned.filter((m) => g.lenses.includes(lensOf(world, m.entry)))
            if (!list.length) return null
            return (
              <section key={g.label} aria-label={g.label}>
                <h3 className="panel-heading small muted">{g.label}</h3>
                <ul className="world-side-list">{list.map((m) => row(m.entry, `${m.count}×`))}</ul>
              </section>
            )
          })}
          {!pov && !mentioned.length && (
            <p className="muted small">
              No one from the world is named in this chapter yet. Select a name and right-click to
              add it.
            </p>
          )}
        </>
      ) : (
        <>
          <section aria-label="Waiting in the wings">
            <h3 className="panel-heading small muted">Waiting in the wings</h3>
            {waiting.length ? (
              <ul className="world-side-list">
                {waiting.map((e) => {
                  const enters = currentValue(e.facts['enters'], null, world.positions)
                  return row(e, enters ? `enters ${valueLabel(world, enters)}` : 'not yet in')
                })}
              </ul>
            ) : (
              <p className="muted small">Everyone has appeared.</p>
            )}
          </section>
          <section aria-label="Gone quiet">
            <h3 className="panel-heading small muted">
              Gone quiet (not in the last {quietAfter} chapters)
            </h3>
            {quiet.length ? (
              <ul className="world-side-list">
                {quiet.map((e) => {
                  const last = lastSeen(index?.mentions[e.id])
                  return row(e, last === null ? '' : `last ${index?.chapters[last]?.label}`)
                })}
              </ul>
            ) : (
              <p className="muted small">No one has gone quiet.</p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
