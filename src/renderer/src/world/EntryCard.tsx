import type { EntrySummary } from '@shared/ipc'
import type { Moment } from '@shared/world/facts'
import { MAX_QUICK_FACTS, shownFacts, templateName, valueLabel } from './model'
import { Portrait } from './Portrait'
import type { WorldData } from './useWorld'

/**
 * The same card everywhere (hover cards, the side panel, lists): portrait,
 * name, type and quick facts as of a moment in the story.
 */
export function EntryCard(props: {
  world: WorldData
  entry: EntrySummary
  at: Moment
  onOpenEntry?: (entryId: string) => void
  /** Shown under the facts (e.g. "Last seen: Ch 4"). */
  footnote?: string
}) {
  const { world, entry } = props
  const facts = shownFacts(world, entry, props.at, true).slice(0, MAX_QUICK_FACTS)
  return (
    <div className="entry-card">
      <div className="entry-card-head">
        <Portrait worldId={world.view.world.id} name={entry.name} portrait={entry.portrait} />
        <div>
          <strong>{entry.name}</strong>
          <div className="muted small">
            {templateName(world, entry.template)}
            {entry.aliases.length > 0 && ` · also ${entry.aliases.join(', ')}`}
          </div>
        </div>
      </div>
      {facts.length > 0 && (
        <dl className="quick-facts small">
          {facts.map(({ field, values }) => (
            <div key={field.id}>
              <dt>{field.label}</dt>
              <dd>
                {values.map((v, i) => (
                  <span key={v.id}>
                    {i > 0 && ', '}
                    {v.link && props.onOpenEntry && world.resolve(v.link) ? (
                      <button className="link" onClick={() => props.onOpenEntry!(v.link!)}>
                        {valueLabel(world, v)}
                      </button>
                    ) : (
                      valueLabel(world, v)
                    )}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {entry.snippet ? (
        <p className="small entry-card-snippet">{entry.snippet}</p>
      ) : (
        facts.length === 0 && <p className="muted small">Nothing written yet.</p>
      )}
      {props.footnote && <p className="muted small">{props.footnote}</p>}
    </div>
  )
}
