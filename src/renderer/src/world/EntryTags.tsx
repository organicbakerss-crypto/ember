import { useState, type KeyboardEvent } from 'react'
import type { WorldEntryFile } from '@shared/schema'

/** The entry's tags: click one to list every entry with it; add with Enter. */
export function EntryTags(props: {
  entry: WorldEntryFile
  /** Every tag used in this world (for suggestions). */
  allTags: string[]
  onChange: (tags: string[], label: string) => void
  onShowTag?: (tag: string) => void
}) {
  const { entry } = props
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    const tag = (draft ?? '').trim().replace(/^#/, '').slice(0, 60)
    setDraft(null)
    if (!tag || entry.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return
    props.onChange([...entry.tags, tag], `Tagged ${entry.name} “${tag}”`)
  }
  const listId = `tags-${entry.id}`
  return (
    <div className="entry-tags small" aria-label="Tags">
      {entry.tags.map((t) => (
        <span key={t} className="chip tag-chip">
          <button
            className="link"
            title={`Every entry tagged “${t}”`}
            onClick={() => props.onShowTag?.(t)}
          >
            #{t}
          </button>
          <button
            className="icon"
            aria-label={`Remove the tag ${t}`}
            onClick={() =>
              props.onChange(
                entry.tags.filter((x) => x !== t),
                `Removed the tag “${t}” from ${entry.name}`,
              )
            }
          >
            ✕
          </button>
        </span>
      ))}
      {draft === null ? (
        <button className="link small" onClick={() => setDraft('')}>
          + tag
        </button>
      ) : (
        <>
          <input
            className="chip-input"
            aria-label="Add a tag"
            autoFocus
            list={listId}
            placeholder="e.g. noble houses"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault()
                commit()
              }
              if (e.key === 'Escape') setDraft(null)
            }}
            onBlur={commit}
          />
          <datalist id={listId}>
            {props.allTags
              .filter((t) => !entry.tags.includes(t))
              .map((t) => (
                <option key={t} value={t} />
              ))}
          </datalist>
        </>
      )}
    </div>
  )
}
