import { useCallback, useEffect, useRef, useState } from 'react'
import { SettingsWindow } from '../components/SettingsWindow'
import type { Appearance, EntrySummary, SeriesSummary } from '@shared/ipc'
import { LENSES } from '@shared/world/lenses'
import { LENS_LABELS, type Lens } from '@shared/world/templates'
import { api, describeError } from '../api'
import { MOD, modKey, useCommands } from '../components/commands'
import { useOverlays } from '../components/overlays'
import type { SaveState } from '../editor/useAutosave'
import { loadLocal, saveLocal } from '../storage'
import { EntryPage } from './EntryPage'
import { InboxView } from './InboxView'
import { LensView } from './LensView'
import { lensOf, loadRecent, pushRecent, shownTemplates, templateName } from './model'
import { Portrait } from './Portrait'
import { searchEntries } from './search'
import { QuickAddDialog } from './QuickAddDialog'
import { TemplateDialog } from './TemplateDialog'
import { TextFormDialog } from './TextFormDialog'
import { useUndo } from './useUndo'
import { useWorld } from './useWorld'
import { useWorldActions } from './useWorldActions'
import { WhereMap } from './map/WhereMap'
import { FamilyTreeView } from './board/FamilyTreeView'
import { PeopleBoard } from './board/PeopleBoard'
import { RelationshipsTable } from './board/RelationshipsTable'
import { worldMapOf } from './map/mapModel'
import { useSettings } from '../useTheme'
import { TimeContext, type TimeState } from './time/TimeContext'
import { useWords } from '../skins/useWords'
import { usePane } from '../panes/PaneContext'
import { TimelineView } from './time/TimelineView'

type Place =
  | { kind: 'lens'; lens: Lens }
  | { kind: 'entry'; entryId: string }
  | { kind: 'inbox' }
  /** A place's own map (the world map is the Where lens). */
  | { kind: 'map'; mapId: string }

const samePlace = (a: Place, b: Place) => JSON.stringify(a) === JSON.stringify(b)

/**
 * World mode, organised around four questions (Where, Who, When, How) and a
 * quiet inbox. Every entry opens as a page. Back and forward work like a
 * browser. It reads the manuscript but never edits it.
 */
/** What each section holds, under its name (How especially isn't obvious). */
const LENS_HINTS: Record<Lens, string> = {
  where: 'places, maps',
  who: 'people, groups',
  when: 'history, events',
  how: 'magic, laws, beliefs, tech',
}

