import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { entryTerms } from '@shared/names'
import { useSettings } from '../useTheme'
import type { Appearance, EntrySummary, IpcInput } from '@shared/ipc'
import type { RichTextDoc, WorldEntryFile, WorldFile } from '@shared/schema'
import { newId } from '@shared/ids'
import { api, describeError, useIpcEvent } from '../api'
import { useOverlays } from '../components/overlays'
import { RichTextField, type RichTextHandle } from '../editor/RichTextField'
import { useAutosave, type SaveState } from '../editor/useAutosave'
import type { Extensions } from '@tiptap/core'

type EntryPatch = IpcInput<'entry:save'>['patch']

interface Section {
  id: string
  title: string
  content: RichTextDoc
}

/** Loads an entry, then shows it for editing. */
export function EntryPage(props: {
  worldId: string
  entryId: string
  world: WorldFile
  entries: EntrySummary[]
  extensions?: Extensions
  onOpenEntry: (entryId: string) => void
  onOpenAppearance: (appearance: Appearance, name: string) => void
  onSaveState: (state: SaveState, error: string | null) => void
}) {
  const [entry, setEntry] = useState<WorldEntryFile | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .invoke('entry:read', { worldId: props.worldId, entryId: props.entryId })
      .then(setEntry, (err) => setError(describeError(err).message))
  }, [props.worldId, props.entryId])
  if (error) return <p className="error page-message">{error}</p>
  if (!entry) return null
  return <EntryEditor {...props} entry={entry} />
}

