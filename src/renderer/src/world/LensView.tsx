import { useMemo, useState, type ReactNode } from 'react'
import type { EntrySummary } from '@shared/ipc'
import { currentValue, valuesAt } from '@shared/world/facts'
import { lastSeen, presence, PRESENCE_LABELS, type Presence } from '@shared/world/story'
import { LENS_LABELS, type Lens } from '@shared/world/templates'
import { loadLocal, saveLocal } from '../storage'
import { useSettings } from '../useTheme'
import { lensOf, shownFacts, templateName, valueLabel } from './model'
import { Portrait } from './Portrait'
import type { WorldData } from './useWorld'

const PRESENCE_ORDER: Presence[] = ['story', 'waiting', 'quiet', 'left']

/** What each lens shows by default, and its plain list alternative. */
const VISUAL: Record<Lens, string> = {
  where: 'Places',
  who: 'Cast',
  when: 'Eras',
  how: 'Rulebook',
}

const NOUN: Record<Lens, string> = {
  where: 'place',
  who: 'person or group',
  when: 'era or event',
  how: 'system',
}

type Mode = 'map' | 'visual' | 'list'

export function LensView(props: {
  world: WorldData
  lens: Lens
  onOpenEntry: (entryId: string) => void
  onNew: (lens: Lens) => void
  /** The Where lens's map (when maps are on). */
  map?: { exists: boolean; render: () => ReactNode }
}) {
  const { world, lens } = props
  const key = `world.lensMode.${lens}`
  const map = lens === 'where' ? props.map : undefined
  // Where opens on the map once there is one; otherwise on the last view chosen.
  const [mode, setModeState] = useState<Mode>(() => {
    if (map?.exists) return 'map'
    const stored = loadLocal(key)
    return stored === 'list' ? 'list' : stored === 'map' && map ? 'map' : 'visual'
  })
  const setMode = (m: Mode) => {
    setModeState(m)
    saveLocal(key, m)
  }
  const shown: Mode = mode === 'map' && !map ? 'visual' : mode
  const entries = world.view.entries.filter((e) => lensOf(world, e) === lens)
  const modes: { mode: Mode; label: string }[] = [
    ...(map ? [{ mode: 'map' as const, label: 'Map' }] : []),
    { mode: 'visual', label: VISUAL[lens] },
    { mode: 'list', label: 'List' },
  ]

  return (
    <div className={`lens-view ${shown === 'map' ? 'lens-map' : ''}`}>
      <header className="lens-head">
        <h1>{LENS_LABELS[lens]}</h1>
        <div className="segmented" role="radiogroup" aria-label="View">
          {modes.map((m) => (
            <button
              key={m.mode}
              role="radio"
              aria-checked={shown === m.mode}
              className={shown === m.mode ? 'active' : ''}
              onClick={() => setMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="status-spacer" />
        <button className="primary" onClick={() => props.onNew(lens)}>
          + New {NOUN[lens]}
        </button>
      </header>
      {shown === 'map' && map ? (
        map.render()
      ) : entries.length === 0 ? (
        <EmptyLens lens={lens} onNew={() => props.onNew(lens)} />
      ) : shown === 'list' ? (
        <EntryTable world={world} entries={entries} onOpenEntry={props.onOpenEntry} />
      ) : lens === 'who' ? (
        <CastView world={world} entries={entries} onOpenEntry={props.onOpenEntry} />
      ) : lens === 'where' ? (
        <PlaceTree world={world} entries={entries} onOpenEntry={props.onOpenEntry} />
      ) : lens === 'when' ? (
        <Eras world={world} entries={entries} onOpenEntry={props.onOpenEntry} />
      ) : (
        <Rulebook world={world} entries={entries} onOpenEntry={props.onOpenEntry} />
      )}
    </div>
  )
}

function EmptyLens(props: { lens: Lens; onNew: () => void }) {
  const text: Record<Lens, string> = {
    where: 'No places yet. Continents, kingdoms, cities, districts, landmarks and wilds live here.',
    who: 'No one yet. People, factions, families and creatures live here.',
    when: 'No history yet. Eras and events live here.',
    how: 'No systems yet. Magic, religion, law, technology and customs live here.',
  }
  return (
    <div className="lens-empty">
      <p className="muted">{text[props.lens]}</p>
      <button onClick={props.onNew}>Add the first one</button>
      <p className="muted small">
        Names in your chapters can be added straight from the page: select one, right-click, “Add to
        the world”.
      </p>
    </div>
  )
}

function usePresence(world: WorldData) {
  const { settings } = useSettings()
  const quietAfter = settings.world.quietAfter
  return useMemo(() => {
    const index = world.index ?? { chapters: [], mentions: {} }
    return (e: EntrySummary): Presence =>
      presence(e.facts, index.mentions[e.id], index, quietAfter, world.positions)
  }, [world, quietAfter])
}

/** "Last seen: Ch 4, Gullhaven", or "Enters around: Arc 3" for someone waiting. */
function keyLine(world: WorldData, e: EntrySummary, state: Presence): string {
  const index = world.index
  const last = lastSeen(index?.mentions[e.id])
  if (last === null || !index) {
    const enters = currentValue(e.facts['enters'], null, world.positions)?.text
    return enters ? `Enters around: ${enters}` : 'Not in a chapter yet'
  }
  const where = currentValue(e.facts['location'], last, world.positions)
  const place = where ? `, ${valueLabel(world, where)}` : ''
  return `${state === 'left' ? 'Last seen' : 'Last seen'}: ${index.chapters[last]?.label}${place}`
}

/* ---------- Who: the Cast view ---------- */

type CastKind = 'people' | 'groups' | 'creatures' | 'all'
const KIND_TEMPLATES: Record<Exclude<CastKind, 'all'>, string[]> = {
  people: ['person'],
  groups: ['faction', 'family'],
  creatures: ['creature'],
}

function CastView(props: {
  world: WorldData
  entries: EntrySummary[]
  onOpenEntry: (entryId: string) => void
}) {
  const { world } = props
  const presenceOf = usePresence(world)
  const [kind, setKind] = useState<CastKind>('people')
  const [query, setQuery] = useState('')
  const [faction, setFaction] = useState('')
  const [place, setPlace] = useState('')
  const [povOnly, setPovOnly] = useState(false)
  const [sort, setSort] = useState<'lastSeen' | 'name'>('lastSeen')

  const factions = world.view.entries.filter((e) => ['faction', 'family'].includes(e.template))
  const places = world.view.entries.filter((e) => lensOf(world, e) === 'where')
  const mentions = world.index?.mentions ?? {}
  const q = query.trim().toLowerCase()
  const has = (e: EntrySummary, field: string, id: string) =>
    valuesAt({ multiple: true }, e.facts[field], null, world.positions).some((v) => v.link === id)
  const isCustom = (e: EntrySummary) => !Object.values(KIND_TEMPLATES).flat().includes(e.template)

  const shown = props.entries
    .filter(
      (e) =>
        kind === 'all' ||
        KIND_TEMPLATES[kind].includes(e.template) ||
        (kind === 'people' && isCustom(e)),
    )
    .filter(
      (e) =>
        !q ||
        e.name.toLowerCase().includes(q) ||
        e.aliases.some((a) => a.toLowerCase().includes(q)),
    )
    .filter((e) => !faction || has(e, 'memberOf', faction))
    .filter((e) => !place || has(e, 'location', place) || has(e, 'home', place))
    .filter((e) => !povOnly || (mentions[e.id]?.pov.length ?? 0) > 0)
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : (lastSeen(mentions[b.id]) ?? -1) - (lastSeen(mentions[a.id]) ?? -1) ||
          a.name.localeCompare(b.name),
    )
  const groups = PRESENCE_ORDER.map((p) => ({
    presence: p,
    entries: shown.filter((e) => presenceOf(e) === p),
  })).filter((g) => g.entries.length)

  return (
    <div className="cast">
      <div className="lens-filters small">
        <select
          aria-label="Show"
          value={kind}
          onChange={(e) => setKind(e.target.value as CastKind)}
        >
          <option value="people">People</option>
          <option value="groups">Factions and families</option>
          <option value="creatures">Creatures</option>
          <option value="all">Everyone</option>
        </select>
        <input
          type="search"
          aria-label="Search the cast"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {factions.length > 0 && (
          <select aria-label="Faction" value={faction} onChange={(e) => setFaction(e.target.value)}>
            <option value="">Any faction</option>
            {factions.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
        {places.length > 0 && (
          <select aria-label="Place" value={place} onChange={(e) => setPlace(e.target.value)}>
            <option value="">Anywhere</option>
            {places.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <label className="inline">
          <input type="checkbox" checked={povOnly} onChange={(e) => setPovOnly(e.target.checked)} />
          Point of view
        </label>
        <select
          aria-label="Sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as 'lastSeen' | 'name')}
        >
          <option value="lastSeen">Sort by last seen</option>
          <option value="name">Sort by name</option>
        </select>
      </div>
      {groups.length === 0 && <p className="muted">Nobody matches.</p>}
      {groups.map((g) => (
        <section key={g.presence} className="cast-group" aria-label={PRESENCE_LABELS[g.presence]}>
          <h2>
            {PRESENCE_LABELS[g.presence]} <span className="muted small">{g.entries.length}</span>
          </h2>
          <div className="cast-cards">
            {g.entries.map((e) => {
              const role = currentValue(e.facts['role'], null, world.positions)?.text
              return (
                <button key={e.id} className="cast-card" onClick={() => props.onOpenEntry(e.id)}>
                  <Portrait worldId={world.view.world.id} name={e.name} portrait={e.portrait} />
                  <span className="cast-card-text">
                    <strong>{e.name}</strong>
                    <span className="muted small">{role || templateName(world, e.template)}</span>
                    <span className="small">{keyLine(world, e, g.presence)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

/* ---------- Where: places inside places ---------- */

function PlaceTree(props: {
  world: WorldData
  entries: EntrySummary[]
  onOpenEntry: (entryId: string) => void
}) {
  const { world, entries } = props
  const ids = new Set(entries.map((e) => e.id))
  const parentOf = (e: EntrySummary) => {
    const link = currentValue(e.facts['within'], null, world.positions)?.link
    return link && ids.has(link) && link !== e.id ? link : null
  }
  const children = new Map<string | null, EntrySummary[]>()
  for (const e of entries) {
    const parent = parentOf(e)
    children.set(parent, [...(children.get(parent) ?? []), e])
  }
  // Entries in a "within" loop never reach a root; show them at the top too.
  const reached = new Set<string>()
  const walk = (id: string | null) =>
    (children.get(id) ?? []).forEach((c) => {
      if (reached.has(c.id)) return
      reached.add(c.id)
      walk(c.id)
    })
  walk(null)
  const roots = [...(children.get(null) ?? []), ...entries.filter((e) => !reached.has(e.id))]
  const people = (placeId: string) =>
    world.view.entries.filter((p) =>
      valuesAt({ multiple: false }, p.facts['location'], null, world.positions).some(
        (v) => v.link === placeId,
      ),
    )

  const render = (list: EntrySummary[], seen: Set<string>): ReactNode => (
    <ul className="place-tree">
      {[...list]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          if (seen.has(e.id)) return null
          const next = new Set(seen).add(e.id)
          const here = people(e.id)
          return (
            <li key={e.id}>
              <button className="link" onClick={() => props.onOpenEntry(e.id)}>
                {e.name}
              </button>{' '}
              <span className="muted small">
                {templateName(world, e.template)}
                {here.length > 0 && ` · ${here.map((p) => p.name).join(', ')} here`}
              </span>
              {children.get(e.id) && render(children.get(e.id)!, next)}
            </li>
          )
        })}
    </ul>
  )
  return (
    <div className="places">
      <p className="muted small">Places inside places (by “Within”).</p>
      {render(roots, new Set())}
    </div>
  )
}

/* ---------- When: eras and their events ---------- */

function Eras(props: {
  world: WorldData
  entries: EntrySummary[]
  onOpenEntry: (entryId: string) => void
}) {
  const { world, entries } = props
  const eraOf = (e: EntrySummary) => currentValue(e.facts['era'], null, world.positions)?.link
  const eras = entries.filter((e) => e.template === 'era')
  const byEra = (id: string | undefined) =>
    entries
      .filter(
        (e) =>
          e.template !== 'era' && (id ? eraOf(e) === id : !eras.some((x) => x.id === eraOf(e))),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
  const line = (e: EntrySummary) =>
    shownFacts(world, e, null, true)
      .filter((f) => f.field.id !== 'era')
      .map((f) => `${f.field.label}: ${f.values.map((v) => valueLabel(world, v)).join(', ')}`)
      .join(' · ')
  const item = (e: EntrySummary) => (
    <li key={e.id}>
      <button className="link" onClick={() => props.onOpenEntry(e.id)}>
        {e.name}
      </button>{' '}
      <span className="muted small">{line(e)}</span>
    </li>
  )
  const loose = byEra(undefined)
  return (
    <div className="eras">
      {eras.map((era) => (
        <section key={era.id} className="era">
          <h2>
            <button className="link" onClick={() => props.onOpenEntry(era.id)}>
              {era.name}
            </button>
          </h2>
          {era.snippet && <p className="muted small">{era.snippet}</p>}
          <ul>{byEra(era.id).map(item)}</ul>
        </section>
      ))}
      {loose.length > 0 && (
        <section className="era">
          <h2>{eras.length ? 'Not in an era' : 'Events'}</h2>
          <ul>{loose.map(item)}</ul>
        </section>
      )}
      <p className="muted small">The time scrubber and timeline come in a later step.</p>
    </div>
  )
}

/* ---------- How: the rulebook ---------- */

function Rulebook(props: {
  world: WorldData
  entries: EntrySummary[]
  onOpenEntry: (entryId: string) => void
}) {
  const { world } = props
  return (
    <div className="rulebook">
      {[...props.entries]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => {
          const rules = valuesAt({ multiple: true }, e.facts['rules'], null, world.positions)
          const facts = shownFacts(world, e, null).filter((f) => f.field.id !== 'rules')
          return (
            <article key={e.id} className="rule-page">
              <h2>
                <button className="link" onClick={() => props.onOpenEntry(e.id)}>
                  {e.name}
                </button>{' '}
                <span className="muted small">{templateName(world, e.template)}</span>
              </h2>
              {rules.length > 0 ? (
                <ol>
                  {rules.map((r) => (
                    <li key={r.id}>{r.text}</li>
                  ))}
                </ol>
              ) : (
                <p className="muted small">No rules written yet.</p>
              )}
              {facts.length > 0 && (
                <p className="small">
                  {facts
                    .map(
                      (f) =>
                        `${f.field.label}: ${f.values.map((v) => valueLabel(world, v)).join(', ')}`,
                    )
                    .join(' · ')}
                </p>
              )}
            </article>
          )
        })}
    </div>
  )
}

/* ---------- every lens: a plain sortable list ---------- */

type Column = 'name' | 'type' | 'facts' | 'presence' | 'mentions' | 'lastSeen'

function EntryTable(props: {
  world: WorldData
  entries: EntrySummary[]
  onOpenEntry: (entryId: string) => void
}) {
  const { world } = props
  const presenceOf = usePresence(world)
  const [sort, setSort] = useState<{ by: Column; desc: boolean }>({ by: 'name', desc: false })
  const mentions = world.index?.mentions ?? {}
  const chapters = world.index?.chapters ?? []
  const rows = props.entries.map((e) => {
    const m = mentions[e.id]
    const last = lastSeen(m)
    return {
      e,
      type: templateName(world, e.template),
      facts: shownFacts(world, e, null, true)
        .slice(0, 2)
        .map((f) => `${f.field.label}: ${f.values.map((v) => valueLabel(world, v)).join(', ')}`)
        .join(' · '),
      presence: presenceOf(e),
      mentions: m?.counts.reduce((a, b) => a + b, 0) ?? 0,
      last,
    }
  })
  const value = (r: (typeof rows)[number]): string | number =>
    sort.by === 'name'
      ? r.e.name.toLowerCase()
      : sort.by === 'type'
        ? r.type
        : sort.by === 'facts'
          ? r.facts
          : sort.by === 'presence'
            ? PRESENCE_ORDER.indexOf(r.presence)
            : sort.by === 'mentions'
              ? r.mentions
              : (r.last ?? -1)
  rows.sort((a, b) => {
    const x = value(a)
    const y = value(b)
    const c = typeof x === 'number' ? x - (y as number) : x.localeCompare(y as string)
    return sort.desc ? -c : c
  })
  const header = (by: Column, label: string) => (
    <th aria-sort={sort.by === by ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button
        className="link"
        onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : false }))}
      >
        {label}
        {sort.by === by ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  )
  return (
    <table className="entry-table small">
      <thead>
        <tr>
          {header('name', 'Name')}
          {header('type', 'Type')}
          {header('facts', 'Key facts')}
          {header('presence', 'In the story')}
          {header('mentions', 'Mentions')}
          {header('lastSeen', 'Last seen')}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.e.id}>
            <td>
              <button className="link" onClick={() => props.onOpenEntry(r.e.id)}>
                {r.e.name}
              </button>
            </td>
            <td>{r.type}</td>
            <td>{r.facts}</td>
            <td>{PRESENCE_LABELS[r.presence]}</td>
            <td>{r.mentions}</td>
            <td>{r.last === null ? '—' : chapters[r.last]?.label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
