import { useEffect, useMemo, useRef, useState } from 'react'
import type { EntrySummary } from '@shared/ipc'
import type { Lens } from '@shared/world/templates'
import { lensOf, templateName } from './model'
import type { WorldData } from './useWorld'

/**
 * Search the world's entries by name or alias. Used for link fields, `@`
 * links, merging and filing. Can offer to create a new entry with the text typed.
 */
export function EntryPicker(props: {
  world: WorldData
  /** Prefer entries from these lenses (others still match). */
  lenses?: Lens[]
  exclude?: string[]
  initialQuery?: string
  /** Controlled query (the `@` picker types into the page, not here). */
  query?: string
  placeholder?: string
  onPick: (entry: EntrySummary) => void
  onCreate?: (name: string) => void
  onCancel: () => void
  autoFocus?: boolean
}) {
  const { world } = props
  const [ownQuery, setQuery] = useState(props.initialQuery ?? '')
  const query = props.query ?? ownQuery
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const excluded = new Set(props.exclude ?? [])
    const scored = world.view.entries
      .filter((e) => !excluded.has(e.id))
      .map((e) => {
        const names = [e.name, ...e.aliases].map((n) => n.toLowerCase())
        const score = !q
          ? 1
          : names.some((n) => n.startsWith(q))
            ? 3
            : names.some((n) => n.split(/\s+/).some((w) => w.startsWith(q)))
              ? 2
              : names.some((n) => n.includes(q))
                ? 1
                : 0
        const preferred = !props.lenses || props.lenses.includes(lensOf(world, e)) ? 1 : 0
        return { e, score: score ? score * 2 + preferred : 0 }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
    return scored.slice(0, 30).map((x) => x.e)
  }, [world, query, props.exclude, props.lenses])

  const exact = matches.some((e) => e.name.toLowerCase() === query.trim().toLowerCase())
  const canCreate = !!props.onCreate && query.trim().length > 0 && !exact
  const count = matches.length + (canCreate ? 1 : 0)
  const safeActive = Math.min(active, Math.max(0, count - 1))

  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' })
  }, [safeActive])

  const choose = (i: number) => {
    const entry = matches[i]
    if (entry) props.onPick(entry)
    else if (canCreate) props.onCreate!(query.trim())
  }

  const onKeyDown = (e: React.KeyboardEvent | KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((a) => Math.min(count - 1, a + 1))
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
    else if (e.key === 'Enter') choose(safeActive)
    else if (e.key === 'Escape') props.onCancel()
    else return false
    e.preventDefault()
    return true
  }
  // When the query is typed elsewhere (the page), listen for the arrow keys there too.
  const keyRef = useRef(onKeyDown)
  useEffect(() => {
    keyRef.current = onKeyDown
  })
  useEffect(() => {
    if (props.query === undefined) return
    const handler = (e: KeyboardEvent) => {
      if (keyRef.current(e)) e.stopPropagation()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [props.query])

  return (
    <div className="entry-picker" onMouseDown={(e) => e.stopPropagation()}>
      {props.query === undefined && (
        <input
          autoFocus={props.autoFocus ?? true}
          aria-label="Search the world"
          placeholder={props.placeholder ?? 'Search the world…'}
          value={ownQuery}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => onKeyDown(e)}
        />
      )}
      <ul ref={list} role="listbox" aria-label="Entries">
        {matches.map((e, i) => (
          <li
            key={e.id}
            role="option"
            aria-selected={i === safeActive}
            className={i === safeActive ? 'active' : ''}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(i)}
          >
            <span>{e.name}</span>
            <span className="muted small">{templateName(world, e.template)}</span>
          </li>
        ))}
        {canCreate && (
          <li
            role="option"
            aria-selected={safeActive === matches.length}
            className={safeActive === matches.length ? 'active' : ''}
            onMouseEnter={() => setActive(matches.length)}
            onClick={() => choose(matches.length)}
          >
            <span>Create “{query.trim()}”</span>
          </li>
        )}
        {count === 0 && <li className="muted small">No matches</li>}
      </ul>
    </div>
  )
}
