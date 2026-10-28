import { useCallback, useEffect, useState } from 'react'
import type { Appearance, EntrySummary, SeriesSummary, WorldView as WorldData } from '@shared/ipc'
import type { WorldCategory } from '@shared/schema'
import { api, describeError, useIpcEvent } from '../api'
import { useCommands } from '../components/commands'
import { useOverlays } from '../components/overlays'
import { useLibraryActions } from '../components/useLibraryActions'
import type { SaveState } from '../editor/useAutosave'
import { loadLocal, saveLocal } from '../storage'
import { CategoryDialog } from './CategoryDialog'
import { EntryPage } from './EntryPage'
import { STARTER_CATEGORIES } from './starters'
import { WorldSidebar } from './WorldSidebar'

/**
 * World mode: categories and entries on the left, the open entry on the
 * right. It reads the manuscript (appearances) but never edits it.
 */
export function WorldView(props: {
  worldId: string
  /** Entry to open (e.g. from a linked name in a chapter). */
  entryId?: string
  /** Series that use this world (shown on the overview). */
  series: SeriesSummary[]
  /** When opened from a volume: its name, for the Write/World switch. */
  writeLabel?: string
  onWrite?: () => void
  onBack: () => void
  onOpenAppearance: (appearance: Appearance, name: string) => void
}) {
  const { worldId } = props
  const lastKey = `world.lastEntry.${worldId}`
  const [view, setView] = useState<WorldData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(
    () => props.entryId ?? loadLocal(lastKey),
  )
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ category?: WorldCategory } | null>(null)
  const [save, setSave] = useState<{ state: SaveState; error: string | null }>({
    state: 'saved',
    error: null,
  })
  const { choose, toast } = useOverlays()
  const actions = useLibraryActions()

  const refresh = useCallback(() => {
    api
      .invoke('world:get', { worldId })
      .then(setView, (err) => setError(describeError(err).message))
  }, [worldId])
  useEffect(refresh, [refresh])
  useIpcEvent('library:changed', (c) => {
    if ((c.kind === 'world' || c.kind === 'entry') && c.worldId === worldId) refresh()
  })
  const [wanted, setWanted] = useState(props.entryId)
  if (props.entryId !== wanted) {
    setWanted(props.entryId)
    if (props.entryId) setSelectedId(props.entryId)
  }

  const select = useCallback(
    (entryId: string | null) => {
      setSelectedId(entryId)
      if (entryId) saveLocal(lastKey, entryId)
    },
    [lastKey],
  )

  const deleteCategory = async (category: WorldCategory) => {
    const n = view?.entries.filter((e) => e.categoryId === category.id).length ?? 0
    const answer = await choose(
      `Delete the category “${category.name}”?`,
      [{ value: 'delete', label: 'Delete category', danger: true }],
      n ? `Its ${n === 1 ? 'entry is' : `${n} entries are`} kept, without a category.` : undefined,
    )
    if (!answer) return
    try {
      await api.invoke('category:delete', { worldId, categoryId: category.id })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const trashEntry = (entry: EntrySummary) => {
    if (entry.id === selectedId) select(null)
    void actions.moveToTrash({ kind: 'entry', worldId, entryId: entry.id }, entry.name)
  }

  const addStarter = async (starter: (typeof STARTER_CATEGORIES)[number]) => {
    try {
      await api.invoke('category:create', { worldId, ...starter })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  // F2 renames the open entry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2' && selectedId) {
        e.preventDefault()
        setRenamingId(selectedId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId])

  useCommands(
    'world',
    view
      ? [
          { id: 'world-new-category', title: 'New category', run: () => setDialog({}) },
          ...(props.onWrite
            ? [{ id: 'world-write', title: 'Switch to Write mode', run: props.onWrite }]
            : []),
          ...view.entries.map((e) => ({
            id: `entry:${e.id}`,
            group: 'Go to entry',
            title: e.name,
            run: () => select(e.id),
          })),
        ]
      : [],
  )

  if (error) return <p className="error page-message">{error}</p>
  if (!view) return null
  const entry = view.entries.find((e) => e.id === selectedId)
  const category = view.world.categories.find((c) => c.id === entry?.categoryId)
  const linkedSeries = props.series.filter((s) => s.worldId === worldId)

  return (
    <div className="world-view">
      <header className="top-bar">
        <button className="link" onClick={props.onBack} title="Back to the bookshelf">
          ← Bookshelf
        </button>
        <nav className="breadcrumb small" aria-label="Breadcrumb">
          <button className="link" onClick={() => select(null)}>
            {view.world.name}
          </button>
          {category && (
            <>
              <span className="muted">/</span>
              <span>{category.name}</span>
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
              World
            </button>
          </div>
        )}
      </header>

      <aside className="side-panel world-panel">
        <WorldSidebar
          view={view}
          selectedId={selectedId}
          renamingId={renamingId}
          onRenamingChange={setRenamingId}
          onSelect={select}
          onCreated={select}
          onNewCategory={() => setDialog({})}
          onEditCategory={(c) => setDialog({ category: c })}
          onDeleteCategory={(c) => void deleteCategory(c)}
          onTrashEntry={trashEntry}
        />
      </aside>

      <main className="page-area world-main">
        <div className="page-scroll">
          {entry ? (
            <EntryPage
              key={entry.id}
              worldId={worldId}
              entryId={entry.id}
              world={view.world}
              entries={view.entries}
              onOpenEntry={select}
              onOpenAppearance={props.onOpenAppearance}
              onSaveState={(state, err) => setSave({ state, error: err })}
            />
          ) : (
            <article className="page world-overview">
              <h1>{view.world.name}</h1>
              <p className="muted">
                {linkedSeries.length
                  ? `Used by ${linkedSeries.map((s) => s.name).join(', ')}.`
                  : 'No series uses this world yet.'}
              </p>
              {view.world.categories.length === 0 ? (
                <p>This world is empty. Add the categories your story needs, one at a time:</p>
              ) : (
                <ul className="world-summary">
                  {view.world.categories.map((c) => (
                    <li key={c.id}>
                      <strong>{c.name}</strong>{' '}
                      <span className="muted small">
                        {view.entries.filter((e) => e.categoryId === c.id).length} entries ·
                        sections: {c.sections.map((s) => s.name).join(', ') || 'none'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row wrap">
                {STARTER_CATEGORIES.filter(
                  (s) =>
                    !view.world.categories.some(
                      (c) => c.name.toLowerCase() === s.name.toLowerCase(),
                    ),
                ).map((s) => (
                  <button key={s.name} onClick={() => void addStarter(s)}>
                    + {s.name}
                  </button>
                ))}
                <button onClick={() => setDialog({})}>+ Your own…</button>
              </div>
              <p className="muted small">
                Pick an entry on the left, or use + next to a category to add one. Right-click for
                more.
              </p>
            </article>
          )}
        </div>
      </main>

      <footer className="status-bar small">
        <span>
          {view.entries.length} {view.entries.length === 1 ? 'entry' : 'entries'} in{' '}
          {view.world.categories.length}{' '}
          {view.world.categories.length === 1 ? 'category' : 'categories'}
        </span>
        <span className="status-spacer" />
        <span className={save.state === 'error' ? 'error' : 'muted'} role="status">
          {save.state === 'error'
            ? `Not saved: ${save.error} (retrying)`
            : { saved: 'Saved', unsaved: 'Editing…', saving: 'Saving…' }[save.state]}
        </span>
      </footer>

      {dialog && (
        <CategoryDialog
          worldId={worldId}
          category={dialog.category}
          onDone={() => setDialog(null)}
        />
      )}
    </div>
  )
}