export function WorldView(props: {
  worldId: string
  /** Entry to open (e.g. from a linked name in a chapter). */
  entryId?: string
  /** Open at the inbox instead. */
  inbox?: boolean
  /** Changes on each request to show `entryId`, so asking again for the same entry still shows it. */
  entryToken?: number
  /** Opens the writing view beside this one (split screen); unset when it already is. */
  onWriteBeside?: () => void
  series: SeriesSummary[]
  /** When opened from a volume: its name, for the Write/World switch. */
  writeLabel?: string
  onWrite?: () => void
  onBack: () => void
  onOpenAppearance: (appearance: Appearance, name: string) => void
}) {
  const { worldId } = props
  const { data: loaded, error } = useWorld(worldId)
  const record = useUndo()
  const { settings } = useSettings()
  const word = useWords()
  const pane = usePane()
  /** A skin's word with the plain one after it, for places that are searched ("Atlas (Where)"). */
  const both = (key: Lens | 'inbox', plain: string) => {
    const w = word(key, plain)
    return w === plain ? plain : `${w} (${plain})`
  }
  // The time scrubber's moment, shared by every view in World mode.
  const [stopId, setStopId] = useState<string | null>(null)
  // Parts this world uses (a small world can turn off its map, board or timeline).
  const features = loaded?.view.world.features ?? { map: true, board: true, timeline: true }
  const timeOn = settings.world.timeScrubber && features.timeline
  const stop = (timeOn && stopId && loaded?.timeline.stops.find((s) => s.id === stopId)) || null
  const world = loaded && { ...loaded, at: stop ? stop.position : null }
  const time: TimeState = {
    stop,
    setStop: (next) => setStopId(next?.id ?? null),
    enabled: timeOn,
  }
  const actions = useWorldActions(world, record)
  const { openMenu, toast } = useOverlays()
  const lensKey = `world.lens.${worldId}`

  const [nav, setNav] = useState<{ stack: Place[]; at: number }>(() => {
    const lens = loadLocal(lensKey) as Lens | null
    const start: Place = props.inbox
      ? { kind: 'inbox' }
      : props.entryId
        ? { kind: 'entry', entryId: props.entryId }
        : { kind: 'lens', lens: lens && LENSES.includes(lens) ? lens : 'where' }
    return { stack: [start], at: 0 }
  })
  const place = nav.stack[nav.at]!
  const [recent, setRecent] = useState(() => loadRecent(worldId))
  const [save, setSave] = useState<{ state: SaveState; error: string | null }>({
    state: 'saved',
    error: null,
  })
  const [quickAdd, setQuickAdd] = useState<{
    lens?: Lens
    name?: string
    template?: string
  } | null>(null)
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [digest, setDigest] = useState<string | null>(null)
  // The side panel's search (a tag clicked on an entry fills it with "#tag").
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState(0)
  const searchBox = useRef<HTMLInputElement>(null)

  const go = useCallback(
    (next: Place) => {
      setNav((n) => {
        if (samePlace(n.stack[n.at]!, next)) return n
        const stack = [...n.stack.slice(0, n.at + 1), next].slice(-100)
        return { stack, at: stack.length - 1 }
      })
      if (next.kind === 'entry') setRecent(pushRecent(worldId, next.entryId))
      if (next.kind === 'lens') saveLocal(lensKey, next.lens)
    },
    [worldId, lensKey],
  )
  const openEntry = useCallback((entryId: string) => go({ kind: 'entry', entryId }), [go])
  const exportBible = () => {
    toast('Putting the series bible together…')
    api.invoke('world:exportPdf', { worldId }).then(
      (done) => toast(`Exported ${done.entries} entries to ${done.path}`),
      (err: unknown) => {
        const e = describeError(err)
        if (e.code !== 'cancelled') toast(e.message)
      },
    )
  }
  const back = useCallback(() => setNav((n) => ({ ...n, at: Math.max(0, n.at - 1) })), [])
  const forward = useCallback(
    () => setNav((n) => ({ ...n, at: Math.min(n.stack.length - 1, n.at + 1) })),
    [],
  )
  const onSaveState = useCallback(
    (state: SaveState, err: string | null) => setSave({ state, error: err }),
    [],
  )

  // An entry asked for from outside (a linked name in a chapter).
  const request = `${props.inbox ? 'inbox' : (props.entryId ?? '')}:${props.entryToken ?? 0}`
  const [wanted, setWanted] = useState(request)
  if (request !== wanted) {
    setWanted(request)
    if (props.inbox || props.entryId) {
      const next: Place = props.inbox
        ? { kind: 'inbox' }
        : { kind: 'entry', entryId: props.entryId! }
      setNav((n) => {
        const stack = [...n.stack.slice(0, n.at + 1), next]
        return { stack, at: stack.length - 1 }
      })
    }
  }
  const [recorded, setRecorded] = useState<string | null>(null)
  if (place.kind === 'entry' && place.entryId !== recorded) {
    setRecorded(place.entryId)
    setRecent(pushRecent(worldId, place.entryId))
  }
  // Where this pane is (a torn-off window reopens there; popping out starts there).
  const shownEntry = place.kind === 'entry' ? place.entryId : undefined
  const { onRoute } = pane
  useEffect(() => {
    onRoute?.({ kind: 'world', worldId, entryId: shownEntry })
  }, [onRoute, worldId, shownEntry])

  // Back and forward: Alt+arrows and the mouse's side buttons.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Beside another pane, only the one being worked in answers shortcuts.
      if (!pane.active) return
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowLeft') back()
      else if (e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'ArrowRight') forward()
      else if (modKey(e) && e.altKey && e.code === 'KeyN') setQuickAdd({})
      else if (modKey(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        searchBox.current?.focus()
        searchBox.current?.select()
      } else return
      e.preventDefault()
    }
    const onMouse = (e: MouseEvent) => {
      if (!pane.active) return
      if (e.button === 3) back()
      else if (e.button === 4) forward()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [back, forward, pane.active])

  const showDigest = () =>
    void api
      .invoke('world:digest', { worldId })
      .then(setDigest, (err) => toast(describeError(err).message))

  useCommands(
    'world',
    world
      ? [
          {
            id: 'world-quick-add',
            title: 'Add to the world',
            shortcut: `${MOD}Alt+N`,
            run: () => setQuickAdd({}),
          },
          ...LENSES.map((lens) => ({
            id: `world-lens-${lens}`,
            title: `World: ${both(lens, LENS_LABELS[lens])}`,
            run: () => go({ kind: 'lens', lens }),
          })),
          {
            id: 'world-export',
            title: 'Export the world (PDF series bible)',
            run: exportBible,
          },
          {
            id: 'world-inbox',
            title: `World: ${both('inbox', 'Inbox')}`,
            run: () => go({ kind: 'inbox' }),
          },
          { id: 'world-templates', title: 'Edit templates', run: () => setTemplatesOpen(true) },
          { id: 'world-digest', title: 'View the world as text', run: showDigest },
          { id: 'world-back', title: 'Back', shortcut: 'Alt+←', run: back },
          { id: 'world-forward', title: 'Forward', shortcut: 'Alt+→', run: forward },
          ...(props.onWrite
            ? [{ id: 'world-write', title: 'Switch to Write mode', run: props.onWrite }]
            : []),
          ...world.view.entries.map((e) => ({
            id: `entry:${e.id}`,
            group: 'Go to entry',
            title: e.aliases.length ? `${e.name} (${e.aliases.join(', ')})` : e.name,
            run: () => openEntry(e.id),
          })),
        ]
      : [],
  )

  if (error && !world) return <p className="error page-message">{error}</p>
  if (!world) return null
  const { view } = world
  const entry = place.kind === 'entry' ? world.byId.get(place.entryId) : undefined
  const currentLens: Lens | null =
    place.kind === 'lens'
      ? place.lens
      : place.kind === 'map'
        ? 'where'
        : entry
          ? lensOf(world, entry)
          : null
  const openMap = (mapId: string | null) =>
    go(mapId ? { kind: 'map', mapId } : { kind: 'lens', lens: 'where' })
  const whereMap = (mapId: string | null) => (
    <WhereMap
      key={mapId ?? 'world'}
      world={world}
      mapId={mapId}
      actions={actions}
      record={record}
      onOpenEntry={openEntry}
      onOpenMap={openMap}
    />
  )
  const pinned = view.world.pinned
    .map((id) => world.byId.get(id))
    .filter((e): e is EntrySummary => !!e)
  const recentEntries = recent
    .map((id) => world.byId.get(id))
    .filter((e): e is EntrySummary => !!e && !view.world.pinned.includes(e.id))
    .slice(0, 6)

  const matches = searchEntries(view.entries, query)
  const sideItem = (e: EntrySummary) => (
    <li key={e.id}>
      <button
        className={`world-nav-item ${place.kind === 'entry' && place.entryId === e.id ? 'active' : ''}`}
        onClick={() => openEntry(e.id)}
        onContextMenu={(ev) => {
          ev.preventDefault()
          openMenu(ev, [
            {
              label: view.world.pinned.includes(e.id) ? 'Unpin' : 'Pin',
              onSelect: () => void actions.pin(e, !view.world.pinned.includes(e.id)),
            },
          ])
        }}
      >
        <Portrait worldId={worldId} name={e.name} portrait={e.portrait} size="small" />
        <span className="world-nav-label">{e.name}</span>
      </button>
    </li>
  )

  return (
    <TimeContext.Provider value={time}>
      <div className="world-view">
        <header className="top-bar">
          <button className="link" onClick={props.onBack} title="Back to the bookshelf">
            ← Bookshelf
          </button>
          <span className="nav-buttons">
            <button
              className="icon"
              aria-label="Back"
              title="Back (Alt+←)"
              disabled={nav.at === 0}
              onClick={back}
            >
              ‹
            </button>
            <button
              className="icon"
              aria-label="Forward"
              title="Forward (Alt+→)"
              disabled={nav.at >= nav.stack.length - 1}
              onClick={forward}
            >
              ›
            </button>
          </span>
          <nav className="breadcrumb small" aria-label="Breadcrumb">
            <span>{view.world.name}</span>
            {currentLens && (
              <>
                <span className="muted">/</span>
                <button className="link" onClick={() => go({ kind: 'lens', lens: currentLens })}>
                  {word(currentLens, LENS_LABELS[currentLens])}
                </button>
              </>
            )}
            {entry && (
              <>
                <span className="muted">/</span>
                <span className="breadcrumb-current">{entry.name}</span>
              </>
            )}
          </nav>
          <span className="status-spacer" />
          <button
            className="icon"
            aria-label="World menu"
            onClick={(e) =>
              openMenu(e, [
                {
                  label: 'Add to the world…',
                  hint: `${MOD}Alt+N`,
                  onSelect: () => setQuickAdd({}),
                },
                { label: 'Templates…', onSelect: () => setTemplatesOpen(true) },
                { label: 'View the world as text', onSelect: showDigest },
                { label: 'Export the world (PDF series bible)…', onSelect: exportBible },
                {
                  label: 'Parts of this world',
                  submenu: (
                    [
                      ['map', 'Map'],
                      ['board', 'People board'],
                      ['timeline', 'Timeline and time scrubber'],
                    ] as const
                  ).map(([key, label]) => ({
                    label,
                    checked: features[key],
                    keepOpen: true,
                    onSelect: () =>
                      void api
                        .invoke('world:setFeatures', {
                          worldId,
                          features: { [key]: !features[key] },
                        })
                        .catch((err: unknown) => toast(describeError(err).message)),
                  })),
                },
              ])
            }
          >
            ⋯
          </button>
          {props.onWriteBeside && (
            <button
              className="side-by-side small"
              aria-label="Open writing beside"
              title={`Open the writing beside, split screen (${MOD}\\)`}
              onClick={props.onWriteBeside}
            >
              ◫ Writing beside
            </button>
          )}
          <button
            className="icon"
            aria-label="Settings"
            title="Settings"
            aria-pressed={settingsOpen}
            onClick={() => setSettingsOpen((o) => !o)}
          >
            ⚙
          </button>
          {props.onWrite && (
            <div className="segmented mode-switch" role="radiogroup" aria-label="Mode">
              <button
                role="radio"
                aria-checked={false}
                onClick={props.onWrite}
                title={`Write: ${props.writeLabel}`}
              >
                Write
              </button>
              <button role="radio" aria-checked className="active">
                {word('world', 'World')}
              </button>
            </div>
          )}
        </header>

        <aside className="side-panel world-panel">
          <input
            ref={searchBox}
            type="search"
            className="world-search"
            aria-label="Search the world"
            placeholder={`Search the world (${MOD}F)`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPicked(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setPicked((p) => Math.min(p + 1, matches.length - 1))
              else if (e.key === 'ArrowUp') setPicked((p) => Math.max(p - 1, 0))
              else if (e.key === 'Enter' && matches[picked]) openEntry(matches[picked].entry.id)
              else if (e.key === 'Escape') setQuery('')
              else return
              e.preventDefault()
            }}
          />
          {query.trim() && (
            <section aria-label="Search results" className="world-search-results">
              <h3 className="panel-heading small muted">
                {matches.length === 0
                  ? 'Nothing found'
                  : `${matches.length} ${matches.length === 1 ? 'entry' : 'entries'}`}
              </h3>
              <ul className="world-side-list">
                {matches.map((m, i) => (
                  <li key={m.entry.id}>
                    <button
                      className={`world-nav-item ${i === picked ? 'picked' : ''} ${place.kind === 'entry' && place.entryId === m.entry.id ? 'active' : ''}`}
                      onClick={() => openEntry(m.entry.id)}
                    >
                      <Portrait
                        worldId={worldId}
                        name={m.entry.name}
                        portrait={m.entry.portrait}
                        size="small"
                      />
                      <span className="world-nav-label">
                        {m.entry.name}
                        <span className="world-nav-hint">
                          {m.why ?? templateName(world, m.entry.template)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <nav className="world-lenses" aria-label="Lenses">
            {LENSES.map((lens) => (
              <button
                key={lens}
                className={`world-nav-item ${currentLens === lens && place.kind === 'lens' ? 'active' : ''}`}
                aria-current={currentLens === lens && place.kind === 'lens' ? 'page' : undefined}
                onClick={() => go({ kind: 'lens', lens })}
              >
                <span className="world-nav-label" title={LENS_LABELS[lens]}>
                  {word(lens, LENS_LABELS[lens])}
                  <span className="world-nav-hint">{LENS_HINTS[lens]}</span>
                </span>
                <span className="muted small">
                  {view.entries.filter((e) => lensOf(world, e) === lens).length}
                </span>
              </button>
            ))}
            <button
              className={`world-nav-item ${place.kind === 'inbox' ? 'active' : ''}`}
              onClick={() => go({ kind: 'inbox' })}
            >
              <span className="world-nav-label" title="Inbox">
                {word('inbox', 'Inbox')}
              </span>
              {view.inboxCount > 0 && <span className="muted small">{view.inboxCount}</span>}
            </button>
          </nav>
          {pinned.length > 0 && (
            <section aria-label="Pinned">
              <h3 className="panel-heading small muted">Pinned</h3>
              <ul className="world-side-list">{pinned.map(sideItem)}</ul>
            </section>
          )}
          {recentEntries.length > 0 && (
            <section aria-label="Recent">
              <h3 className="panel-heading small muted">Recent</h3>
              <ul className="world-side-list">{recentEntries.map(sideItem)}</ul>
            </section>
          )}
          {view.problems.length > 0 && (
            <div className="warning small world-problems">
              <p>
                {view.problems.length === 1
                  ? 'One entry file'
                  : `${view.problems.length} entry files`}{' '}
                couldn’t be read and {view.problems.length === 1 ? 'is' : 'are'} left untouched:
              </p>
              <ul>
                {view.problems.slice(0, 5).map((p) => (
                  <li key={p.path} title={p.message}>
                    {p.path}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <main className={world.held ? 'page-area world-main held' : 'page-area world-main'}>
          {world.held && (
            <div className="sync-hold" role="status">
              Updating from your other computer…
            </div>
          )}
          {settingsOpen && <SettingsWindow onClose={() => setSettingsOpen(false)} />}
          <div className="page-scroll" hidden={settingsOpen}>
            {place.kind === 'entry' ? (
              entry ? (
                <EntryPage
                  world={world}
                  entryId={entry.id}
                  actions={actions}
                  record={record}
                  onOpenEntry={openEntry}
                  onOpenAppearance={props.onOpenAppearance}
                  onSaveState={onSaveState}
                  onDeleted={back}
                  onOpenMap={(mapId) => openMap(mapId)}
                  onShowTag={(tag) => {
                    setQuery(`#${tag}`)
                    setPicked(0)
                  }}
                />
              ) : (
                <div className="page-message">
                  <p className="muted">
                    This entry is no longer in the world (it may be in the trash).
                  </p>
                  <button onClick={back}>Go back</button>
                </div>
              )
            ) : place.kind === 'inbox' ? (
              <InboxView world={world} actions={actions} record={record} onOpenEntry={openEntry} />
            ) : place.kind === 'map' ? (
              world.view.maps.some((m) => m.id === place.mapId) ? (
                <div className="lens-view lens-map">{whereMap(place.mapId)}</div>
              ) : (
                <div className="page-message">
                  <p className="muted">
                    This map is no longer in the world (it may be in the trash).
                  </p>
                  <button onClick={back}>Go back</button>
                </div>
              )
            ) : (
              <LensView
                key={place.lens}
                world={world}
                lens={place.lens}
                onOpenEntry={openEntry}
                onNew={(lens) => setQuickAdd({ lens })}
                map={
                  settings.world.map && features.map
                    ? { exists: !!worldMapOf(world), render: () => whereMap(null) }
                    : undefined
                }
                extra={
                  place.lens === 'who'
                    ? [
                        ...(features.board
                          ? [
                              {
                                mode: 'board',
                                label: 'Board',
                                render: () => (
                                  <PeopleBoard
                                    world={world}
                                    record={record}
                                    onOpenEntry={openEntry}
                                  />
                                ),
                              },
                            ]
                          : []),
                        {
                          mode: 'tree',
                          label: 'Family tree',
                          render: () => <FamilyTreeView world={world} onOpenEntry={openEntry} />,
                        },
                      ]
                    : place.lens === 'when' && features.timeline
                      ? [
                          {
                            mode: 'timeline',
                            label: 'Timeline',
                            render: () => (
                              <TimelineView world={world} record={record} onOpenEntry={openEntry} />
                            ),
                          },
                        ]
                      : undefined
                }
                defaultMode={place.lens === 'when' && features.timeline ? 'timeline' : undefined}
                listExtra={
                  place.lens === 'who' ? (
                    <RelationshipsTable world={world} record={record} onOpenEntry={openEntry} />
                  ) : undefined
                }
              />
            )}
          </div>
        </main>

        <footer className="status-bar small">
          <span>
            {view.entries.length} {view.entries.length === 1 ? 'entry' : 'entries'}
            {entry && ` · ${templateName(world, entry.template)}`}
          </span>
          <span className="status-spacer" />
          <span className={save.state === 'error' ? 'error' : 'muted'} role="status">
            {save.state === 'error'
              ? `Not saved: ${save.error} (retrying)`
              : { saved: 'Saved', unsaved: 'Editing…', saving: 'Saving…' }[save.state]}
          </span>
        </footer>

        {quickAdd && (
          <QuickAddDialog
            templates={shownTemplates(world)}
            existing={view.entries.flatMap((e) => [e.name, ...e.aliases])}
            lens={quickAdd.lens}
            template={quickAdd.template}
            name={quickAdd.name}
            onCreate={async (name, template) => {
              const created = await actions.create(name, template)
              if (created) openEntry(created.id)
              return !!created
            }}
            onCancel={() => setQuickAdd(null)}
          />
        )}
        {templatesOpen && <TemplateDialog world={world} onClose={() => setTemplatesOpen(false)} />}
        {digest !== null && (
          <TextFormDialog
            title={`${view.world.name} as text`}
            text={digest}
            onClose={() => setDigest(null)}
          />
        )}
      </div>
    </TimeContext.Provider>
  )
}