function EntryEditor(props: Parameters<typeof EntryPage>[0] & { entry: WorldEntryFile }) {
  const { worldId, entry } = props
  const { settings } = useSettings()
  const { world: worldFile, entries, onOpenEntry } = props
  // Names of other entries mentioned in this entry's text link to them.
  const names = useMemo(
    () => ({
      index: {
        entries: new Map(entries.map((e) => [e.id, e])),
        categories: new Map(worldFile.categories.map((c) => [c.id, c.name])),
        terms: entryTerms(entries.filter((e) => e.id !== entry.id)),
      },
      enabled: settings.linkNames,
      onOpen: onOpenEntry,
    }),
    [entries, worldFile, entry.id, settings.linkNames, onOpenEntry],
  )
  const [name, setName] = useState(entry.name)
  const [aliases, setAliases] = useState(entry.aliases)
  const [categoryId, setCategoryId] = useState(entry.categoryId)
  const [sections, setSections] = useState<Section[]>(entry.sections)
  const [related, setRelated] = useState(entry.related)
  const [aliasDraft, setAliasDraft] = useState('')
  const handles = useRef(new Map<string, RichTextHandle>())
  const sectionsRef = useRef(sections)
  useEffect(() => {
    sectionsRef.current = sections
  })
  const { choose } = useOverlays()

  const saver = useAutosave<EntryPatch>(
    (patch) => api.invoke('entry:save', { worldId, entryId: entry.id, patch }),
    () => {
      const out: Section[] = []
      for (const s of sectionsRef.current) {
        const handle = handles.current.get(s.id)
        const content = handle ? handle.getContent() : s.content
        if (!content) return null // unreadable text: never overwrite it
        out.push({ id: s.id, title: s.title, content })
      }
      return { sections: out }
    },
  )
  const { onSaveState } = props
  useEffect(() => onSaveState(saver.state, saver.error), [saver.state, saver.error, onSaveState])

  const changeSections = (next: Section[]) => {
    // Keep the latest text of each section when reordering or renaming.
    const withText = next.map((s) => ({
      ...s,
      content: handles.current.get(s.id)?.getContent() ?? s.content,
    }))
    setSections(withText)
    sectionsRef.current = withText
    saver.changeContent()
  }

  const addAlias = () => {
    const alias = aliasDraft.trim().replace(/,$/, '')
    setAliasDraft('')
    if (!alias || aliases.includes(alias) || alias === name) return
    const next = [...aliases, alias]
    setAliases(next)
    saver.changeFields({ aliases: next })
  }
  const removeAlias = (alias: string) => {
    const next = aliases.filter((a) => a !== alias)
    setAliases(next)
    saver.changeFields({ aliases: next })
  }
  const setRelatedList = (next: string[]) => {
    setRelated(next)
    saver.changeFields({ related: next })
  }

  const removeSection = async (section: Section) => {
    const content = handles.current.get(section.id)?.getContent() ?? section.content
    if (content.content?.some((n) => JSON.stringify(n).includes('"text"'))) {
      const answer = await choose(
        `Remove the section “${section.title || 'Untitled'}”?`,
        [{ value: 'remove', label: 'Remove section', danger: true }],
        'Its text will be deleted from this entry.',
      )
      if (!answer) return
    }
    changeSections(sections.filter((s) => s.id !== section.id))
  }
  const moveSection = (index: number, delta: number) => {
    const next = [...sections]
    const [item] = next.splice(index, 1)
    next.splice(index + delta, 0, item!)
    changeSections(next)
  }

  const byId = new Map(props.entries.map((e) => [e.id, e]))
  const others = props.entries.filter((e) => e.id !== entry.id && !related.includes(e.id))

  return (
    <article className="entry-page page">
      <div className="entry-meta small">
        <select
          aria-label="Category"
          value={categoryId ?? ''}
          onChange={(e) => {
            const next = e.target.value || null
            setCategoryId(next)
            saver.changeFields({ categoryId: next })
          }}
        >
          <option value="">No category</option>
          {props.world.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <input
        className="chapter-title entry-name"
        aria-label="Entry name"
        value={name}
        placeholder="Name"
        onChange={(e) => {
          setName(e.target.value)
          if (e.target.value.trim()) saver.changeFields({ name: e.target.value })
        }}
        onBlur={() => void saver.flush()}
      />
      <div className="entry-aliases">
        <span className="muted small">Also called</span>
        {aliases.map((a) => (
          <span key={a} className="chip">
            {a}
            <button
              className="icon"
              aria-label={`Remove alias ${a}`}
              onClick={() => removeAlias(a)}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          className="chip-input"
          aria-label="Add an alias"
          placeholder={aliases.length ? 'Add another' : 'Add a nickname or other name'}
          value={aliasDraft}
          onChange={(e) => setAliasDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              addAlias()
            }
          }}
          onBlur={addAlias}
        />
      </div>

      {sections.map((section, i) => (
        <section key={section.id} className="entry-section">
          <header className="entry-section-header">
            <input
              className="entry-section-title"
              aria-label="Section title"
              value={section.title}
              placeholder="Section title"
              onChange={(e) =>
                changeSections(
                  sections.map((s) => (s.id === section.id ? { ...s, title: e.target.value } : s)),
                )
              }
            />
            <span className="entry-section-actions">
              <button
                className="icon"
                title="Move up"
                disabled={i === 0}
                onClick={() => moveSection(i, -1)}
              >
                ↑
              </button>
              <button
                className="icon"
                title="Move down"
                disabled={i === sections.length - 1}
                onClick={() => moveSection(i, 1)}
              >
                ↓
              </button>
              <button
                className="icon"
                title="Remove section"
                onClick={() => void removeSection(section)}
              >
                ✕
              </button>
            </span>
          </header>
          <RichTextField
            content={section.content}
            placeholder={`Write about ${name || 'this'}…`}
            ariaLabel={section.title || 'Section'}
            extensions={props.extensions}
            names={names}
            handle={(h) => {
              if (h) handles.current.set(section.id, h)
              else handles.current.delete(section.id)
            }}
            onChange={saver.changeContent}
          />
        </section>
      ))}
      <button
        className="link"
        onClick={() =>
          changeSections([
            ...sections,
            { id: newId('section'), title: '', content: { type: 'doc', content: [] } },
          ])
        }
      >
        + Add section
      </button>

      <section className="entry-links">
        <h3>Linked entries</h3>
        <div className="row wrap">
          {related.map((id) => (
            <span key={id} className="chip">
              <button className="link" onClick={() => props.onOpenEntry(id)}>
                {byId.get(id)?.name ?? '(missing entry)'}
              </button>
              <button
                className="icon"
                aria-label={`Unlink ${byId.get(id)?.name ?? 'entry'}`}
                onClick={() => setRelatedList(related.filter((r) => r !== id))}
              >
                ✕
              </button>
            </span>
          ))}
          {others.length === 0 && related.length === 0 && (
            <span className="muted small">No other entries in this world yet.</span>
          )}
          {others.length > 0 && (
            <select
              aria-label="Link another entry"
              value=""
              onChange={(e) => e.target.value && setRelatedList([...related, e.target.value])}
            >
              <option value="">+ Link an entry…</option>
              {others.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </section>

      <Appearances
        worldId={worldId}
        entryId={entry.id}
        name={name}
        onOpen={(a) => props.onOpenAppearance(a, name)}
      />
    </article>
  )
}

/** Chapters where this entry's name or an alias appears (read-only). */
function Appearances(props: {
  worldId: string
  entryId: string
  name: string
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
  useIpcEvent('library:changed', (c) => c.kind === 'entry' && c.entryId === entryId && load())

  return (
    <section className="entry-links">
      <h3>Appears in</h3>
      {list === null ? (
        <p className="muted small">Checking chapters…</p>
      ) : list.length === 0 ? (
        <p className="muted small">
          “{props.name}” isn’t in any chapter yet (of the series using this world).
        </p>
      ) : (
        <ul className="appearances">
          {list.map((a) => (
            <li key={a.chapterId}>
              <button className="appearance" onClick={() => props.onOpen(a)}>
                <span>
                  <span className="muted small">
                    {a.seriesName} › {a.volumeName} ›{' '}
                  </span>
                  {a.chapterTitle || 'Untitled chapter'}
                </span>
                <span className="muted small">
                  {a.count} {a.count === 1 ? 'mention' : 'mentions'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
