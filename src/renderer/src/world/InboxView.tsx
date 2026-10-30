import { useWords } from '../skins/useWords'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EntrySummary, NameSuggestion, WorldInbox } from '@shared/ipc'
import type { InboxItem } from '@shared/schema'
import { chapterName } from '@shared/world/story'
import { api, describeError, useIpcEvent } from '../api'
import { useOverlays, type MenuItem } from '../components/overlays'
import { useSettings } from '../useTheme'
import { EntryPicker } from './EntryPicker'
import { templateOf } from './model'
import type { UndoStep } from './useUndo'
import type { WorldData } from './useWorld'
import type { WorldActions } from './useWorldActions'

const ADD_AS: { label: string; template: string }[] = [
  { label: 'A person', template: 'person' },
  { label: 'A place', template: 'city' },
  { label: 'A faction', template: 'faction' },
  { label: 'A creature', template: 'creature' },
  { label: 'An event', template: 'event' },
  { label: 'A system (magic, law…)', template: 'magic' },
]

/**
 * The inbox: a quiet review queue. Things captured from the manuscript wait
 * here to be filed; new names the app noticed wait to be added or turned down.
 * Nothing here is in the world until it's accepted.
 */
export function InboxView(props: {
  world: WorldData
  actions: WorldActions
  record: (step: UndoStep) => void
  onOpenEntry: (entryId: string) => void
}) {
  const { world, record } = props
  const word = useWords()
  const worldId = world.view.world.id
  const { settings } = useSettings()
  const withNames = settings.world.nameCatcher
  const { openMenu, toast } = useOverlays()
  const [inbox, setInbox] = useState<WorldInbox | null>(null)
  const [filing, setFiling] = useState<InboxItem | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback(() => {
    api
      .invoke('inbox:get', { worldId, names: withNames })
      .then(setInbox, (err) => toast(describeError(err).message))
  }, [worldId, withNames, toast])
  useEffect(load, [load])
  useEffect(() => () => clearTimeout(timer.current), [])
  useIpcEvent('library:changed', (c) => {
    if ('worldId' in c && c.worldId === worldId) load()
    else if (c.kind === 'chapter' || c.kind === 'outline') {
      clearTimeout(timer.current)
      timer.current = setTimeout(load, 1500)
    }
  })

  const fail = (err: unknown) => toast(describeError(err).message)

  const dismiss = async (item: InboxItem) => {
    try {
      await api.invoke('inbox:dismiss', { worldId, itemId: item.id })
      record({
        label: 'Dismissed a captured line',
        undo: () => api.invoke('inbox:capture', { worldId, text: item.text, source: item.source }),
      })
    } catch (err) {
      fail(err)
    }
  }

  const fileUnder = (
    item: InboxItem,
    entry: EntrySummary,
    e: { clientX: number; clientY: number },
  ) => {
    const fields = templateOf(world, entry).fields.filter((f) => f.kind === 'text')
    const file = async (field: string | null, label: string) => {
      try {
        const before = await api.invoke('entry:read', { worldId, entryId: entry.id })
        await api.invoke('inbox:file', { worldId, itemId: item.id, entryId: entry.id, field })
        record({
          label: `Filed under ${entry.name} → ${label}`,
          undo: async () => {
            await api.invoke('entry:save', {
              worldId,
              entryId: entry.id,
              patch: { quotes: before.quotes },
            })
            await api.invoke('inbox:capture', { worldId, text: item.text, source: item.source })
          },
        })
      } catch (err) {
        fail(err)
      }
    }
    const items: MenuItem[] = [
      ...fields.map((f) => ({ label: f.label, onSelect: () => void file(f.id, f.label) })),
      { label: 'Notes', onSelect: () => void file(null, 'Notes') },
    ]
    openMenu(e, items)
  }

  const reject = async (names: string[]) => {
    try {
      await api.invoke('names:reject', { worldId, names, rejected: true })
      record({
        label:
          names.length === 1
            ? `“${names[0]}” won’t be suggested again`
            : `${names.length} names won’t be suggested again`,
        undo: () => api.invoke('names:reject', { worldId, names, rejected: false }),
      })
    } catch (err) {
      fail(err)
    }
  }

  const addAs = (names: string[], e: { clientX: number; clientY: number }) =>
    openMenu(
      e,
      ADD_AS.map((a) => ({
        label: a.label,
        onSelect: async () => {
          for (const name of names) await props.actions.create(name, a.template)
        },
      })),
    )

  if (!inbox) return null
  const byChapter = new Map<string, NameSuggestion[]>()
  for (const s of inbox.names)
    byChapter.set(s.chapterId, [...(byChapter.get(s.chapterId) ?? []), s])
  const chapterLabel = (chapterId: string) => {
    const at = world.positions.get(chapterId)
    return at === undefined ? 'A chapter' : chapterName(world.index!.chapters[at]!)
  }
  const empty = !inbox.captured.length && !inbox.names.length

  return (
    <div className="inbox lens-view">
      <header className="lens-head">
        <h1>{word('inbox', 'Inbox')}</h1>
      </header>
      {empty && (
        <p className="muted">
          Nothing waiting. Select a line in a chapter and right-click “Capture to the world” to save
          it here
          {withNames ? '; new names that keep coming up in your chapters appear here too.' : '.'}
        </p>
      )}

      {inbox.captured.length > 0 && (
        <section aria-label="Captured">
          <h2>Captured</h2>
          <ul className="inbox-list">
            {inbox.captured.map((item) => (
              <li key={item.id} className="inbox-item">
                <blockquote className="quote">
                  <p>“{item.text}”</p>
                  <footer className="small muted">{chapterLabel(item.source.chapterId)}</footer>
                </blockquote>
                <div className="row">
                  <button onClick={() => setFiling(item)}>File under…</button>
                  <button className="link" onClick={() => void dismiss(item)}>
                    Dismiss
                  </button>
                </div>
                {filing?.id === item.id && (
                  <EntryPicker
                    world={world}
                    placeholder="Which entry is it about?"
                    onPick={(entry) => {
                      setFiling(null)
                      const rect = document.activeElement?.getBoundingClientRect()
                      fileUnder(item, entry, {
                        clientX: rect?.left ?? 200,
                        clientY: rect?.bottom ?? 200,
                      })
                    }}
                    onCreate={async (name) => {
                      setFiling(null)
                      const created = await props.actions.create(name, 'person')
                      if (created) {
                        await api
                          .invoke('inbox:file', {
                            worldId,
                            itemId: item.id,
                            entryId: created.id,
                            field: null,
                          })
                          .catch(fail)
                      }
                    }}
                    onCancel={() => setFiling(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {inbox.names.length > 0 && (
        <section aria-label="New names">
          <h2>New names</h2>
          <p className="muted small">
            Capitalised words that keep coming up in your chapters but aren’t in the world yet.
          </p>
          {[...byChapter].map(([chapterId, names]) => (
            <div key={chapterId} className="inbox-chapter">
              <h3 className="small">
                First in {chapterLabel(chapterId)}{' '}
                {names.length > 1 && (
                  <>
                    <button
                      className="link small"
                      onClick={(e) =>
                        addAs(
                          names.map((n) => n.name),
                          e,
                        )
                      }
                    >
                      Accept all from this chapter
                    </button>{' '}
                    <button
                      className="link small"
                      onClick={() => void reject(names.map((n) => n.name))}
                    >
                      Reject all
                    </button>
                  </>
                )}
              </h3>
              <ul className="inbox-list">
                {names.map((s) => (
                  <li key={s.name} className="inbox-item">
                    <div>
                      <strong>{s.name}</strong> <span className="muted small">{s.count} times</span>
                      <p className="small muted">“{s.quote}”</p>
                    </div>
                    <div className="row">
                      <button onClick={(e) => addAs([s.name], e)}>Add…</button>
                      <button className="link" onClick={() => void reject([s.name])}>
                        Not a name
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
