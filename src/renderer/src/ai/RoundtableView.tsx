import { useEffect, useRef, useState } from 'react'
import { ROUNDTABLE_CAST } from '@shared/ai/roundtableCast'
import { newId } from '@shared/ids'
import type { ConversationFile } from '@shared/schema'
import type { ConversationSummary, RoundtableRunStatus } from '@shared/ipc'
import {
  advancePhase, nextParticipant, phaseIsReady, PHASE_NAMES, roundtableResults,
  type RoundtableSession, type RoundtablePost,
} from '@shared/ai/roundtable'
import { api, describeError, useIpcEvent } from '../api'
import { parse } from './markdown'
import { Blocks } from './FormattedAnswer'
import './roundtable.css'

type Tab = 'floor' | 'board' | 'network' | 'results' | `person:${string}`
const TABS: { id: Tab; title: string }[] = [
  { id: 'floor', title: 'Open Floor' },
  { id: 'board', title: 'Message Board' },
  { id: 'network', title: 'Network' },
  { id: 'results', title: 'Rankings' },
]
const available = ROUNDTABLE_CAST.map(({ id, name, kind }) => ({ id, name, kind }))
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

export function RoundtableView({ seriesId, onBack }: { seriesId: string; onBack: () => void }) {
  const [topic, setTopic] = useState('')
  const [selected, setSelected] = useState<string[]>(['john-ai', 'roman', 'bo'])
  const [file, setFile] = useState<ConversationFile | null>(null)
  const [saved, setSaved] = useState<ConversationSummary[]>([])
  const [tab, setTab] = useState<Tab>('floor')
  const [runStatus, setRunStatus] = useState<RoundtableRunStatus | null>(null)
  const currentSessionId = useRef<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const activeRequest = useRef<string | null>(null)
  const [error, setError] = useState('')
  const [userText, setUserText] = useState('')
  const [privateText, setPrivateText] = useState('')
  const [sender, setSender] = useState('')
  const [recipient, setRecipient] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const session = file?.roundtable
  const automatic = (runStatus?.state === 'running' || runStatus?.state === 'pausing') && runStatus.conversationId === file?.id
  const members = session?.participants ?? []
  const name = (speakerId: string) => members.find((p) => p.id === speakerId)?.name ?? 'You'

  const refresh = () => void api.invoke('ai:conversations', { seriesId })
    .then((all) => setSaved(all.filter((c) => c.roundtable)))
    .catch((err) => setError(describeError(err).message))

  useEffect(() => { refresh() }, [seriesId])

  const reloadCurrent = () => {
    const conversationId = currentSessionId.current
    if (!conversationId) return
    void api.invoke('ai:conversation', { seriesId, conversationId })
      .then((conversation) => { if (currentSessionId.current === conversationId) setFile(conversation) })
      .catch((err) => setError(describeError(err).message))
  }
  useIpcEvent('library:changed', (change) => {
    if (change.kind === 'library' || (change.kind === 'series' && change.seriesId === seriesId)) reloadCurrent()
  })
  useIpcEvent('ai:roundtableStatus', (status) => {
    if (status.seriesId !== seriesId || status.conversationId !== currentSessionId.current) return
    setRunStatus(status)
    setActive(status.speakerId)
    reloadCurrent()
  })
  const updateStatus = (conversationId: string) => {
    void api.invoke('ai:roundtableStatus', { seriesId, conversationId })
      .then((status) => { if (currentSessionId.current === conversationId) setRunStatus(status) })
      .catch(() => {})
  }
  const run = async (conversationId: string) => {
    setError('')
    try { setRunStatus(await api.invoke('ai:roundtableRun', { seriesId, conversationId })) }
    catch (err) { setError(describeError(err).message) }
  }
  const pause = async () => {
    if (!file) return
    try { setRunStatus(await api.invoke('ai:roundtablePause', { seriesId, conversationId: file.id })) }
    catch (err) { setError(describeError(err).message) }
  }

  const persist = async (base: ConversationFile, state: RoundtableSession) => {
    const next: ConversationFile = { ...base, updatedAt: new Date().toISOString(), roundtable: state }
    await api.invoke('ai:saveConversation', { seriesId, conversation: next })
    currentSessionId.current = next.id
    setFile(next)
    refresh()
  }

  const start = async () => {
    if (!topic.trim() || selected.length < 2 || selected.length > 12) return
    const now = new Date().toISOString()
    const participants = selected.map((key) => available.find((p) => p.id === key)!).filter(Boolean)
    const state: RoundtableSession = { topic: topic.trim(), participants, phase: 'proposals', posts: [] }
    const base: ConversationFile = {
      formatVersion: 1, id: newId('conversation'), mode: 'chat',
      characterId: 'john-ai', title: `Roundtable: ${topic.trim().slice(0, 110)}`,
      createdAt: now, updatedAt: now, messages: [], roundtable: state,
    }
    setError('')
    try { await persist(base, state); setTab('floor'); await run(base.id) }
    catch (err) { setError(describeError(err).message) }
  }

  const load = async (conversationId: string) => {
    setError('')
    try {
      const conversation = await api.invoke('ai:conversation', { seriesId, conversationId })
      if (!conversation.roundtable) throw new Error('Not a Roundtable session.')
      currentSessionId.current = conversation.id
      setFile(conversation)
      updateStatus(conversation.id)
      setTab('floor')
    } catch (err) { setError(describeError(err).message) }
  }

  const makePost = (state: RoundtableSession, speakerId: string, text: string,
    channel: RoundtablePost['channel'], targetId: string | null, ranking?: string[]): RoundtablePost => ({
    id: id(), at: new Date().toISOString(), phase: state.phase,
    speakerId, targetId, channel, text, ...(ranking ? { ranking } : {}),
  })

  const contribute = async (direct = false) => {
    if (!file || !session || busy || automatic) return
    const person = direct ? members.find((p) => p.id === sender) : nextParticipant(session)
    const target = direct ? recipient : null
    if (!person || (direct && (!target || target === person.id))) return
    setBusy(person.id)
    const requestId = id()
    activeRequest.current = requestId
    setActive(person.id)
    setError('')
    try {
      const output = await api.invoke('ai:roundtableTurn', {
        requestId, session, speakerId: person.id, targetId: target, direct,
      })
      const channel = direct ? 'direct' : session.phase === 'revision' ? 'private'
        : session.phase === 'vote' ? 'ballot' : 'open'
      await persist(file, {
        ...session, posts: [...session.posts,
          makePost(session, person.id, output.text, channel, target, output.ranking ?? undefined)],
      })
      setActive(direct ? target : person.id)
    } catch (err) { setError(describeError(err).message) }
    finally { activeRequest.current = null; setBusy(null) }
  }

  const advance = async () => {
    if (!file || !session || !phaseIsReady(session) || busy || automatic) return
    setError('')
    try {
      const next = advancePhase(session)
      await persist(file, next)
      setTab(next.phase === 'complete' ? 'results' : 'floor')
    } catch (err) { setError(describeError(err).message) }
  }

  const addUserPost = async () => {
    if (!file || !session || !userText.trim() || busy || automatic || session.phase === 'complete') return
    try {
      await persist(file, { ...session, posts: [...session.posts,
        makePost(session, 'writer', userText.trim(), 'user', null)] })
      setUserText('')
    } catch (err) { setError(describeError(err).message) }
  }

  const askParticipant = async () => {
    const personId = tab.startsWith('person:') ? tab.slice(7) : null
    if (!file || !session || !personId || !privateText.trim() || automatic || busy) return
    const question = privateText.trim()
    setPrivateText('')
    setError('')
    setBusy(personId)
    const requestId = id()
    activeRequest.current = requestId
    try {
      const withQuestion: RoundtableSession = {
        ...session, posts: [...session.posts, makePost(session, 'writer', question, 'user', personId)],
      }
      const savedBase: ConversationFile = { ...file, roundtable: withQuestion }
      await persist(file, withQuestion)
      const response = await api.invoke('ai:roundtablePrivate', {
        requestId, session: withQuestion, speakerId: personId, question,
      })
      await persist(savedBase, {
        ...withQuestion, posts: [...withQuestion.posts,
          makePost(session, personId, response.text, 'direct', 'writer')],
      })
    } catch (err) { setError(describeError(err).message) }
    finally { activeRequest.current = null; setBusy(null) }
  }

  const remove = async (conversationId: string) => {
    if (busy || automatic || !window.confirm('Delete this Roundtable session?')) return
    try {
      await api.invoke('ai:deleteConversation', { seriesId, conversationId })
      if (file?.id === conversationId) { currentSessionId.current = null; setFile(null); setRunStatus(null) }
      refresh()
    } catch (err) { setError(describeError(err).message) }
  }

  const currentPerson = tab.startsWith('person:') ? tab.slice(7) : null
  const sealed = session?.posts.filter((p) => p.phase === 'final' && p.channel === 'private' && !!p.summary) ?? []
  const resultsReady = session?.phase === 'vote' || session?.phase === 'complete'
  const visiblePosts = (session?.posts ?? []).filter((post) =>
    currentPerson ? (post.speakerId === currentPerson || post.targetId === currentPerson) &&
        post.channel !== 'ballot' && (post.channel !== 'private' || (post.speakerId === currentPerson && post.phase !== 'final') || resultsReady) :
    tab === 'board' ? post.channel === 'direct' :
      tab === 'floor' ? post.channel === 'open' || (post.channel === 'user' && !post.targetId) :
        tab === 'results' ? post.channel === 'ballot' : post.channel !== 'private')
  const connections = (session?.posts ?? []).filter((post) => post.channel === 'direct' && post.targetId)
  const ballotCount = session?.posts.filter((p) => p.phase === 'vote' && p.channel === 'ballot').length ?? 0

  return <div className="rt-root">
    <header className="rt-header">
      <button className="link" onClick={onBack}>← AI chat</button>
      <strong>Roundtable</strong>
      <span className="status-spacer" />
      {session && <button className="link" disabled={!!busy} onClick={() => { currentSessionId.current = null; setFile(null); setRunStatus(null) }}>New Roundtable</button>}
    </header>
    {error && <div className="error rt-error" role="alert">{error}</div>}
    {!session ? <div className="rt-setup">
      <h3>Start a Roundtable</h3>
      <p className="muted">Each participant proposes an approach, debates, revises, privately locks a final proposal, then ranks the other locked proposals. Once started, the discussion proceeds automatically. You can pause it whenever needed.</p>
      <label>Question or problem<textarea rows={4} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What should this group discuss?" maxLength={4000} /></label>
      <div className="rt-picker"><strong>Participants ({selected.length}/12)</strong>
        <div className="rt-choice-grid">
          {available.map((p) => <label key={p.id} className="rt-choice">
            <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected((list) =>
              e.target.checked ? list.length < 12 ? [...list, p.id] : list : list.filter((id) => id !== p.id))} />
            {p.name}
          </label>)}
        </div>
        <p className="muted small">Specialists and guest stars will appear after their profiles are approved. Current characters are available for infrastructure testing.</p>
      </div>
      <button className="primary" disabled={!topic.trim() || selected.length < 2 || selected.length > 12} onClick={() => void start()}>Create Roundtable</button>
      {!!saved.length && <section className="rt-saved"><h3>Previous Roundtables</h3>
        {saved.map((c) => <div className="rt-saved-row" key={c.id}>
          <button className="link" onClick={() => void load(c.id)}>{c.title}</button>
          <button className="icon" title="Delete session" onClick={() => void remove(c.id)}>✕</button>
        </div>)}
      </section>}
    </div> : <div className="rt-workspace">
      <div className="rt-topic"><strong>{session.topic}</strong><span className="muted small">{PHASE_NAMES[session.phase]} · {members.length} participants</span></div>
      <nav className="rt-tabs" aria-label="Roundtable views">
        {TABS.map((t) => <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>{t.title}</button>)}
        <span className="rt-tab-divider" />
        {members.map((member) => <button key={member.id} className={tab === `person:${member.id}` ? 'active' : ''}
          onClick={() => setTab(`person:${member.id}`)}>{member.name}</button>)}
      </nav>
      {tab === 'network' ? <div className="rt-network">
        <svg viewBox="0 0 560 460" role="img" aria-label="Open Floor in the center, all participants linked around it">
          {members.map((p, i) => {
            const angle = -Math.PI / 2 + i * Math.PI * 2 / members.length
            const x = 280 + Math.cos(angle) * 195
            const y = 230 + Math.sin(angle) * 175
            return <g key={p.id}>
              <line x1={280} y1={230} x2={x} y2={y} className={active === p.id ? 'rt-line active' : 'rt-line'} />

            </g>
          })}
          {connections.map((post) => {
            const from = members.findIndex((p) => p.id === post.speakerId)
            const to = members.findIndex((p) => p.id === post.targetId)
            if (from < 0 || to < 0) return null
            const a = -Math.PI / 2 + from * Math.PI * 2 / members.length
            const b = -Math.PI / 2 + to * Math.PI * 2 / members.length
            return <line key={post.id} className="rt-line direct" x1={280 + Math.cos(a) * 195}
              y1={230 + Math.sin(a) * 175} x2={280 + Math.cos(b) * 195}
              y2={230 + Math.sin(b) * 175} />
          })}
          <circle cx={280} cy={230} r={72} className="rt-center" />
          <text x={280} y={193} textAnchor="middle" className="rt-center-text">Open Floor</text>
          <circle cx={280} cy={232} r={33} className={active === 'figurehead' ? 'rt-figurehead active' : 'rt-figurehead'} />
          <text x={280} y={236} textAnchor="middle" className="rt-figurehead-text">Figurehead</text>
          {members.map((p, i) => {
            const angle = -Math.PI / 2 + i * Math.PI * 2 / members.length
            const x = 280 + Math.cos(angle) * 195, y = 230 + Math.sin(angle) * 175
            return <g key={p.id} className={active === p.id ? 'rt-node active' : 'rt-node'}>
              <circle cx={x} cy={y} r={38} />
              <text textAnchor="middle" x={x} y={y + 4}>{p.name}</text>
            </g>
          })}
        </svg>
        <p className="muted small">The Figurehead sits in the inner circle. Spokes show Open Floor participation; cross-links show actual direct exchanges. The active speaker is highlighted.</p>
        <details className="rt-context"><summary>Figurehead context and source log</summary>
          {session.briefing ? <>
            <p className="rt-body">{session.briefing.text}</p>
            <strong>Sources consulted</strong>
            <ul>{session.briefing.sources.map((source, i) => <li key={i}>{source}</li>)}</ul>
          </> : <p className="muted">The Figurehead is preparing a briefing from this story's manuscript and worldbuilding.</p>}
          {(session.interventions?.length ?? 0) > 0 && <><strong>Context interventions</strong>
            {session.interventions?.map((note, i) => <p key={i}><strong>{PHASE_NAMES[note.phase]}:</strong> {note.text}</p>)}</>}
        </details>
      </div> : tab === 'results' ? <div className="rt-feed">
        <h3>Final proposals and peer rankings {session.phase === 'complete' ? '' : '(in progress)'}</h3>
        {!resultsReady && <p className="muted">Final proposals remain sealed until everyone has locked in their position.</p>}
        {resultsReady && roundtableResults(session).map((result, i) => {
          const proposal = sealed.find((p) => p.speakerId === result.id)
          return <article key={result.id} className="rt-result-proposal rt-post">
            <div className="rt-result-line"><strong>{i + 1}. {result.name}{i === 0 && session.phase === 'complete' ? ' · Winner' : ''}</strong>
              <span className="muted small">{result.score} points · {result.votes} ballots</span></div>
            <p className="rt-result-summary">{proposal?.summary || 'No final summary was recorded for this participant.'}</p>
            <details><summary>Read full final proposal</summary>
              <div className="rt-body"><Blocks blocks={parse(proposal?.text || 'No final proposal was recorded.')} /></div>
            </details>
          </article>
        })}
        <p className="muted small">Only locked final proposals are ranked. Participants cannot vote for themselves.</p>
        <h3>Individual ballots ({ballotCount}/{members.length})</h3>
        {session.phase !== 'complete' && <p className="muted">Ballots remain sealed until everyone has finished voting.</p>}
        {session.phase === 'complete' && visiblePosts.map((post) => <article className="rt-post" key={post.id}>
          <strong>{name(post.speakerId)}</strong>
          <ol>{post.ranking?.map((id) => <li key={id}>{name(id)}</li>)}</ol>
        </article>)}
      </div> : <div className="rt-feed">
        {tab === 'floor' && !!session.briefing && <details className="rt-figurehead-notice">
          <summary><strong>Figurehead</strong> · Shared manuscript briefing ({session.briefing.sources.length} sources)</summary>
          <p className="rt-body">{session.briefing.text}</p>
        </details>}
        {tab === 'floor' && session.interventions?.map((note, i) => <article key={i} className="rt-post rt-moderator-post">
          <div className="rt-post-head"><strong>Figurehead</strong><span className="muted small">{PHASE_NAMES[note.phase]} · Context check</span></div>
          <div className="rt-body">{note.text}</div>
        </article>)}
        {!visiblePosts.length && <p className="muted">No {tab === 'floor' ? 'open-floor posts' : currentPerson ? 'messages for this participant' : 'direct exchanges'} yet.</p>}
        {visiblePosts.map((post) => <article key={post.id} className="rt-post">
          <div className="rt-post-head"><strong>{name(post.speakerId)}</strong>
            {post.targetId && <span className="muted small">to {name(post.targetId)}</span>}
            <span className="muted small">{PHASE_NAMES[post.phase]}</span></div>
          <div className="rt-body"><Blocks blocks={parse(post.text)} /></div>
        </article>)}
        {currentPerson && <div className="rt-writer rt-private-chat">
          <textarea rows={3} value={privateText} onChange={(e) => setPrivateText(e.target.value)}
            placeholder={`Message ${name(currentPerson)} directly…`} maxLength={6000}
            disabled={!!busy || automatic} />
          <button disabled={!privateText.trim() || !!busy || automatic}
            onClick={() => void askParticipant()}>
            {busy === currentPerson ? 'Responding…' : `Send to ${name(currentPerson)}`}
          </button>
          {automatic && <p className="muted small">Pause the discussion to start a private exchange.</p>}
        </div>}
        {tab === 'floor' && session.phase !== 'complete' && <div className="rt-writer">
          <textarea rows={2} value={userText} onChange={(e) => setUserText(e.target.value)}
            placeholder="Add a note or question to the Open Floor…" maxLength={16000} disabled={!!busy || automatic} />
          <button disabled={!userText.trim() || !!busy || automatic} onClick={() => void addUserPost()}>Post as writer</button>
        </div>}
        {tab === 'board' && ['discussion1', 'discussion2'].includes(session.phase) && <div className="rt-direct">
          <select aria-label="Speaker" value={sender} onChange={(e) => setSender(e.target.value)}>
            <option value="">From participant…</option>
            {members.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select aria-label="Recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)}>
            <option value="">To participant…</option>
            {members.filter((p) => p.id !== sender).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button disabled={!sender || !recipient || sender === recipient || !!busy || automatic} onClick={() => void contribute(true)}>Request direct reply</button>
        </div>}
      </div>}
      <footer className="rt-footer">
        {busy && <div className="rt-running"><span className="muted small">{name(busy)} is responding</span>
          <button onClick={() => { if (activeRequest.current) void api.invoke('ai:cancel', { requestId: activeRequest.current }) }}>Stop response</button>
        </div>}
        {session.phase === 'revision' && <details className="rt-private">
          <summary>Private reconsiderations (visible to you only)</summary>
          {session.posts.filter((p) => p.channel === 'private').map((p) => <div key={p.id} className="rt-post"><strong>{name(p.speakerId)}</strong><p>{p.text}</p></div>)}
        </details>}
        <div className="rt-controls">
          {session.phase === 'complete' ? <strong>Roundtable finished. All peer ballots are available in Rankings.</strong> :
            automatic ? <>
              <span className="muted small">{runStatus?.speakerId ? `${name(runStatus.speakerId)} is contributing` : 'Advancing the discussion…'}</span>
              <button disabled={runStatus?.state === 'pausing'} onClick={() => void pause()}>{runStatus?.state === 'pausing' ? 'Pausing…' : 'Pause Roundtable'}</button>
            </> : <>
              <span className="muted small">{runStatus?.state === 'failed' ? `Stopped: ${runStatus.error ?? 'AI request failed'}` : 'Paused · progress saved'}</span>
              <button className="primary" onClick={() => void run(file!.id)}>Resume automatically</button>
            </>}

        </div>
      </footer>
    </div>}
  </div>
}
