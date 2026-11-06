import { useEffect, useState } from 'react'
import { EMBER_CHARACTERS } from '@shared/ai/characters'
import { newId } from '@shared/ids'
import type { ConversationFile } from '@shared/schema'
import type { ConversationSummary } from '@shared/ipc'
import {
  advancePhase, nextParticipant, phaseIsReady, PHASE_NAMES, roundtableResults,
  type RoundtableSession, type RoundtableParticipant, type RoundtablePost,
} from '@shared/ai/roundtable'
import { api, describeError } from '../api'
import { parse } from './markdown'
import './roundtable.css'

type Tab = 'floor' | 'board' | 'network' | 'results'
const TABS: { id: Tab; title: string }[] = [
  { id: 'floor', title: 'Open Floor' },
  { id: 'board', title: 'Message Board' },
  { id: 'network', title: 'Network' },
  { id: 'results', title: 'Rankings' },
]
const available = EMBER_CHARACTERS.map((p) => ({
  id: p.id, name: p.name, kind: 'regular' as const,
}))
const id = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

export function RoundtableView({ seriesId, onBack }: { seriesId: string; onBack: () => void }) {
  const [topic, setTopic] = useState('')
  const [selected, setSelected] = useState<string[]>(['john-ai', 'roman', 'bo'])
  const [file, setFile] = useState<ConversationFile | null>(null)
  const [saved, setSaved] = useState<ConversationSummary[]>([])
  const [tab, setTab] = useState<Tab>('floor')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [userText, setUserText] = useState('')
  const [sender, setSender] = useState('')
  const [recipient, setRecipient] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const session = file?.roundtable
  const members = session?.participants ?? []
  const name = (speakerId: string) => members.find((p) => p.id === speakerId)?.name ?? 'You'

  const refresh = () => void api.invoke('ai:conversations', { seriesId })
    .then((all) => setSaved(all.filter((c) => c.roundtable)))
    .catch((err) => setError(describeError(err).message))

  useEffect(() => { refresh() }, [seriesId])

  const persist = async (base: ConversationFile, state: RoundtableSession) => {
    const next: ConversationFile = { ...base, updatedAt: new Date().toISOString(), roundtable: state }
    await api.invoke('ai:saveConversation', { seriesId, conversation: next })
    setFile(next)
    refresh()
  }

  const start = async () => {
    if (!topic.trim() || selected.length < 2) return
    const now = new Date().toISOString()
    const participants = selected.map((key) => available.find((p) => p.id === key)!).filter(Boolean)
    const state: RoundtableSession = { topic: topic.trim(), participants, phase: 'proposals', posts: [] }
    const base: ConversationFile = {
      formatVersion: 1, id: newId('conversation'), mode: 'chat',
      characterId: 'john-ai', title: `Roundtable: ${topic.trim().slice(0, 110)}`,
      createdAt: now, updatedAt: now, messages: [], roundtable: state,
    }
    setError('')
    try { await persist(base, state); setTab('floor') }
    catch (err) { setError(describeError(err).message) }
  }

  const load = async (conversationId: string) => {
    setError('')
    try {
      const conversation = await api.invoke('ai:conversation', { seriesId, conversationId })
      if (!conversation.roundtable) throw new Error('Not a Roundtable session.')
      setFile(conversation)
      setTab('floor')
    } catch (err) { setError(describeError(err).message) }
  }

  const makePost = (state: RoundtableSession, speakerId: string, text: string,
    channel: RoundtablePost['channel'], targetId: string | null, ranking?: string[]): RoundtablePost => ({
    id: id(), at: new Date().toISOString(), phase: state.phase,
    speakerId, targetId, channel, text, ...(ranking ? { ranking } : {}),
  })

  const contribute = async (direct = false) => {
    if (!file || !session || busy) return
    const person = direct ? members.find((p) => p.id === sender) : nextParticipant(session)
    const target = direct ? recipient : null
    if (!person || (direct && (!target || target === person.id))) return
    setBusy(person.id)
    setActive(person.id)
    setError('')
    try {
      const output = await api.invoke('ai:roundtableTurn', {
        requestId: id(), session, speakerId: person.id, targetId: target, direct,
      })
      const channel = direct ? 'direct' : session.phase === 'revision' ? 'private'
        : session.phase === 'vote' ? 'ballot' : 'open'
      await persist(file, {
        ...session, posts: [...session.posts,
          makePost(session, person.id, output.text, channel, target, output.ranking ?? undefined)],
      })
      setActive(direct ? target : person.id)
    } catch (err) { setError(describeError(err).message) }
    finally { setBusy(null) }
  }

  const advance = async () => {
    if (!file || !session || !phaseIsReady(session) || busy) return
    setError('')
    try {
      const next = advancePhase(session)
      await persist(file, next)
      setTab(next.phase === 'complete' ? 'results' : 'floor')
    } catch (err) { setError(describeError(err).message) }
  }

  const addUserPost = async () => {
    if (!file || !session || !userText.trim() || busy || session.phase === 'complete') return
    try {
      await persist(file, { ...session, posts: [...session.posts,
        makePost(session, 'writer', userText.trim(), 'user', null)] })
      setUserText('')
    } catch (err) { setError(describeError(err).message) }
  }

  const remove = async (conversationId: string) => {
    if (busy || !window.confirm('Delete this Roundtable session?')) return
    try {
      await api.invoke('ai:deleteConversation', { seriesId, conversationId })
      if (file?.id === conversationId) setFile(null)
      refresh()
    } catch (err) { setError(describeError(err).message) }
  }

  const visiblePosts = (session?.posts ?? []).filter((post) =>
    tab === 'board' ? post.channel === 'direct' :
      tab === 'floor' ? post.channel === 'open' || post.channel === 'user' :
        tab === 'results' ? post.channel === 'ballot' : post.channel !== 'private')
  const ballotCount = session?.posts.filter((p) => p.phase === 'vote' && p.channel === 'ballot').length ?? 0

  return <div className="rt-root">
    <header className="rt-header">
      <button className="link" onClick={onBack}>← AI chat</button>
      <strong>Roundtable</strong>
      <span className="status-spacer" />
      {session && <button className="link" disabled={!!busy} onClick={() => setFile(null)}>New Roundtable</button>}
    </header>
    {error && <div className="error rt-error" role="alert">{error}</div>}
    {!session ? <div className="rt-setup">
      <h3>Start a Roundtable</h3>
      <p className="muted">Each participant proposes an approach, discusses it twice, privately revises their view, and ranks the other proposals. You control each model call.</p>
      <label>Question or problem<textarea rows={4} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What should this group discuss?" maxLength={4000} /></label>
      <div className="rt-picker"><strong>Participants ({selected.length}/8)</strong>
        <div className="rt-choice-grid">
          {available.map((p) => <label key={p.id} className="rt-choice">
            <input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected((list) =>
              e.target.checked ? list.length < 8 ? [...list, p.id] : list : list.filter((id) => id !== p.id))} />
            {p.name}
          </label>)}
        </div>
        <p className="muted small">Specialists and guest stars will appear after their profiles are approved. Current characters are available for infrastructure testing.</p>
      </div>
      <button className="primary" disabled={!topic.trim() || selected.length < 2} onClick={() => void start()}>Create Roundtable</button>
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
      </nav>
      {tab === 'network' ? <div className="rt-network">
        <svg viewBox="0 0 560 460" role="img" aria-label="Open Floor in the center, all participants linked around it">
          {members.map((p, i) => {
            const angle = -Math.PI / 2 + i * Math.PI * 2 / members.length
            const x = 280 + Math.cos(angle) * 195
            const y = 230 + Math.sin(angle) * 175
            return <g key={p.id}>
              <line x1={280} y1={230} x2={x} y2={y} className={active === p.id ? 'rt-line active' : 'rt-line'} />
              {members.map((other, j) => {
                if (j <= i) return null
                const a = -Math.PI / 2 + j * Math.PI * 2 / members.length
                return <line key={other.id} className="rt-line between" x1={x} y1={y}
                  x2={280 + Math.cos(a) * 195} y2={230 + Math.sin(a) * 175} />
              })}
            </g>
          })}
          <circle cx={280} cy={230} r={72} className="rt-center" />
          <text x={280} y={225} textAnchor="middle" className="rt-center-text">Open</text>
          <text x={280} y={244} textAnchor="middle" className="rt-center-text">Floor</text>
          {members.map((p, i) => {
            const angle = -Math.PI / 2 + i * Math.PI * 2 / members.length
            const x = 280 + Math.cos(angle) * 195, y = 230 + Math.sin(angle) * 175
            return <g key={p.id} className={active === p.id ? 'rt-node active' : 'rt-node'}>
              <circle cx={x} cy={y} r={38} />
              <text textAnchor="middle" x={x} y={y + 4}>{p.name}</text>
            </g>
          })}
        </svg>
        <p className="muted small">Connections highlight the latest speaker. The discussion is in Open Floor and Message Board.</p>
      </div> : tab === 'results' ? <div className="rt-feed">
        <h3>Peer rankings {session.phase === 'complete' ? '' : '(in progress)'}</h3>
        {roundtableResults(session).map((result, i) =>
          <div key={result.id} className="rt-result"><strong>{i + 1}. {result.name}</strong><span>{result.score} points · {result.votes} votes</span></div>)}
        <p className="muted small">Points are weighted by ballot position. Self-votes are rejected; tied scores remain tied.</p>
        <h3>Individual ballots ({ballotCount}/{members.length})</h3>
        {visiblePosts.map((post) => <article className="rt-post" key={post.id}>
          <strong>{name(post.speakerId)}</strong>
          <ol>{post.ranking?.map((id) => <li key={id}>{name(id)}</li>)}</ol>
        </article>)}
      </div> : <div className="rt-feed">
        {!visiblePosts.length && <p className="muted">No {tab === 'floor' ? 'open-floor posts' : 'direct exchanges'} yet.</p>}
        {visiblePosts.map((post) => <article key={post.id} className="rt-post">
          <div className="rt-post-head"><strong>{name(post.speakerId)}</strong>
            {post.targetId && <span className="muted small">to {name(post.targetId)}</span>}
            <span className="muted small">{PHASE_NAMES[post.phase]}</span></div>
          <div className="rt-body">{post.text}</div>
        </article>)}
        {tab === 'floor' && session.phase !== 'complete' && <div className="rt-writer">
          <textarea rows={2} value={userText} onChange={(e) => setUserText(e.target.value)}
            placeholder="Add a note or question to the Open Floor…" maxLength={16000} disabled={!!busy} />
          <button disabled={!userText.trim() || !!busy} onClick={() => void addUserPost()}>Post as writer</button>
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
          <button disabled={!sender || !recipient || sender === recipient || !!busy} onClick={() => void contribute(true)}>Request direct reply</button>
        </div>}
      </div>}
      <footer className="rt-footer">
        {session.phase === 'revision' && <details className="rt-private">
          <summary>Private reconsiderations (visible to you only)</summary>
          {session.posts.filter((p) => p.channel === 'private').map((p) => <div key={p.id} className="rt-post"><strong>{name(p.speakerId)}</strong><p>{p.text}</p></div>)}
        </details>}
        <div className="rt-controls">
          {session.phase === 'complete' ? <strong>Roundtable finished. All peer ballots are available in Rankings.</strong> :
            nextParticipant(session) ? <>
              <span className="muted small">Next: {nextParticipant(session)!.name}</span>
              <button className="primary" disabled={!!busy} onClick={() => void contribute()}>
                {busy ? `${name(busy)} responding…` : `Get ${nextParticipant(session)!.name}'s contribution`}
              </button>
            </> : <button className="primary" disabled={!!busy} onClick={() => void advance()}>
              {session.phase === 'vote' ? 'Finish and show results' : 'Continue to next phase'}
            </button>}
        </div>
      </footer>
    </div>}
  </div>
}
