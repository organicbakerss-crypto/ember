import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Appearance, EntrySummary, IpcInput } from '@shared/ipc'
import type {
  FactValue,
  Portrait as PortraitData,
  RelationshipFile,
  TemplateField,
  WorldEntryFile,
} from '@shared/schema'
import { inTimeOrder } from '@shared/world/facts'
import { chapterName, firstSeen, lastSeen } from '@shared/world/story'
import { LENS_LABELS, type Lens } from '@shared/world/templates'
import { LENSES } from '@shared/world/lenses'
import { api, describeError, useIpcEvent } from '../api'
import { useOverlays, type MenuItem } from '../components/overlays'
import { RichTextField, type RichTextHandle } from '../editor/RichTextField'
import { useAutosave, type SaveState } from '../editor/useAutosave'
import { MentionTrigger, WorldLink, type MentionTrigger as Trigger } from '../editor/worldLink'
import { useSettings } from '../useTheme'
import { EntryPicker } from './EntryPicker'
import { FactEditor } from './FactEditor'
import { backlinks, MAX_QUICK_FACTS, shownFacts, templateOf, valueLabel } from './model'
import { Portrait } from './Portrait'
import { mapOfPlace } from './map/mapModel'
import { RelationshipEditor } from './board/RelationshipEditor'
import { useRelationships } from './board/useRelationships'
import { useMapImport } from './map/WhereMap'
import { PortraitCropDialog } from './PortraitCropDialog'
import { TextFormDialog } from './TextFormDialog'
import type { UndoStep } from './useUndo'
import type { WorldData } from './useWorld'
import type { WorldActions } from './useWorldActions'

type EntryPatch = IpcInput<'entry:save'>['patch']

const BODY_EXTENSIONS = [WorldLink, MentionTrigger]

/** Loads an entry, then shows it as a page. */
export function EntryPage(props: {
  world: WorldData
  entryId: string
  actions: WorldActions
  record: (step: UndoStep) => void
  onOpenEntry: (entryId: string) => void
  onOpenAppearance: (appearance: Appearance, name: string) => void
  onSaveState: (state: SaveState, error: string | null) => void
  onDeleted: () => void
  /** Opens a place's own map. */
  onOpenMap?: (mapId: string) => void
}) {
  const { world, entryId } = props
  const worldId = world.view.world.id
  const [entry, setEntry] = useState<WorldEntryFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Bumped when the page text changed elsewhere (a merge, an undo), to reload the editor.
  const [bodyVersion, setBodyVersion] = useState(0)
  const knownBody = useRef<string | null>(null)

  const load = useCallback(() => {
    api.invoke('entry:read', { worldId, entryId }).then(
      (e) => {
        const body = JSON.stringify(e.body)
        if (knownBody.current !== null && body !== knownBody.current) setBodyVersion((v) => v + 1)
        knownBody.current = body
        setEntry(e)
        setError(null)
      },
      (err) => setError(describeError(err).message),
    )
  }, [worldId, entryId])
  useEffect(load, [load])
  useIpcEvent('library:changed', (c) => {
    if (c.kind === 'entry' && c.entryId === entryId) load()
  })

  if (error) return <p className="error page-message">{error}</p>
  if (!entry || entry.id !== entryId) return null
  return (
    <EntryView
      {...props}
      key={`${entry.id}:${bodyVersion}`}
      entry={entry}
      setEntry={setEntry}
      onBodySaved={(saved) => (knownBody.current = saved)}
    />
  )
}

