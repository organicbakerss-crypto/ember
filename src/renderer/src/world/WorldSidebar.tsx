import { useState, type FormEvent } from 'react'
import type { EntrySummary, WorldView } from '@shared/ipc'
import type { WorldCategory } from '@shared/schema'
import { api, describeError } from '../api'
import { EditableText } from '../components/EditableText'
import { useOverlays, type MenuItem } from '../components/overlays'
import { useCollapsed } from '../binder/useCollapsed'

/** Categories and their entries. */
export function WorldSidebar(props: {
  view: WorldView
  selectedId: string | null
  renamingId: string | null
  onRenamingChange: (id: string | null) => void
  onSelect: (entryId: string) => void
  onCreated: (entryId: string) => void
  onNewCategory: () => void
  onEditCategory: (category: WorldCategory) => void
  onDeleteCategory: (category: WorldCategory) => void
  onTrashEntry: (entry: EntrySummary) => void
}) {
  const { view } = props
  const worldId = view.world.id
  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState<string | null>(null) // category id, or 'none'
  const collapsed = useCollapsed()
  const { openMenu, toast } = useOverlays()

  const q = filter.trim().toLowerCase()
  const visible = (e: EntrySummary) =>
    !q || e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q))

  const groups: { category: WorldCategory | null; entries: EntrySummary[] }[] =
    view.world.categories.map((c) => ({
      category: c,
      entries: view.entries.filter((e) => e.categoryId === c.id),
    }))
  const loose = view.entries.filter(
    (e) => !e.categoryId || !view.world.categories.some((c) => c.id === e.categoryId),
  )
  if (loose.length || adding === 'none') groups.push({ category: null, entries: loose })

  const menu = (items: MenuItem[]) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    openMenu(e, items)
  }
  const entryMenu = (entry: EntrySummary): MenuItem[] => [
    { label: 'Rename', hint: 'F2', onSelect: () => props.onRenamingChange(entry.id) },
    {
      label: 'Move to category',
      submenu: [
        ...view.world.categories.map((c) => ({
          label: c.name,
          disabled: entry.categoryId === c.id,
          onSelect: () => void move(entry.id, c.id),
        })),
        {
          label: 'No category',
          disabled: !entry.categoryId,
          onSelect: () => void move(entry.id, null),
        },
      ],
    },
    { label: 'Delete', danger: true, onSelect: () => props.onTrashEntry(entry) },
  ]
  const categoryMenu = (category: WorldCategory): MenuItem[] => [
    { label: 'New entry', onSelect: () => setAdding(category.id) },
    { label: 'Rename', hint: 'F2', onSelect: () => props.onRenamingChange(category.id) },
    { label: 'Edit sections…', onSelect: () => props.onEditCategory(category) },
    { label: 'Delete', danger: true, onSelect: () => props.onDeleteCategory(category) },
  ]

  const move = async (entryId: string, categoryId: string | null) => {
    try {
      await api.invoke('entry:save', { worldId, entryId, patch: { categoryId } })
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  return (
    <div className="world-sidebar">
      <input
        type="search"
        aria-label="Filter entries"
        placeholder="Filter entries"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <ul className="binder-list">
        {groups.map(({ category, entries }) => {
          const key = category?.id ?? 'none'
          const folded = !q && collapsed.isCollapsed(key, false)
          const shown = entries.filter(visible)
          if (q && !shown.length) return null
          return (
            <li key={key} className="binder-arc">
              <div
                className="binder-arc-header"
                onContextMenu={category ? menu(categoryMenu(category)) : undefined}
              >
                <button
                  className="icon chevron"
                  aria-label={folded ? 'Expand category' : 'Collapse category'}
                  aria-expanded={!folded}
                  onClick={() => collapsed.setCollapsed(key, !folded)}
                >
                  {folded ? '▸' : '▾'}
                </button>
                <span className="binder-arc-name">
                  {category ? (
                    <EditableText
                      value={category.name}
                      editing={props.renamingId === category.id}
                      onEditingChange={(on) => props.onRenamingChange(on ? category.id : null)}
                      onRename={(name) =>
                        api.invoke('category:update', { worldId, categoryId: category.id, name })
                      }
                    />
                  ) : (
                    <span className="muted">No category</span>
                  )}
                  <span className="muted small"> · {entries.length}</span>
                </span>
                <span className="binder-arc-actions">
                  <button className="icon" title="New entry" onClick={() => setAdding(key)}>
                    +
                  </button>
                </span>
              </div>
              {!folded && (
                <ul className="binder-arc-list">
                  {shown.map((entry) => (
                    <li key={entry.id}>
                      <div
                        className={`binder-row ${entry.id === props.selectedId ? 'selected' : ''}`}
                        role="button"
                        tabIndex={0}
                        onClick={() => props.onSelect(entry.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') props.onSelect(entry.id)
                          if (e.key === 'F2') props.onRenamingChange(entry.id)
                        }}
                        onContextMenu={menu(entryMenu(entry))}
                      >
                        <EditableText
                          className="binder-title"
                          value={entry.name}
                          editing={props.renamingId === entry.id}
                          onEditingChange={(on) => props.onRenamingChange(on ? entry.id : null)}
                          onRename={(name) =>
                            api.invoke('entry:save', {
                              worldId,
                              entryId: entry.id,
                              patch: { name },
                            })
                          }
                        />
                      </div>
                    </li>
                  ))}
                  {adding === key && (
                    <li>
                      <NewEntry
                        worldId={worldId}
                        categoryId={category?.id ?? null}
                        onDone={(id) => {
                          setAdding(null)
                          if (id) props.onCreated(id)
                        }}
                      />
                    </li>
                  )}
                  {!entries.length && adding !== key && (
                    <li className="binder-empty muted small">No entries yet</li>
                  )}
                </ul>
              )}
            </li>
          )
        })}
      </ul>
      <footer className="binder-footer">
        <button className="link" onClick={props.onNewCategory}>
          + Category
        </button>
      </footer>
    </div>
  )
}

function NewEntry(props: {
  worldId: string
  categoryId: string | null
  onDone: (entryId?: string) => void
}) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return props.onDone()
    try {
      const entry = await api.invoke('entry:create', {
        worldId: props.worldId,
        name,
        categoryId: props.categoryId,
      })
      props.onDone(entry.id)
    } catch (err) {
      setError(describeError(err).message)
    }
  }
  return (
    <form className="inline-create" onSubmit={(e) => void submit(e)}>
      <input
        autoFocus
        aria-label="New entry name"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && props.onDone()}
        onBlur={() => !name.trim() && props.onDone()}
      />
      {error && <span className="error small">{error}</span>}
    </form>
  )
}
