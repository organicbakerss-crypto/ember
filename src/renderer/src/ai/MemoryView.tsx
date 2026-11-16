import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSummary, LibraryProblem } from '@shared/ipc'
import type { MemoryNodeFile, MemoryState } from '@shared/schema'
import { stretches, type MemoryDraft } from '@shared/memory/build'
import type { TidySuggestion } from '@shared/memory/tidy'
import type { IdeaCheck } from '@shared/memory/check'
import { api, describeError, useIpcEvent } from '../api'
import { loadLocal, saveLocal } from '../storage'
import { MemoryMap } from './MemoryMap'
import { useOverlays } from '../components/overlays'

const STATE_LABEL: Record<MemoryState, string> = {
  fixed: 'Fixed',
  unfixed: 'Unfixed',
  whim: 'Whim',
  rejected: 'Rejected',
}
const STATES: MemoryState[] = ['fixed', 'unfixed', 'whim', 'rejected']
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * The story's memory: topics ("nodes") worked out in conversations, each
 * with points that are fixed, unfixed, whims or rejected. The writer sees
 * everything and can change anything; rejected things are kept for them but
 * hidden from the AI.
 */
export function MemoryView(props: {
  seriesId: string
  conversations: ConversationSummary[]
  /** Open "Make nodes" with this conversation ticked. */
  makeFrom?: string | null
  /** Shows Close (inside the AI pane); the General ideas screen has its own Back. */
  onClose?: () => void
  /** On the General ideas screen (its own heading). */
  onPage?: boolean
  onOpenConversation: (id: string) => void
}) {
  const { seriesId } = props
  const { toast, choose } = useOverlays()
  const [nodes, setNodes] = useState<MemoryNodeFile[] | null>(null)
  const [problems, setProblems] = useState<LibraryProblem[]>([])
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [making, setMaking] = useState(!!props.makeFrom)
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState<MemoryState | 'all'>('all')
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tidying, setTidying] = useState(false)
  /** Checking against the chapters: null (not), 'review' (what's waiting), 'story' (read every chapter first). */
  const [checking, setChecking] = useState<'review' | 'story' | null>(null)
  const [waiting, setWaiting] = useState(0)
  const countWaiting = useCallback(() => {
    api.invoke('memory:checks', { seriesId }).then(
      (list) => setWaiting(list.length),
      () => {},
    )
  }, [seriesId])
  useEffect(countWaiting, [countWaiting])
  useIpcEvent('memory:checked', (e) => {
    if (e.seriesId === seriesId) countWaiting()
  })
  const [storyName, setStoryName] = useState('this story')
  const [books, setBooks] = useState<{ id: string; name: string }[]>([])
  const [mode, setMode] = useState<'list' | 'map'>(() =>
    loadLocal('memory.view') === 'map' ? 'map' : 'list',
  )
  const pickMode = (m: 'list' | 'map') => {
    setMode(m)
    saveLocal('memory.view', m)
  }
  // The topics the last answer read glow on the map for a few seconds.
  const [glow, setGlow] = useState<string[]>([])
  const glowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const shine = useCallback((ids: string[]) => {
    setGlow(ids)
    clearTimeout(glowTimer.current)
    glowTimer.current = setTimeout(() => setGlow([]), 4000)
  }, [])
  useEffect(() => () => clearTimeout(glowTimer.current), [])
  useEffect(() => {
    api.invoke('memory:lastUsed', { seriesId }).then(
      (used) => {
        if (used && Date.now() - used.at < 10 * 60 * 1000) shine(used.nodeIds)
      },
      () => {},
    )
  }, [seriesId, shine])
  useIpcEvent('memory:used', (e) => {
    if (e.seriesId === seriesId) shine(e.nodeIds)
  })
  useEffect(() => {
    let live = true
    api.invoke('library:snapshot').then(
      (snap) => {
        const series = snap.series.find((s) => s.id === seriesId)
        if (live && series) {
          setStoryName(series.name)
          setBooks(series.volumes.map((v) => ({ id: v.id, name: v.name })))
        }
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [seriesId])

  // Only the latest answer counts (a reload can be overtaken by a newer one).
  const loads = useRef(0)
  const load = useCallback(() => {
    const ticket = ++loads.current
    api.invoke('memory:list', { seriesId }).then(
      (r) => {
        if (ticket !== loads.current) return
        setNodes(r.nodes)
        setProblems(r.problems)
      },
      (err: unknown) => setError(describeError(err).message),
    )
  }, [seriesId])
  useEffect(load, [load])
  // The draft: read once, then kept current by its own updates.
  useEffect(() => {
    let live = true
    api.invoke('memory:draft', { seriesId }).then(
      (d) => live && setDraft(d),
      (err: unknown) => live && setError(describeError(err).message),
    )
    return () => {
      live = false
    }
  }, [seriesId])
  useIpcEvent('memory:draft', (e) => {
    if (e.seriesId === seriesId) setDraft(e.draft)
  })
  useIpcEvent('library:changed', (c) => {
    if (c.kind === 'series' && c.seriesId === seriesId) load()
  })

  const save = async (node: MemoryNodeFile, what: string) => {
    const at = new Date().toISOString()
    const next = {
      ...node,
      updatedAt: at,
      history: [...node.history, { at, by: 'writer' as const, what }],
    }
    setNodes((all) => all?.map((n) => (n.id === node.id ? next : n)) ?? null)
    try {
      await api.invoke('memory:save', { seriesId, nodes: [next] })
    } catch (err) {
      toast(describeError(err).message)
      load()
    }
  }

  /** Saves a change that isn't worth listing (where a circle sits on the map). */
  const quietly = async (next: MemoryNodeFile[]) => {
    setNodes((all) => all?.map((n) => next.find((x) => x.id === n.id) ?? n) ?? null)
    try {
      await api.invoke('memory:save', { seriesId, nodes: next })
    } catch (err) {
      toast(describeError(err).message)
      load()
    }
  }
  const moveNode = (
    id: string,
    pos: { x: number; y: number },
    all: Map<string, { x: number; y: number }>,
  ) => {
    // The first move pins every circle where it is, so the others don't rearrange around it.
    const changed = (nodes ?? [])
      .filter((n) => n.id === id || (!n.pos && all.has(n.id)))
      .map((n) => ({ ...n, pos: n.id === id ? pos : all.get(n.id)! }))
    if (changed.length) void quietly(changed)
  }
  /** Drop one circle on another: link them, or unlink them if they were linked. */
  const linkNodes = (aId: string, bId: string) => {
    const a = nodes?.find((x) => x.id === aId)
    const b = nodes?.find((x) => x.id === bId)
    if (!a || !b) return
    const at = new Date().toISOString()
    const linked = a.links.includes(b.id) || b.links.includes(a.id)
    const change = (n: MemoryNodeFile, other: MemoryNodeFile): MemoryNodeFile => ({
      ...n,
      links: linked
        ? n.links.filter((l) => l !== other.id)
        : n === a
          ? [...n.links, other.id]
          : n.links,
      updatedAt: at,
      history: [
        ...n.history,
        {
          at,
          by: 'writer' as const,
          what: `${linked ? 'Unlinked from' : 'Linked to'} “${other.title}”`,
        },
      ],
    })
    void quietly([change(a, b), change(b, a)])
    toast(`${linked ? 'Unlinked' : 'Linked'} “${a.title}” and “${b.title}”.`)
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (nodes ?? [])
      .filter(
        (n) => filter === 'all' || n.state === filter || n.points.some((p) => p.state === filter),
      )
      .filter(
        (n) =>
          !q ||
          n.title.toLowerCase().includes(q) ||
          n.summary.toLowerCase().includes(q) ||
          n.points.some((p) => p.text.toLowerCase().includes(q)),
      )
      .sort((a, b) => Number(b.loose) - Number(a.loose) || a.title.localeCompare(b.title))
  }, [nodes, filter, query])

  const node = nodes?.find((n) => n.id === open) ?? null

  return (
    <div className="memory-view">
      <header className="memory-head">
        <div>
          {!props.onPage && <strong>General ideas</strong>}
          <div className="muted small">
            {nodes ? `${nodes.length} ${nodes.length === 1 ? 'topic' : 'topics'}` : 'Loading…'} ·
            the AI reads what helps when you ask; rejected ideas are kept for you, hidden from it
          </div>
        </div>
        <span className="status-spacer" />
        {!draft && !making && !tidying && !checking && (
          <>
            {waiting > 0 && (
              <button
                className="primary"
                title="What checking your chapters found: ideas now on the page, ideas the page went against, new ideas"
                onClick={() => setChecking('review')}
              >
                From the page ({waiting})
              </button>
            )}
            <button
              title="Have the AI read your chapters and check the ideas against them: what's now on the page, what the page went against, what's new"
              disabled={!nodes?.length}
              onClick={() => setChecking('story')}
            >
              Check against the story…
            </button>
            <button
              title="Have the AI look over the memory: link related topics, merge duplicates, move points, file loose ends"
              disabled={(nodes?.length ?? 0) < 2}
              onClick={() => setTidying(true)}
            >
              Tidy up…
            </button>
            <button onClick={() => setMaking(true)}>Make nodes…</button>
          </>
        )}
        {props.onClose && <button onClick={props.onClose}>Close</button>}
      </header>
      {error && <p className="error small">{error}</p>}
      {problems.length > 0 && (
        <p className="error small">
          {problems.length} memory {problems.length === 1 ? 'file' : 'files'} can’t be read and
          {problems.length === 1 ? ' was' : ' were'} left as{' '}
          {problems.length === 1 ? 'it is' : 'they are'}: {problems[0]!.path}
        </p>
      )}

      {checking && !draft ? (
        <ChecksPanel
          seriesId={seriesId}
          read={checking === 'story'}
          onDone={(message) => {
            setChecking(null)
            if (message) toast(message)
            countWaiting()
            load()
          }}
        />
      ) : tidying && !draft ? (
        <TidyPanel
          seriesId={seriesId}
          nodes={nodes ?? []}
          onDone={(message) => {
            setTidying(false)
            if (message) toast(message)
            load()
          }}
        />
      ) : draft ? (
        draft.phase === 'sorting' || draft.phase === 'sorted' ? (
          <SortPanel draft={draft} seriesId={seriesId} onDone={() => setMaking(false)} />
        ) : (
          <DraftPanel
            draft={draft}
            seriesId={seriesId}
            onOpenConversation={props.onOpenConversation}
            onDone={(kept) => {
              if (kept) toast(kept)
              setMaking(false)
              load()
            }}
          />
        )
      ) : making ? (
        <MakeForm
          key={storyName}
          seriesId={seriesId}
          storyName={storyName}
          conversations={props.conversations}
          makeFrom={props.makeFrom ?? null}
          onCancel={() => setMaking(false)}
          onStarted={setDraft}
        />
      ) : node ? (
        <NodeDetail
          node={node}
          onBack={() => setOpen(null)}
          onSave={save}
          onDelete={async () => {
            const sure = await choose(
              `Delete “${node.title}”?`,
              [{ value: 'delete', label: 'Delete', danger: true }],
              'It goes to this computer’s trash folder. To keep it for yourself but hide it from the AI, mark it Rejected instead.',
            )
            if (!sure) return
            await api
              .invoke('memory:delete', { seriesId, nodeId: node.id })
              .catch((err: unknown) => toast(describeError(err).message))
            setOpen(null)
            load()
          }}
          onOpenConversation={props.onOpenConversation}
        />
      ) : (
        <>
          <div className="segmented small memory-mode" role="radiogroup" aria-label="View">
            {(['list', 'map'] as const).map((m) => (
              <button
                key={m}
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? 'active' : ''}
                onClick={() => pickMode(m)}
              >
                {m === 'list' ? 'List' : 'Map'}
              </button>
            ))}
          </div>
          {mode === 'map' ? (
            <MemoryMap
              nodes={nodes ?? []}
              books={books}
              glow={glow}
              onOpen={setOpen}
              onMove={moveNode}
              onLink={linkNodes}
              onArrange={() =>
                void choose(
                  'Arrange the map again?',
                  [{ value: 'go', label: 'Arrange again', primary: true }],
                  'Every circle goes to a fresh place (connected topics close together). Where you put circles yourself is forgotten.',
                ).then((go) => {
                  if (go && nodes?.some((n) => n.pos))
                    void quietly(nodes.filter((n) => n.pos).map((n) => ({ ...n, pos: null })))
                })
              }
            />
          ) : (
            <>
              <div className="memory-filters">
                <div className="segmented small" role="radiogroup" aria-label="Show">
                  {(['all', ...STATES] as const).map((s) => (
                    <button
                      key={s}
                      role="radio"
                      aria-checked={filter === s}
                      className={filter === s ? 'active' : ''}
                      onClick={() => setFilter(s)}
                    >
                      {s === 'all' ? 'All' : STATE_LABEL[s]}
                    </button>
                  ))}
                </div>
                <input
                  type="search"
                  aria-label="Find in the memory"
                  placeholder="Find…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              {nodes?.length === 0 && (
                <div className="memory-empty muted">
                  <p>Nothing in this story’s memory yet.</p>
                  <p className="small">
                    Use “Make nodes…” to read your conversations (including chats brought in from
                    ChatGPT) into topics, with what’s decided, what’s still a proposal, and your
                    whims.
                  </p>
                </div>
              )}
              <ul className="memory-list">
                {shown.map((n) => (
                  <li
                    key={n.id}
                    className={`memory-node state-${n.state} ${n.loose ? 'loose' : ''}`}
                  >
                    <button className="memory-node-open" onClick={() => setOpen(n.id)}>
                      <span className="memory-node-title">{n.title}</span>
                      {!n.loose && (
                        <span className={`memory-chip state-${n.state}`}>
                          {STATE_LABEL[n.state]}
                        </span>
                      )}
                      <span className="muted small">
                        {STATES.filter((s) => n.points.some((p) => p.state === s))
                          .map(
                            (s) =>
                              `${n.points.filter((p) => p.state === s).length} ${STATE_LABEL[s].toLowerCase()}`,
                          )
                          .join(' · ') || 'no points'}
                      </span>
                      {n.summary && <span className="memory-node-summary small">{n.summary}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}

function StateSelect(props: {
  value: MemoryState
  label: string
  onChange: (s: MemoryState) => void
}) {
  return (
    <select
      className={`memory-state state-${props.value}`}
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as MemoryState)}
    >
      {STATES.map((s) => (
        <option key={s} value={s}>
          {STATE_LABEL[s]}
        </option>
      ))}
    </select>
  )
}

function NodeDetail(props: {
  node: MemoryNodeFile
  onBack: () => void
  onSave: (node: MemoryNodeFile, what: string) => Promise<void>
  onDelete: () => void
  onOpenConversation: (id: string) => void
}) {
  const { node } = props
  const [editing, setEditing] = useState<string | null>(null)
  const [text, setText] = useState('')
  const at = () => new Date().toISOString()
  const setPoint = (id: string, change: Partial<MemoryNodeFile['points'][number]>, what: string) =>
    void props.onSave(
      {
        ...node,
        points: node.points.map((p) => (p.id === id ? { ...p, ...change, updatedAt: at() } : p)),
      },
      what,
    )
  return (
    <div className="memory-detail">
      <button className="link small" onClick={props.onBack}>
        ← All topics
      </button>
      <div className="memory-detail-head">
        <h3>{node.title}</h3>
        {!node.loose && (
          <StateSelect
            value={node.state}
            label={`State of “${node.title}”`}
            onChange={(s) =>
              void props.onSave(
                { ...node, state: s },
                `Topic marked ${STATE_LABEL[s].toLowerCase()}`,
              )
            }
          />
        )}
        <span className="status-spacer" />
        <button className="link small danger" onClick={props.onDelete}>
          Delete topic
        </button>
      </div>
      {node.summary && <p className="memory-summary">{node.summary}</p>}
      {node.state === 'rejected' && (
        <p className="muted small">
          Rejected: kept here for you, but the AI never sees this topic.
        </p>
      )}
      {STATES.map((state) => {
        const points = node.points.filter((p) => p.state === state)
        if (!points.length) return null
        return (
          <section key={state} className={`memory-points state-${state}`}>
            <h4 className="small">{STATE_LABEL[state]}</h4>
            <ul>
              {points.map((p) => {
                const src = p.sources[p.sources.length - 1]
                return (
                  <li key={p.id}>
                    {editing === p.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (text.trim() && text.trim() !== p.text)
                            setPoint(p.id, { text: text.trim() }, 'Point reworded')
                          setEditing(null)
                        }}
                      >
                        <textarea
                          autoFocus
                          aria-label="Point"
                          rows={3}
                          value={text}
                          onChange={(e) => setText(e.target.value)}
                        />
                        <div className="row small">
                          <button type="submit">Save</button>
                          <button type="button" className="link" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <p className="memory-point-text">{p.text}</p>
                    )}
                    <div className="memory-point-meta small">
                      <StateSelect
                        value={p.state}
                        label="State of this point"
                        onChange={(s) =>
                          setPoint(
                            p.id,
                            { state: s },
                            `Point marked ${STATE_LABEL[s].toLowerCase()}: ${p.text.slice(0, 60)}`,
                          )
                        }
                      />
                      {src &&
                        (src.conversationId ? (
                          <button
                            className="link muted"
                            title={src.quote ? `“${src.quote}”` : undefined}
                            onClick={() => props.onOpenConversation(src.conversationId)}
                          >
                            from “{src.title}”, {day(src.at)}
                          </button>
                        ) : (
                          <span className="muted" title={src.quote ? `“${src.quote}”` : undefined}>
                            from {src.title}, {day(src.at)}
                          </span>
                        ))}
                      <span className="status-spacer" />
                      <button
                        className="link"
                        onClick={() => {
                          setText(p.text)
                          setEditing(p.id)
                        }}
                      >
                        Edit
                      </button>
                      <button
                        className="link danger"
                        onClick={() =>
                          void props.onSave(
                            { ...node, points: node.points.filter((x) => x.id !== p.id) },
                            `Point deleted: ${p.text.slice(0, 80)}`,
                          )
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
      {node.history.length > 0 && (
        <details className="memory-history small">
          <summary>Changes ({node.history.length})</summary>
          <ul>
            {[...node.history].reverse().map((h, i) => (
              <li key={i}>
                {day(h.at)} · {h.by === 'ai' ? 'AI' : 'You'}: {h.what}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function MakeForm(props: {
  seriesId: string
  storyName: string
  conversations: ConversationSummary[]
  makeFrom: string | null
  onCancel: () => void
  onStarted: (d: MemoryDraft) => void
}) {
  const usable = props.conversations.filter((c) => !c.roundtable)
  const [picked, setPicked] = useState<Set<string>>(
    () =>
      new Set(
        props.makeFrom ? [props.makeFrom] : usable.filter((c) => c.imported).map((c) => c.id),
      ),
  )
  const [instruction, setInstruction] = useState(`Only the ideas for “${props.storyName}”`)
  const [clues, setClues] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const messages = usable.filter((c) => picked.has(c.id)).reduce((n, c) => n + c.count, 0)
  return (
    <form
      className="memory-make"
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        api
          .invoke('memory:make', {
            seriesId: props.seriesId,
            conversationIds: [...picked],
            instruction,
            clues,
            from: from || null,
            to: to || null,
          })
          .then(props.onStarted, (err: unknown) => setError(describeError(err).message))
          .finally(() => setBusy(false))
      }}
    >
      <h3>Make nodes</h3>
      <p className="muted small">
        The AI reads the conversations you pick, in parts, and sorts what fits your instruction into
        topics. Nothing is added until you’ve looked at it. Long chats take a while (it runs in the
        background; you can keep working).
      </p>
      <fieldset>
        <legend className="small">Conversations</legend>
        <ul className="memory-make-list">
          {usable.map((c) => (
            <li key={c.id}>
              <label className="radio">
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={(e) =>
                    setPicked((s) => {
                      const next = new Set(s)
                      if (e.target.checked) next.add(c.id)
                      else next.delete(c.id)
                      return next
                    })
                  }
                />
                {c.title}{' '}
                <span className="muted small">
                  · {c.count.toLocaleString()} messages{c.imported ? ' · from ChatGPT' : ''}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <label>
        What to take
        <textarea
          aria-label="What to take"
          rows={3}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </label>
      <label>
        What your story has in it <span className="muted small">(optional)</span>
        <textarea
          aria-label="What your story has in it"
          rows={2}
          placeholder="Main characters, places, the plot in a line: helps tell it apart in a chat about several stories"
          value={clues}
          onChange={(e) => setClues(e.target.value)}
        />
      </label>
      <p className="muted small">
        First the whole chat is sorted by which story each part is about, so early parts are judged
        with what comes later. You check the sorting, then nodes are made from your story’s parts
        only.
      </p>
      <div className="row small memory-dates">
        <label>
          From{' '}
          <input
            type="date"
            aria-label="From"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To{' '}
          <input type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="muted">(optional)</span>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={busy || !picked.size}>
          {busy ? 'Starting…' : `Start (${messages.toLocaleString()} messages)`}
        </button>
        <button type="button" className="link" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function DraftPanel(props: {
  draft: MemoryDraft
  seriesId: string
  onOpenConversation: (id: string) => void
  onDone: (message: string | null) => void
}) {
  const { draft, seriesId } = props
  const [unticked, setUnticked] = useState<Set<string>>(new Set())
  const [include, setInclude] = useState<Set<number>>(new Set())
  const [shownNode, setShownNode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const done = draft.parts.filter((p) => p.status !== 'pending').length
  const skipped = draft.parts.filter((p) => p.status === 'skipped')
  const failed = draft.parts.filter((p) => p.status === 'failed')
  const points = draft.nodes.reduce((n, d) => n + d.points.length, 0) + draft.loose.length
  const running = draft.state === 'running'
  const run = (p: Promise<unknown>) =>
    p.catch((err: unknown) => setError(describeError(err).message))
  const keys = [...draft.nodes.map((n) => n.key), ...(draft.loose.length ? ['loose'] : [])]
  const toggle = (key: string) =>
    setUnticked((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <div className="memory-draft">
      <h3>Make nodes{draft.instruction ? `: ${draft.instruction}` : ''}</h3>
      <p className="small" role="status">
        {running ? 'Reading' : draft.state === 'done' ? 'Read' : 'Stopped at'} part {done} of{' '}
        {draft.parts.length} · {draft.nodes.length} topics, {points} points found
        {skipped.length ? ` · ${skipped.length} parts skipped` : ''}
        {failed.length ? ` · ${failed.length} failed` : ''}
      </p>
      <progress max={draft.parts.length} value={done} />
      {draft.error && <p className="muted small">{draft.error}</p>}
      {error && <p className="error small">{error}</p>}
      <div className="row">
        {running ? (
          <button onClick={() => void run(api.invoke('memory:stop', { seriesId }))}>Stop</button>
        ) : (
          <>
            {(draft.state !== 'done' || failed.length > 0) && (
              <button
                onClick={() => void run(api.invoke('memory:continue', { seriesId, include: [] }))}
              >
                Continue
              </button>
            )}
            <button
              className="primary"
              disabled={!keys.some((k) => !unticked.has(k))}
              onClick={() =>
                void run(
                  api
                    .invoke('memory:keep', { seriesId, only: keys.filter((k) => !unticked.has(k)) })
                    .then((r) => props.onDone(`Added to the story’s memory: ${r.nodes} topics.`)),
                )
              }
            >
              Keep {keys.length - unticked.size === keys.length ? 'all' : 'ticked'}
            </button>
            <button
              className="link danger"
              onClick={() =>
                void run(api.invoke('memory:discard', { seriesId }).then(() => props.onDone(null)))
              }
            >
              Discard
            </button>
          </>
        )}
      </div>

      {(draft.nodes.length > 0 || draft.loose.length > 0) && (
        <ul className="memory-draft-nodes">
          {draft.nodes.map((n) => (
            <li key={n.key}>
              <label className="radio">
                <input
                  type="checkbox"
                  checked={!unticked.has(n.key)}
                  disabled={running}
                  onChange={() => toggle(n.key)}
                />
                <strong>{n.title}</strong>
                <span className={`memory-chip state-${n.state}`}>{STATE_LABEL[n.state]}</span>
                <span className="muted small">
                  {n.points.length} points{n.existingId ? ' · adds to an existing topic' : ''}
                </span>
              </label>
              <button
                className="link small"
                onClick={() => setShownNode((k) => (k === n.key ? null : n.key))}
              >
                {shownNode === n.key ? 'Hide' : 'Show'}
              </button>
              {shownNode === n.key && (
                <div className="memory-draft-points small">
                  {n.summary && <p>{n.summary}</p>}
                  <ul>
                    {n.points.map((p, i) => (
                      <li key={i}>
                        <span className={`memory-chip state-${p.state}`}>
                          {STATE_LABEL[p.state]}
                        </span>{' '}
                        {p.text}
                        {p.changed && <span className="muted"> ({p.changed})</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
          {draft.loose.length > 0 && (
            <li>
              <label className="radio">
                <input
                  type="checkbox"
                  checked={!unticked.has('loose')}
                  disabled={running}
                  onChange={() => toggle('loose')}
                />
                <strong>Loose ends</strong>
                <span className="muted small">{draft.loose.length} points</span>
              </label>
            </li>
          )}
        </ul>
      )}

      {skipped.length > 0 && !running && (
        <details className="memory-skipped">
          <summary className="small">
            {skipped.length} parts skipped as not fitting “{draft.instruction || 'this story'}”:
            check them
          </summary>
          <ul>
            {skipped.map((p) => (
              <li key={p.index} className="small">
                <label className="radio">
                  <input
                    type="checkbox"
                    checked={include.has(p.index)}
                    onChange={(e) =>
                      setInclude((s) => {
                        const next = new Set(s)
                        if (e.target.checked) next.add(p.index)
                        else next.delete(p.index)
                        return next
                      })
                    }
                  />
                  <span>
                    <b>
                      {day(p.firstAt)}
                      {p.lastAt.slice(0, 10) !== p.firstAt.slice(0, 10)
                        ? ` – ${day(p.lastAt)}`
                        : ''}
                    </b>{' '}
                    <span className="muted">({p.reason})</span>
                    <br />“{p.preview}…”
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <button
            disabled={!include.size}
            onClick={() =>
              void run(
                api
                  .invoke('memory:continue', { seriesId, include: [...include] })
                  .then(() => setInclude(new Set())),
              )
            }
          >
            Read the ticked parts too
          </button>
        </details>
      )}
    </div>
  )
}

/** Pass 1: sorting the conversation by story, then the writer checks which stretches are theirs. */
function SortPanel(props: { draft: MemoryDraft; seriesId: string; onDone: () => void }) {
  const { draft, seriesId } = props
  const [mine, setMine] = useState<Set<number>>(
    () => new Set(draft.parts.filter((p) => p.mine).map((p) => p.index)),
  )
  const [shown, setShown] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sorting = draft.phase === 'sorting'
  const running = draft.state === 'running'
  const labelled = draft.parts.filter((p) => p.label).length
  const run = (p: Promise<unknown>) =>
    p.catch((err: unknown) => setError(describeError(err).message))
  // The AI's marks, as the draft has them once sorting is done (until the writer changes them).
  const [seen, setSeen] = useState(draft.phase)
  if (seen !== draft.phase) {
    setSeen(draft.phase)
    setMine(new Set(draft.parts.filter((p) => p.mine).map((p) => p.index)))
  }
  const runs = stretches(draft.parts.map((p) => ({ ...p, mine: mine.has(p.index) })))
  const setRange = (from: number, to: number, on: boolean) =>
    setMine((s) => {
      const next = new Set(s)
      for (let i = from; i <= to; i++) {
        if (on) next.add(i)
        else next.delete(i)
      }
      return next
    })
  const words = draft.parts.filter((p) => mine.has(p.index)).reduce((n, p) => n + p.words, 0)
  return (
    <div className="memory-draft memory-sort">
      <h3>Make nodes{draft.instruction ? `: ${draft.instruction}` : ''}</h3>
      {sorting ? (
        <>
          <p className="small" role="status">
            Step 1 of 2: sorting the chat by story · part {labelled} of {draft.parts.length}
          </p>
          <progress max={draft.parts.length} value={labelled} />
        </>
      ) : (
        <p className="small" role="status">
          Step 1 done. Check which parts are your story, then make nodes from them.
        </p>
      )}
      {draft.error && <p className="muted small">{draft.error}</p>}
      {error && <p className="error small">{error}</p>}
      <div className="row">
        {running ? (
          <button onClick={() => void run(api.invoke('memory:stop', { seriesId }))}>Stop</button>
        ) : sorting ? (
          <button
            onClick={() => void run(api.invoke('memory:continue', { seriesId, include: [] }))}
          >
            Continue
          </button>
        ) : (
          <button
            className="primary"
            disabled={!mine.size}
            onClick={() => void run(api.invoke('memory:read', { seriesId, mine: [...mine] }))}
          >
            Make nodes from {mine.size} {mine.size === 1 ? 'part' : 'parts'} (
            {words.toLocaleString()} words)
          </button>
        )}
        <button
          className="link danger"
          onClick={() => void run(api.invoke('memory:discard', { seriesId }).then(props.onDone))}
        >
          Discard
        </button>
      </div>
      {!sorting && draft.identity && (
        <p className="memory-identity small">
          <b>Your story, as worked out from the whole chat:</b> {draft.identity}
        </p>
      )}
      {labelled > 0 && (
        <ol className="memory-timeline">
          {runs.map((r) => {
            const parts = draft.parts.slice(r.from, r.to + 1)
            const about = parts.map((p) => p.about).filter(Boolean)
            const open = shown === r.from
            return (
              <li key={`${r.from}-${r.label}`} className={r.mine ? 'mine' : ''}>
                <label className="radio">
                  <input
                    type="checkbox"
                    aria-label={`Your story: ${r.label}, ${day(r.firstAt)}`}
                    checked={r.mine}
                    disabled={sorting}
                    onChange={(e) => setRange(r.from, r.to, e.target.checked)}
                  />
                  <span>
                    <b>
                      {day(r.firstAt)}
                      {r.lastAt.slice(0, 10) !== r.firstAt.slice(0, 10)
                        ? ` – ${day(r.lastAt)}`
                        : ''}
                    </b>{' '}
                    <span className="memory-label">{r.label}</span>{' '}
                    <span className="muted small">
                      · {parts.length} {parts.length === 1 ? 'part' : 'parts'}
                      {about[0] ? ` · ${about[0]}` : ''}
                    </span>
                  </span>
                </label>
                <button className="link small" onClick={() => setShown(open ? null : r.from)}>
                  {open ? 'Hide' : 'Peek'}
                </button>
                {open && (
                  <ul className="memory-timeline-parts small">
                    {parts.map((p) => (
                      <li key={p.index}>
                        <label className="radio">
                          <input
                            type="checkbox"
                            aria-label={`Part ${p.index + 1} is your story`}
                            checked={mine.has(p.index)}
                            disabled={sorting}
                            onChange={(e) => setRange(p.index, p.index, e.target.checked)}
                          />
                          <span>
                            {day(p.firstAt)} · {p.about || p.label}
                            <br />
                            <span className="muted">“{p.preview}…”</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

const TIDY_GROUPS: { kind: TidySuggestion['kind']; label: string }[] = [
  { kind: 'link', label: 'Connections' },
  { kind: 'merge', label: 'Merge topics that are the same thing' },
  { kind: 'move', label: 'Move points to where they belong' },
  { kind: 'file', label: 'File loose ends' },
  { kind: 'split', label: 'Points that are topics of their own' },
]

/** Tidy up: the AI reviews the memory; the writer ticks which suggestions to make. */
const CHECK_GROUPS: { kind: IdeaCheck['kind']; label: string; ticked: boolean }[] = [
  { kind: 'onPage', label: 'Now on the page: mark fixed', ticked: true },
  {
    kind: 'contradicted',
    label: 'The page went another way: mark rejected (kept for you, hidden from the AI)',
    ticked: false,
  },
  { kind: 'fresh', label: 'New from the page: add as fixed ideas', ticked: true },
]

/** What checking chapters found, for the writer to tick (optionally reading every chapter first). */
function ChecksPanel(props: {
  seriesId: string
  read: boolean
  onDone: (message: string | null) => void
}) {
  const { seriesId } = props
  const [requestId] = useState(
    () => `check-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  const [progress, setProgress] = useState('Reading the chapters…')
  const [checks, setChecks] = useState<IdeaCheck[] | null>(null)
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useIpcEvent('ai:progress', (e) => {
    if (e.requestId === requestId && e.text) setProgress(e.text)
  })
  useEffect(() => {
    let live = true
    const show = (list: IdeaCheck[]) => {
      if (!live) return
      setChecks(list)
      setTicked(
        new Set(
          list.filter((c) => CHECK_GROUPS.find((g) => g.kind === c.kind)?.ticked).map((c) => c.id),
        ),
      )
    }
    const fail = (err: unknown) => {
      if (!live) return
      const e = describeError(err)
      if (e.code === 'cancelled') props.onDone(null)
      else setError(e.message)
    }
    ;(props.read ? api.invoke('memory:checkStory', { seriesId, requestId }) : Promise.resolve())
      .then(() => api.invoke('memory:checks', { seriesId }))
      .then(show, fail)
    return () => {
      live = false
    }
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const describe = (c: IdeaCheck) =>
    c.kind === 'fresh' ? (
      <>
        “{c.text}”{' '}
        <span className="muted">
          →{' '}
          {c.nodeId ? (
            <b>{c.topic}</b>
          ) : (
            <>
              a new topic <b>{c.topic}</b>
            </>
          )}
        </span>
      </>
    ) : (
      <>
        “{c.text}”{' '}
        <span className="muted">
          in <b>{c.topic}</b>
        </span>
        {c.kind === 'contradicted' && c.why && <span className="muted small"> · {c.why}</span>}
      </>
    )

  return (
    <div className="memory-draft memory-tidy memory-checks">
      <h3>From the page</h3>
      {error && <p className="error small">{error}</p>}
      {!checks && !error && (
        <>
          <p className="small" role="status">
            {progress}
          </p>
          <progress />
          <div className="row">
            <button onClick={() => void api.invoke('ai:cancel', { requestId })}>Stop</button>
          </div>
        </>
      )}
      {error && (
        <div className="row">
          <button onClick={() => props.onDone(null)}>Close</button>
        </div>
      )}
      {checks && checks.length === 0 && (
        <>
          <p className="small">
            Nothing to change: your ideas and your chapters agree, and the chapters set up nothing
            new.
          </p>
          <div className="row">
            <button onClick={() => props.onDone(null)}>Close</button>
          </div>
        </>
      )}
      {checks && checks.length > 0 && (
        <>
          <p className="small muted">
            Your chapters checked against your ideas: the page is what’s true. Tick what to change;
            nothing changes until you press the button, and every change is listed on its topic.
          </p>
          {CHECK_GROUPS.map((g) => {
            const items = checks.filter((c) => c.kind === g.kind)
            if (!items.length) return null
            return (
              <section key={g.kind} className="memory-tidy-group">
                <h4 className="small">
                  {g.label} ({items.length})
                </h4>
                <ul>
                  {items.map((c) => (
                    <li key={c.id}>
                      <label className="radio">
                        <input
                          type="checkbox"
                          checked={ticked.has(c.id)}
                          onChange={() => toggle(c.id)}
                        />
                        <span>
                          {describe(c)}
                          <span className="muted small">
                            {' '}
                            · “{c.chapterTitle}”{c.quote ? `: “${c.quote}”` : ''}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
          <div className="row">
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true)
                const apply = checks.filter((c) => ticked.has(c.id)).map((c) => c.id)
                const dismiss = checks.filter((c) => !ticked.has(c.id)).map((c) => c.id)
                api
                  .invoke('memory:checksApply', { seriesId, apply, dismiss })
                  .then((r) =>
                    props.onDone(
                      r.applied
                        ? `${r.applied} ${r.applied === 1 ? 'change' : 'changes'} made from the page.`
                        : 'Set aside; nothing changed.',
                    ),
                  )
                  .catch((err: unknown) => setError(describeError(err).message))
                  .finally(() => setBusy(false))
              }}
            >
              {ticked.size
                ? `Make ${ticked.size} ${ticked.size === 1 ? 'change' : 'changes'}`
                : 'Set them all aside'}
            </button>
            <button disabled={busy} onClick={() => props.onDone(null)}>
              Later
            </button>
          </div>
          <p className="small muted">The unticked ones are set aside when you press the button.</p>
        </>
      )}
    </div>
  )
}

function TidyPanel(props: {
  seriesId: string
  nodes: MemoryNodeFile[]
  onDone: (message: string | null) => void
}) {
  const { seriesId, nodes } = props
  const [requestId] = useState(() => `tidy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const [progress, setProgress] = useState('Reviewing the memory…')
  const [found, setFound] = useState<TidySuggestion[] | null>(null)
  const [off, setOff] = useState<Set<number>>(new Set())
  const [arrange, setArrange] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useIpcEvent('ai:progress', (e) => {
    if (e.requestId === requestId && e.text) setProgress(e.text)
  })
  useEffect(() => {
    let live = true
    api.invoke('memory:tidy', { seriesId, requestId }).then(
      (r) => live && setFound(r.suggestions),
      (err: unknown) => {
        if (!live) return
        const e = describeError(err)
        if (e.code === 'cancelled') props.onDone(null)
        else setError(e.message)
      },
    )
    return () => {
      live = false
    }
    // Once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const title = (id: string) => nodes.find((n) => n.id === id)?.title ?? '(gone)'
  const pointText = (id: string) => {
    for (const n of nodes) {
      const p = n.points.find((x) => x.id === id)
      if (p) return { text: p.text, from: n }
    }
    return null
  }
  const clip = (t: string, n = 90) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
  const describe = (s: TidySuggestion) => {
    switch (s.kind) {
      case 'link':
        return (
          <>
            Link <b>{title(s.a)}</b> and <b>{title(s.b)}</b>
          </>
        )
      case 'merge':
        return (
          <>
            Merge {s.merge.map((m) => `“${title(m)}”`).join(', ')} into <b>{title(s.keep)}</b>
            {s.title && s.title !== title(s.keep) ? <> (as “{s.title}”)</> : null}
          </>
        )
      case 'move': {
        const p = pointText(s.point)
        return (
          <>
            Move “{clip(p?.text ?? '')}” from <b>{p?.from.title}</b> to <b>{title(s.to)}</b>
          </>
        )
      }
      case 'file':
        return (
          <>
            File {s.points.length === 1 ? 'a loose end' : `${s.points.length} loose ends`} into{' '}
            {s.to ? (
              <b>{title(s.to)}</b>
            ) : (
              <>
                a new topic <b>{s.title}</b>
              </>
            )}
            :{' '}
            <span className="muted">
              {s.points.map((p) => `“${clip(pointText(p)?.text ?? '', 50)}”`).join(', ')}
            </span>
          </>
        )
      case 'split': {
        const p = pointText(s.point)
        return (
          <>
            Make “{clip(p?.text ?? '')}” its own topic <b>{s.title}</b>, under{' '}
            <b>{p?.from.title}</b>
          </>
        )
      }
    }
  }
  const kept = (found ?? []).filter((_, i) => !off.has(i))
  const toggle = (i: number) =>
    setOff((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  return (
    <div className="memory-draft memory-tidy">
      <h3>Tidy up</h3>
      {error && <p className="error small">{error}</p>}
      {!found && !error && (
        <>
          <p className="small" role="status">
            {progress}
          </p>
          <progress />
          <div className="row">
            <button onClick={() => void api.invoke('ai:cancel', { requestId })}>Stop</button>
          </div>
        </>
      )}
      {error && (
        <div className="row">
          <button onClick={() => props.onDone(null)}>Close</button>
        </div>
      )}
      {found && found.length === 0 && (
        <>
          <p className="small">Nothing to tidy: the AI found no changes worth making.</p>
          <div className="row">
            <button onClick={() => props.onDone(null)}>Close</button>
          </div>
        </>
      )}
      {found && found.length > 0 && (
        <>
          <p className="small muted">
            Untick anything you don’t want. Nothing changes until you press the button; fixed,
            unfixed and whim stay as they are. Every change is listed on its topic.
          </p>
          {TIDY_GROUPS.map((g) => {
            const items = found.map((s, i) => ({ s, i })).filter((x) => x.s.kind === g.kind)
            if (!items.length) return null
            return (
              <section key={g.kind} className="memory-tidy-group">
                <h4 className="small">
                  {g.label} ({items.length})
                </h4>
                <ul>
                  {items.map(({ s, i }) => (
                    <li key={i}>
                      <label className="radio">
                        <input type="checkbox" checked={!off.has(i)} onChange={() => toggle(i)} />
                        <span>
                          {describe(s)}
                          {s.why && <span className="muted small"> · {s.why}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
          <label className="radio small">
            <input
              type="checkbox"
              checked={arrange}
              onChange={(e) => setArrange(e.target.checked)}
            />
            Arrange the map again afterwards (linked topics end up close together)
          </label>
          <div className="row">
            <button
              className="primary"
              disabled={busy || !kept.length}
              onClick={() => {
                setBusy(true)
                api
                  .invoke('memory:tidyApply', { seriesId, kept })
                  .then(async (r) => {
                    if (arrange) {
                      const fresh = await api.invoke('memory:list', { seriesId })
                      const placed = fresh.nodes.filter((n) => n.pos)
                      if (placed.length)
                        await api.invoke('memory:save', {
                          seriesId,
                          nodes: placed.map((n) => ({ ...n, pos: null })),
                        })
                    }
                    props.onDone(
                      `Tidied up: ${r.changed} ${r.changed === 1 ? 'topic' : 'topics'} changed${r.removed ? `, ${r.removed} merged away` : ''}.`,
                    )
                  })
                  .catch((err: unknown) => setError(describeError(err).message))
                  .finally(() => setBusy(false))
              }}
            >
              {busy
                ? 'Making the changes…'
                : `Make ${kept.length} ${kept.length === 1 ? 'change' : 'changes'}`}
            </button>
            <button className="link" onClick={() => props.onDone(null)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  )
}