function EntryView(
  props: Parameters<typeof EntryPage>[0] & {
    entry: WorldEntryFile
    setEntry: (entry: WorldEntryFile) => void
    /** The page text as last saved (to tell our own saves from changes made elsewhere). */
    onBodySaved: (body: string) => void
  },
) {
  const { world, entry, setEntry, record, actions } = props
  const worldId = world.view.world.id
  const { settings } = useSettings()
  const { openMenu, toast } = useOverlays()
  const summary = world.byId.get(entry.id)
  const template = templateOf(world, entry)
  const [editing, setEditing] = useState<string | null>(null) // field id
  const [renaming, setRenaming] = useState(false)
  const [aliasDraft, setAliasDraft] = useState<string | null>(null)
  const [picker, setPicker] = useState<'merge' | null>(null)
  const [textForm, setTextForm] = useState<string | null>(null)
  const [cropping, setCropping] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const mapInput = useRef<HTMLInputElement>(null)
  const importMap = useMapImport(world, record)
  const ties$ = useRelationships(world, record)
  const [tie, setTie] = useState<{ rel?: RelationshipFile } | null>(null)

  /* ----- saving: fields at once (with undo), the page text by autosave ----- */

  const save = async (patch: EntryPatch, label?: string) => {
    const before = Object.fromEntries(
      Object.keys(patch).map((k) => [k, entry[k as keyof WorldEntryFile]]),
    ) as EntryPatch
    setEntry({ ...entry, ...(patch as Partial<WorldEntryFile>) })
    try {
      await api.invoke('entry:save', { worldId, entryId: entry.id, patch })
      if (label) {
        record({
          label,
          undo: () => api.invoke('entry:save', { worldId, entryId: entry.id, patch: before }),
        })
      }
    } catch (err) {
      toast(`Not saved: ${describeError(err).message}`)
      setEntry(entry)
    }
  }

  const body = useRef<RichTextHandle | null>(null)
  const saver = useAutosave<EntryPatch>(
    async (patch) => {
      const saved = await api.invoke('entry:save', { worldId, entryId: entry.id, patch })
      props.onBodySaved(JSON.stringify(saved.body))
    },
    () => {
      const content = body.current?.getContent()
      return content ? { body: content } : null // unreadable text: never overwrite it
    },
  )
  const { onSaveState } = props
  useEffect(() => onSaveState(saver.state, saver.error), [saver.state, saver.error, onSaveState])

  /* ----- names on the page link to entries; `@` links anything ----- */

  const names = useMemo(
    () => ({
      index: { world, terms: world.terms.filter((t) => t.entryId !== entry.id) },
      enabled: settings.linkNames,
      hoverCards: settings.world.hoverCards,
      onOpen: props.onOpenEntry,
    }),
    [world, entry.id, settings.linkNames, settings.world.hoverCards, props.onOpenEntry],
  )
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const attachBody = useCallback((handle: RichTextHandle | null) => {
    body.current = handle
    handle?.editor.commands.onMentionTrigger((t) => setTrigger(t))
  }, [])
  const mention = trigger && trigger.from !== dismissedAt ? trigger : null

  /* ----- facts ----- */

  const saveFacts = (field: TemplateField, values: FactValue[]) => {
    setEditing(null)
    const next = { ...entry.facts }
    if (values.length) next[field.id] = values
    else delete next[field.id]
    void save({ facts: next }, `Changed ${field.label.toLowerCase()} of ${entry.name}`)
  }
  const createLinked = async (name: string, templateId: string) => {
    const created = await actions.create(name, templateId)
    return created && { ...created, snippet: '', links: [] }
  }

  const quick = shownFacts(world, entry, null, true).slice(0, MAX_QUICK_FACTS)
  const quickIds = new Set(quick.map((f) => f.field.id))
  const details = shownFacts(world, entry, null).filter((f) => !quickIds.has(f.field.id))
  const empty = template.fields.filter((f) => !entry.facts[f.id]?.length)
  const editingField = template.fields.find((f) => f.id === editing)

  const addDetail = (e: React.MouseEvent) =>
    openMenu(
      e,
      empty.length
        ? empty.map((f) => ({ label: f.label, onSelect: () => setEditing(f.id) }))
        : [{ label: 'Every detail has a value', disabled: true }],
    )

  /* ----- header actions ----- */

  const changeType = (templateId: string) => {
    const next = world.templates.get(templateId)
    void save({ template: templateId }, `Changed ${entry.name} to ${next?.name ?? templateId}`)
  }
  const typeItems = (): MenuItem[] =>
    LENSES.map((lens: Lens) => ({
      label: LENS_LABELS[lens],
      submenu: world.view.templates
        .filter((t) => t.lens === lens)
        .map((t) => ({
          label: t.name,
          checked: t.id === entry.template,
          onSelect: () => changeType(t.id),
        })),
    }))
  const typeMenu = (e: React.MouseEvent) => openMenu(e, typeItems())

  const pinned = world.view.world.pinned.includes(entry.id)
  const moreMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      {
        label: pinned ? 'Unpin' : 'Pin to the side',
        onSelect: () => summary && void actions.pin(summary, !pinned),
      },
      { label: 'Rename', hint: 'F3', onSelect: () => setRenaming(true) },
      { label: 'Change type', submenu: typeItems() },
      {
        label: 'Duplicate',
        onSelect: async () => {
          if (!summary) return
          const copy = await actions.duplicate(summary)
          if (copy) props.onOpenEntry(copy.id)
        },
      },
      { label: 'Merge a duplicate into this…', onSelect: () => setPicker('merge') },
      {
        label: 'View as text',
        onSelect: () =>
          void api
            .invoke('entry:text', { worldId, entryId: entry.id })
            .then(setTextForm, (err) => toast(describeError(err).message)),
      },
      {
        label: 'Delete…',
        danger: true,
        onSelect: async () => {
          if (summary && (await actions.remove(summary))) props.onDeleted()
        },
      },
    ])

  // F3 renames.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'F3') {
        e.preventDefault()
        setRenaming(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ----- portrait ----- */

  const setPortraitFile = async (file: File | undefined) => {
    if (!file) return
    try {
      const previous = entry.portrait
      const saved = await api.invoke('entry:portrait', {
        worldId,
        entryId: entry.id,
        data: new Uint8Array(await file.arrayBuffer()),
      })
      setEntry(saved)
      record({
        label: `Changed the portrait of ${entry.name}`,
        undo: () =>
          api.invoke('entry:save', { worldId, entryId: entry.id, patch: { portrait: previous } }),
      })
      setCropping(true)
    } catch (err) {
      toast(describeError(err).message)
    }
  }
  const portraitMenu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: 'Choose an image…', onSelect: () => fileInput.current?.click() },
      { label: 'Adjust crop…', disabled: !entry.portrait, onSelect: () => setCropping(true) },
      {
        label: 'Remove portrait',
        disabled: !entry.portrait,
        onSelect: () => void save({ portrait: null }, `Removed the portrait of ${entry.name}`),
      },
    ])

  /* ----- aliases ----- */

  const commitAlias = () => {
    const alias = (aliasDraft ?? '').trim().replace(/,$/, '')
    setAliasDraft(null)
    if (!alias || entry.aliases.includes(alias) || alias === entry.name) return
    void save({ aliases: [...entry.aliases, alias] }, `Added “${alias}” as another name`)
  }

  /* ----- what links here, and the story ----- */

  const touches = backlinks(world, entry.id, null)
  const isPlace = template.lens === 'where'
  const nearby = (world.view.nearby[entry.id] ?? [])
    .map((id) => world.resolve(id))
    .filter((e): e is EntrySummary => !!e)
  const ownMap = mapOfPlace(world, entry.id)
  const ties = world.view.relationships.filter((r) => r.from === entry.id || r.to === entry.id)
  const mentions = world.index?.mentions[entry.id]
  const chapters = world.index?.chapters ?? []
  const first = firstSeen(mentions)
  const last = lastSeen(mentions)
  const quotesByField = new Map<string, typeof entry.quotes>()
  for (const q of entry.quotes) {
    const label = q.field
      ? (template.fields.find((f) => f.id === q.field)?.label ?? q.field)
      : 'Notes'
    quotesByField.set(label, [...(quotesByField.get(label) ?? []), q])
  }
  const removeQuote = (id: string) =>
    void save({ quotes: entry.quotes.filter((q) => q.id !== id) }, 'Removed a quote')

  const renderValues = (field: TemplateField, values: FactValue[]) =>
    values.map((v, i) => (
      <span key={v.id}>
        {i > 0 && ', '}
        {v.link && world.resolve(v.link) ? (
          <button
            className="link"
            onClick={(e) => {
              e.stopPropagation()
              props.onOpenEntry(v.link!)
            }}
          >
            {valueLabel(world, v)}
          </button>
        ) : (
          <span className={v.link ? 'missing' : ''}>{valueLabel(world, v)}</span>
        )}
      </span>
    ))
  const history = (field: TemplateField) => {
    const all = entry.facts[field.id] ?? []
    if (field.multiple || all.length < 2) return null
    return inTimeOrder(all, world.positions)
      .map((v, i) => {
        const at = v.from?.kind === 'chapter' ? world.positions.get(v.from.chapterId) : undefined
        const when = !v.from
          ? i === 0
            ? 'at first'
            : 'later'
          : v.from.kind === 'event'
            ? `from ${world.resolve(v.from.entryId)?.name ?? 'an event'}`
            : at !== undefined
              ? `from ${chapters[at]!.label}`
              : 'from a chapter'
        return `${valueLabel(world, v)} (${when})`
      })
      .join(' → ')
  }

  return (
    <article className="entry-page page" aria-label={entry.name}>
      <header
        className="entry-head"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault()
        }}
        onDrop={(e) => {
          e.preventDefault()
          void setPortraitFile(e.dataTransfer.files[0])
        }}
      >
        <button
          className="portrait-button"
          title="Portrait: drop an image here, or click"
          onClick={portraitMenu}
          onContextMenu={(e) => {
            e.preventDefault()
            portraitMenu(e)
          }}
        >
          <Portrait worldId={worldId} name={entry.name} portrait={entry.portrait} size="large" />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          hidden
          onChange={(e) => {
            void setPortraitFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <div className="entry-title">
          {renaming ? (
            <input
              className="entry-name-input"
              aria-label="Entry name"
              autoFocus
              defaultValue={entry.name}
              onBlur={(e) => {
                setRenaming(false)
                const name = e.target.value.trim()
                if (name && name !== entry.name)
                  void save({ name }, `Renamed ${entry.name} to ${name}`)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setRenaming(false)
              }}
            />
          ) : (
            <h1
              className="entry-name"
              onDoubleClick={() => setRenaming(true)}
              title="Double-click to rename"
            >
              {entry.name}
            </h1>
          )}
          <div className="entry-subtitle small">
            <button className="chip-button" onClick={typeMenu} title="Change type">
              {template.name}
            </button>
            {entry.aliases.length > 0 && <span className="muted">Also called</span>}
            {entry.aliases.map((a) => (
              <span key={a} className="chip">
                {a}
                <button
                  className="icon"
                  aria-label={`Remove the name ${a}`}
                  onClick={() =>
                    void save(
                      { aliases: entry.aliases.filter((x) => x !== a) },
                      `Removed “${a}” as another name`,
                    )
                  }
                >
                  ✕
                </button>
              </span>
            ))}
            {aliasDraft === null ? (
              <button className="link small" onClick={() => setAliasDraft('')}>
                + another name
              </button>
            ) : (
              <input
                className="chip-input"
                aria-label="Add another name"
                autoFocus
                placeholder="A nickname or other name"
                value={aliasDraft}
                onChange={(e) => setAliasDraft(e.target.value)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    commitAlias()
                  }
                  if (e.key === 'Escape') setAliasDraft(null)
                }}
                onBlur={commitAlias}
              />
            )}
          </div>
        </div>
        <button className="icon entry-more" aria-label="More actions" onClick={moreMenu}>
          ⋯
        </button>
      </header>

      <section className="quick-strip" aria-label="Quick facts">
        {quick.map(({ field, values }) => (
          <button key={field.id} className="quick-fact" onClick={() => setEditing(field.id)}>
            <span className="quick-fact-label">{field.label}</span>
            <span className="quick-fact-value">{renderValues(field, values)}</span>
          </button>
        ))}
        <button className="link small add-detail" onClick={addDetail}>
          + add detail
        </button>
      </section>

      {details.length > 0 && (
        <dl className="entry-details">
          {details.map(({ field, values }) => (
            <div key={field.id} className="entry-detail" onClick={() => setEditing(field.id)}>
              <dt>{field.label}</dt>
              <dd>
                {field.multiple && field.kind === 'text' ? (
                  <ol>
                    {values.map((v) => (
                      <li key={v.id}>{v.text}</li>
                    ))}
                  </ol>
                ) : (
                  renderValues(field, values)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {[...quick, ...details].map(({ field }) => {
        const h = history(field)
        return h ? (
          <p key={field.id} className="muted small fact-history">
            {field.label} over time: {h}
          </p>
        ) : null
      })}

      {editingField && (
        <FactEditor
          world={world}
          entryId={entry.id}
          field={editingField}
          values={entry.facts[editingField.id] ?? []}
          onSave={(values) => saveFacts(editingField, values)}
          onCancel={() => setEditing(null)}
          onCreateEntry={createLinked}
        />
      )}

      <section className="entry-body">
        <RichTextField
          content={entry.body}
          placeholder={`Write about ${entry.name}… (type @ to link anything)`}
          ariaLabel={`${entry.name}: page`}
          extensions={BODY_EXTENSIONS}
          names={names}
          handle={attachBody}
          onChange={saver.changeContent}
        />
        {mention && (
          <div
            className="mention-popup"
            style={{
              left: Math.min(mention.rect.left, window.innerWidth - 300),
              top: Math.min(mention.rect.bottom + 4, window.innerHeight - 260),
            }}
          >
            <EntryPicker
              world={world}
              query={mention.query}
              exclude={[entry.id]}
              onPick={(picked: EntrySummary) => {
                body.current?.editor.commands.insertWorldLink(mention, picked.id, picked.name)
              }}
              onCreate={async (name) => {
                const created = await actions.create(name, 'person')
                if (created)
                  body.current?.editor.commands.insertWorldLink(mention, created.id, created.name)
              }}
              onCancel={() => setDismissedAt(mention.from)}
            />
          </div>
        )}
      </section>

      {quotesByField.size > 0 && (
        <section className="entry-section" aria-label="From the story">
          <h3>From the story</h3>
          {[...quotesByField].map(([label, quotes]) => (
            <div key={label} className="quote-group">
              <h4 className="small muted">{label}</h4>
              {quotes.map((q) => {
                const at = world.positions.get(q.source.chapterId)
                const chapter = at === undefined ? undefined : chapters[at]
                return (
                  <blockquote key={q.id} className="quote">
                    <p>“{q.text}”</p>
                    <footer className="small">
                      {chapter ? (
                        <button
                          className="link"
                          onClick={() =>
                            props.onOpenAppearance(
                              { chapter, position: at!, count: 0, pov: false, lines: [] },
                              q.text.slice(0, 60),
                            )
                          }
                        >
                          {chapterName(chapter)}
                        </button>
                      ) : (
                        <span className="muted">{q.source.chapterTitle || 'A chapter'}</span>
                      )}
                      <button
                        className="icon"
                        aria-label="Remove quote"
                        onClick={() => removeQuote(q.id)}
                      >
                        ✕
                      </button>
                    </footer>
                  </blockquote>
                )
              })}
            </div>
          ))}
        </section>
      )}

      {isPlace && (
        <section className="entry-section" aria-label="Nearby">
          <h3>Nearby</h3>
          {nearby.length ? (
            <p className="exits">
              {nearby.map((e) => (
                <button key={e.id} className="exit" onClick={() => props.onOpenEntry(e.id)}>
                  {e.name} →
                </button>
              ))}
            </p>
          ) : (
            <p className="muted small">
              Nothing yet. Places next to each other on a map (or joined by road on the travel
              sketch) show here.
            </p>
          )}
          <div className="row small">
            {ownMap ? (
              <button className="link" onClick={() => props.onOpenMap?.(ownMap.id)}>
                Open the map of {entry.name}
              </button>
            ) : (
              <button className="link" onClick={() => mapInput.current?.click()}>
                Add a map of {entry.name}…
              </button>
            )}
            <input
              ref={mapInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              aria-label={`Map of ${entry.name}`}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                const created = await importMap(file, entry.id)
                if (created) props.onOpenMap?.(created.id)
              }}
            />
          </div>
        </section>
      )}

      {(template.lens === 'who' || ties.length > 0) && (
        <section className="entry-section" aria-label="Relationships">
          <h3>Relationships</h3>
          {ties.length ? (
            <ul className="pair-list">
              {ties.map((r) => {
                const type = world.view.relationshipTypes.find((t) => t.id === r.type)
                const person = (id: string) =>
                  id === entry.id ? (
                    <strong>{entry.name}</strong>
                  ) : (
                    <button
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onOpenEntry(id)
                      }}
                    >
                      {world.resolve(id)?.name ?? '(missing)'}
                    </button>
                  )
                return (
                  <li key={r.id}>
                    <div
                      className="pair-item"
                      role="button"
                      tabIndex={0}
                      title="Change this link"
                      onClick={() => setTie({ rel: r })}
                      onKeyDown={(e) => e.key === 'Enter' && setTie({ rel: r })}
                    >
                      <span className="swatch" style={{ background: type?.colour }} />
                      <span>
                        {person(r.from)} — {r.label || type?.label.toLowerCase() || r.type} →{' '}
                        {person(r.to)}
                        {(r.over || r.end) && <span className="muted"> (over)</span>}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="muted small">
              No links yet. Add one here, or drag {entry.name} onto someone on the people board.
            </p>
          )}
          <button className="link small" onClick={() => setTie({})}>
            + Add a relationship
          </button>
          {tie && (
            <RelationshipEditor
              world={world}
              relationship={tie.rel}
              from={tie.rel ? undefined : entry.id}
              onSave={(draft) => void ties$.save(draft).then(() => setTie(null))}
              onDelete={
                tie.rel ? () => void ties$.remove(tie.rel!).then(() => setTie(null)) : undefined
              }
              onCancel={() => setTie(null)}
            />
          )}
        </section>
      )}

      {touches.length > 0 && (
        <section className="entry-section" aria-label="Linked here">
          <h3>Linked here</h3>
          <dl className="entry-details">
            {touches.map((t) => (
              <div key={t.label} className="entry-detail static">
                <dt>{t.label}</dt>
                <dd>
                  {t.entries.map((e, i) => (
                    <span key={e.id}>
                      {i > 0 && ', '}
                      <button className="link" onClick={() => props.onOpenEntry(e.id)}>
                        {e.name}
                      </button>
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="entry-section" aria-label="In the story">
        <h3>In the story</h3>
        {first === null ? (
          <p className="muted small">Not in any chapter yet (of the series using this world).</p>
        ) : (
          <p className="small">
            First: {chapters[first]?.label} · Last: {chapters[last!]?.label}
            {mentions?.pov.length
              ? ` · Point of view in ${mentions.pov.map((p) => chapters[p]?.label).join(', ')}`
              : ''}
          </p>
        )}
        <Appearances
          worldId={worldId}
          entryId={entry.id}
          onOpen={(a) => props.onOpenAppearance(a, entry.name)}
        />
      </section>

      {picker === 'merge' && summary && (
        <div className="modal-backdrop" onMouseDown={() => setPicker(null)}>
          <div
            className="card stack dialog"
            role="dialog"
            aria-label="Merge"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3>Merge a duplicate into “{entry.name}”</h3>
            <EntryPicker
              world={world}
              exclude={[entry.id]}
              placeholder="Which entry is the duplicate?"
              onPick={(dupe) => {
                setPicker(null)
                void saver.flush().then(() => actions.merge(summary, dupe))
              }}
              onCancel={() => setPicker(null)}
            />
          </div>
        </div>
      )}
      {textForm !== null && (
        <TextFormDialog
          title={`${entry.name} as text`}
          text={textForm}
          onClose={() => setTextForm(null)}
        />
      )}
      {cropping && entry.portrait && (
        <PortraitCropDialog
          worldId={worldId}
          name={entry.name}
          portrait={entry.portrait}
          onDone={(next: PortraitData | null) => {
            setCropping(false)
            if (next) void save({ portrait: next })
          }}
        />
      )}
    </article>
  )
}

/** Chapters where this entry is mentioned, with the lines it appears in. */
function Appearances(props: {
  worldId: string
  entryId: string
  onOpen: (appearance: Appearance) => void
}) {
  const { worldId, entryId } = props
  const [list, setList] = useState<Appearance[] | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const load = useCallback(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      api.invoke('entry:appearances', { worldId, entryId }).then(setList, () => setList([]))
    }, 300)
  }, [worldId, entryId])
  useEffect(() => {
    load()
    return () => clearTimeout(timer.current)
  }, [load])
  useIpcEvent('library:changed', (c) => {
    if (
      (c.kind === 'entry' && c.entryId === entryId) ||
      c.kind === 'chapter' ||
      c.kind === 'outline'
    )
      load()
  })
  if (!list?.length) return null
  return (
    <ul className="appearances">
      {list.map((a) => (
        <li key={a.chapter.id}>
          <button className="appearance" onClick={() => props.onOpen(a)}>
            <span className="appearance-head">
              <span>
                {chapterName(a.chapter)}
                <span className="muted small"> · {a.chapter.volumeName}</span>
              </span>
              <span className="muted small">
                {a.pov && 'point of view · '}
                {a.count} {a.count === 1 ? 'mention' : 'mentions'}
              </span>
            </span>
            {a.lines.map((line, i) => (
              <span key={i} className="appearance-line small">
                {line}
              </span>
            ))}
          </button>
        </li>
      ))}
    </ul>
  )
}
