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
  const aiOn = settings.ai.enabled
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

  /** Accepts an AI suggestion; one Undo takes the change back out and puts the item back. */
  const accept = async (item: InboxItem) => {
    const s = item.suggestion
    try {
      const before =
        s?.type === 'fact' ? await api.invoke('entry:read', { worldId, entryId: s.entryId }) : null
      const done = await api.invoke('inbox:accept', { worldId, itemId: item.id })
      record({
        label: `Accepted: ${item.text}`,
        undo: async () => {
          if (s?.type === 'new' && done.entryId) {
            await api.invoke('trash:add', {
              target: { kind: 'entry', worldId, entryId: done.entryId },
            })
          } else if (s?.type === 'fact' && before) {
            await api.invoke('entry:save', {
              worldId,
              entryId: before.id,
              patch: { facts: before.facts, quotes: before.quotes },
            })
          } else if (done.relationshipId) {
            await api.invoke('relationship:delete', {
              worldId,
              relationshipId: done.relationshipId,
            })
          }
          await api.invoke('inbox:restore', { worldId, item })
        },
      })
    } catch (err) {
      fail(err)
    }
  }

  /** Lets an AI finding go (it was fine, or not wanted); Undo brings it back. */
  const letGo = async (item: InboxItem, label: string) => {
    try {
      await api.invoke('inbox:dismiss', { worldId, itemId: item.id })
      record({ label, undo: () => api.invoke('inbox:restore', { worldId, item }) })
    } catch (err) {
      fail(err)
    }
  }

  /** Takes back a change the AI made itself. */
  const undoApplied = async (item: InboxItem) => {
    try {
      await api.invoke('inbox:undo', { worldId, itemId: item.id })
      toast(`Undone: ${item.text}`)
    } catch (err) {
      fail(err)
    }
  }

  /** The changes look right: clear them from the list (they stay in the world). */
  const clearApplied = async (items: InboxItem[]) => {
    try {
      for (const item of items) await api.invoke('inbox:dismiss', { worldId, itemId: item.id })
      record({
        label: 'Cleared the AI’s changes from the list',
        undo: async () => {
          for (const item of items) await api.invoke('inbox:restore', { worldId, item })
        },
      })
    } catch (err) {
      fail(err)
    }
  }

  /** The AI decides what each new name is (or that it isn't one); it runs in the background. */
  const [sorting, setSorting] = useState(false)
  const sortNames = async (names: NameSuggestion[]) => {
    const seriesId = world.index?.chapters[0]?.seriesId
    if (!seriesId || !names.length) return
    setSorting(true)
    try {
      await api.invoke('ai:sortNames', {
        requestId: `${Date.now()}-${names.length}`,
        seriesId,
        worldId,
        names: names.slice(0, 300).map((n) => ({
          name: n.name,
          quote: n.quote,
          chapterId: n.chapterId,
        })),
      })
    } catch (err) {
      const e = describeError(err)
      if (e.code !== 'cancelled') toast(e.message)
    } finally {
      setSorting(false)
    }
  }

  const answer = async (item: InboxItem, text: string) => {
    try {
      await api.invoke('inbox:answer', { worldId, itemId: item.id, answer: text })
      toast('Thanks. The AI will know this from now on.')
    } catch (err) {
      fail(err)
    }
  }

  if (!inbox) return null
  const captured = inbox.captured.filter((i) => i.kind === 'captured')
  const found = inbox.captured.filter((i) => i.kind !== 'captured')
  const byChapter = new Map<string, NameSuggestion[]>()
  for (const s of inbox.names)
    byChapter.set(s.chapterId, [...(byChapter.get(s.chapterId) ?? []), s])
  const chapterLabel = (chapterId: string) => {
    const at = world.positions.get(chapterId)
    return at === undefined ? 'A chapter' : chapterName(world.index!.chapters[at]!)
  }
  const empty = !inbox.captured.length && !inbox.names.length
  const byKind = (kind: InboxItem['kind']) => found.filter((i) => i.kind === kind)
  const quoteOf = (item: InboxItem) => (
    <footer className="small muted">
      {item.quote ? `“${item.quote}” · ` : ''}
      {chapterLabel(item.source.chapterId)}
    </footer>
  )

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

      {byKind('applied').length > 0 && (
        <section aria-label="Done by the AI">
          <h2>Done by the AI</h2>
          <p className="muted small">
            Changes the AI made to the world from your chapters. Undo any that are wrong; clear the
            list when they look right.{' '}
            <button className="link small" onClick={() => void clearApplied(byKind('applied'))}>
              They look right: clear the list
            </button>
          </p>
          <ul className="inbox-list">
            {byKind('applied').map((item) => (
              <li key={item.id} className="inbox-item">
                <div>
                  <strong>{item.text}</strong>
                  {quoteOf(item)}
                </div>
                <div className="row">
                  {item.entryId && world.byId.has(item.entryId) && (
                    <button onClick={() => props.onOpenEntry(item.entryId!)}>Open</button>
                  )}
                  <button className="link" onClick={() => void undoApplied(item)}>
                    Undo
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {byKind('suggestion').length > 0 && (
        <section aria-label="Suggestions">
          <h2>Suggestions from the AI</h2>
          <p className="muted small">
            What the AI noticed in your chapters. Nothing changes until you accept it.
          </p>
          <ul className="inbox-list">
            {byKind('suggestion').map((item) => (
              <li key={item.id} className="inbox-item">
                <div>
                  <strong>{item.text}</strong>
                  {quoteOf(item)}
                </div>
                <div className="row">
                  <button onClick={() => void accept(item)}>Accept</button>
                  {item.entryId && world.byId.has(item.entryId) && (
                    <button className="link" onClick={() => props.onOpenEntry(item.entryId!)}>
                      Open
                    </button>
                  )}
                  <button
                    className="link"
                    onClick={() => void letGo(item, 'Turned down a suggestion')}
                  >
                    Not this
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {byKind('continuity').length > 0 && (
        <section aria-label="May not fit">
          <h2>May not fit</h2>
          <p className="muted small">
            Places where a chapter and the world seem to disagree. Fix whichever is wrong, or let it
            be.
          </p>
          <ul className="inbox-list">
            {byKind('continuity').map((item) => (
              <li key={item.id} className="inbox-item">
                <div>
                  <strong>{item.text}</strong>
                  {quoteOf(item)}
                </div>
                <div className="row">
                  {item.entryId && world.byId.has(item.entryId) && (
                    <button onClick={() => props.onOpenEntry(item.entryId!)}>
                      Open {world.byId.get(item.entryId)!.name}
                    </button>
                  )}
                  <button
                    className="link"
                    onClick={() => void letGo(item, 'Let a continuity note go')}
                  >
                    Fine as it is
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {byKind('question').length > 0 && (
        <section aria-label="Questions">
          <h2>Questions for you</h2>
          <p className="muted small">
            Things the AI couldn’t tell. Your answer is kept, and the AI won’t ask again.
          </p>
          <ul className="inbox-list">
            {byKind('question').map((item) => (
              <li key={item.id} className="inbox-item inbox-question">
                <div>
                  <strong>{item.text}</strong>
                  {quoteOf(item)}
                </div>
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const field = e.currentTarget.elements.namedItem('answer') as HTMLInputElement
                    if (field.value.trim()) void answer(item, field.value)
                  }}
                >
                  <input
                    name="answer"
                    aria-label={`Answer: ${item.text}`}
                    placeholder="Your answer"
                  />
                  <button type="submit">Answer</button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => void letGo(item, 'Skipped a question')}
                  >
                    Skip
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {captured.length > 0 && (
        <section aria-label="Captured">
          <h2>Captured</h2>
          <ul className="inbox-list">
            {captured.map((item) => (
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
          {aiOn && (
            <p className="row">
              <button disabled={sorting} onClick={() => void sortNames(inbox.names)}>
                {sorting ? 'Sorting with the AI…' : 'Sort these with the AI'}
              </button>
              <span className="muted small">
                It decides what each one is (a person, a place, an event…) and sets aside what isn’t
                a name, like holidays. You can undo any of it.
              </span>
            </p>
          )}
          {[...byChapter].map(([chapterId, names]) => (
            <div key={chapterId} className="inbox-chapter">
              <h3 className="small">
                First in {chapterLabel(chapterId)}{' '}
                {names.length > 1 && !aiOn && (
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
