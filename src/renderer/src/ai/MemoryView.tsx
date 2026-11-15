import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSummary, LibraryProblem } from '@shared/ipc'
import type { MemoryNodeFile, MemoryState } from '@shared/schema'
import { stretches, type MemoryDraft } from '@shared/memory/build'
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
  onClose: () => void
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
          <strong>Story memory</strong>
          <div className="muted small">
            {nodes ? `${nodes.length} ${nodes.length === 1 ? 'topic' : 'topics'}` : 'Loading…'} ·
            the AI reads what helps when you ask; rejected ideas are kept for you, hidden from it
          </div>
        </div>
        <span className="status-spacer" />
        {!draft && !making && <button onClick={() => setMaking(true)}>Make nodes…</button>}
        <button onClick={props.onClose}>Close</button>
      </header>
      {error && <p className="error small">{error}</p>}
      {problems.length > 0 && (
        <p className="error small">
          {problems.length} memory {problems.length === 1 ? 'file' : 'files'} can’t be read and
          {problems.length === 1 ? ' was' : ' were'} left as{' '}
          {problems.length === 1 ? 'it is' : 'they are'}: {problems[0]!.path}
        </p>
      )}

      {draft ? (
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
                      {src && (
                        <button
                          className="link muted"
                          title={src.quote ? `“${src.quote}”` : undefined}
                          onClick={() => props.onOpenConversation(src.conversationId)}
                        >
                          from “{src.title}”, {day(src.at)}
                        </button>
                      )}
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
