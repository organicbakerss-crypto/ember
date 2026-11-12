import { useEffect, useRef, useState } from 'react'
import type { SceneHit, SearchHit, SearchResult } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'
import { flushAll } from '../saving'
import { useOverlays } from './overlays'

interface SearchState {
  query: string
  replacement: string
  matchCase: boolean
  wholeWord: boolean
  story: boolean
  current: number
}
/** The last search per story: kept when a match in another volume opens that volume. */
const lastSearch = new Map<string, SearchState>()
/** Words or Describe it, per story. */
const lastMode = new Map<string, 'words' | 'describe'>()

/** Find (and replace) across every chapter of the volume, or of the whole story. */
export function SearchPanel(props: {
  seriesId: string
  volumeId: string
  /** The story has more than one volume (offer to search them all). */
  multiVolume: boolean
  /** Opens a match in another volume (that volume's writing view). */
  onOpenElsewhere?: (hit: SearchHit) => void
  /** Bumped to focus the find field again (Ctrl/Cmd+F while the panel is open). */
  focusToken: number
  onOpenHit: (hit: SearchHit) => void
  /** Replaces the current selection in the editor if it matches; returns whether it did. */
  onReplaceSelection: (replacement: string, query: string, matchCase: boolean) => boolean
  onReplacedAll: () => void
  /** The AI is on: offer "Describe it" (find a scene by describing it). */
  aiOn?: boolean
}) {
  const { seriesId, volumeId } = props
  const [initial] = useState(() => lastSearch.get(seriesId))
  const [query, setQuery] = useState(initial?.query ?? '')
  const [replacement, setReplacement] = useState(initial?.replacement ?? '')
  const [matchCase, setMatchCase] = useState(initial?.matchCase ?? false)
  const [wholeWord, setWholeWord] = useState(initial?.wholeWord ?? false)
  const [storyWide, setStory] = useState(initial?.story ?? false)
  const story = storyWide && props.multiVolume
  const [result, setResult] = useState<SearchResult | null>(null)
  const [current, setCurrent] = useState<number>(initial?.current ?? -1)
  useEffect(() => {
    lastSearch.set(seriesId, {
      query,
      replacement,
      matchCase,
      wholeWord,
      story: storyWide,
      current,
    })
  }, [seriesId, query, replacement, matchCase, wholeWord, storyWide, current])
  const [version, setVersion] = useState(0)
  const findField = useRef<HTMLInputElement>(null)
  const { toast, choose } = useOverlays()
  const [describing, setDescribing] = useState(() => lastMode.get(seriesId) === 'describe')
  const describe = describing && !!props.aiOn

  useEffect(() => {
    findField.current?.focus()
    findField.current?.select()
  }, [props.focusToken])

  // Search as you type (debounced), and again whenever a chapter here is saved.
  useEffect(() => {
    if (!query.trim()) return
    const timer = setTimeout(() => {
      api.invoke('search:volume', { seriesId, volumeId, query, matchCase, wholeWord, story }).then(
        (r) => setResult(r),
        (err) => toast(describeError(err).message),
      )
    }, 90)
    return () => clearTimeout(timer)
  }, [seriesId, volumeId, query, matchCase, wholeWord, story, version, toast])
  useIpcEvent('library:changed', (c) => {
    if (
      (c.kind === 'chapter' || c.kind === 'outline') &&
      (story ? c.seriesId === seriesId : c.volumeId === volumeId)
    )
      setVersion((v) => v + 1)
  })
  const shown = query.trim() ? result : null

  const go = (index: number) => {
    const hits = shown?.hits ?? []
    if (!hits.length) return
    const i = (index + hits.length) % hits.length
    setCurrent(i)
    open(hits[i]!)
  }
  const open = (hit: SearchHit) => {
    if (hit.volumeId === volumeId) props.onOpenHit(hit)
    else props.onOpenElsewhere?.(hit)
  }

  const replaceOne = () => {
    if (!props.onReplaceSelection(replacement, query, matchCase)) go(current < 0 ? 0 : current)
  }

  const replaceAll = async () => {
    if (!shown?.total) return
    const n = shown.total
    const answer = await choose(
      `Replace ${n} ${n === 1 ? 'match' : 'matches'} in ${shown.chapters.length} ${shown.chapters.length === 1 ? 'chapter' : 'chapters'}?`,
      [{ value: 'replace', label: 'Replace all', primary: true }],
      `“${query}” becomes “${replacement}”. Each chapter's current text is kept in its history first, so this can be undone.`,
    )
    if (!answer) return
    try {
      await flushAll()
      const done = await api.invoke('search:replaceAll', {
        seriesId,
        volumeId,
        query,
        replacement,
        matchCase,
        wholeWord,
        story,
      })
      props.onReplacedAll()
      toast(
        `Replaced ${done.replacements} in ${done.chapters} ${done.chapters === 1 ? 'chapter' : 'chapters'}.`,
      )
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const titles = new Map(
    shown?.chapters.map((c) => [
      c.id,
      `${story ? `${c.volumeName} › ` : ''}${c.title || 'Untitled chapter'}`,
    ]),
  )
  let lastChapter: string | null = null

  const modes = props.aiOn && (
    <div className="segmented small" role="radiogroup" aria-label="How to find">
      {(['words', 'describe'] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={(m === 'describe') === describe}
          className={(m === 'describe') === describe ? 'active' : ''}
          onClick={() => {
            setDescribing(m === 'describe')
            lastMode.set(seriesId, m)
          }}
        >
          {m === 'words' ? 'Words' : 'Describe it'}
        </button>
      ))}
    </div>
  )

  if (describe) {
    return (
      <div className="search-panel">
        <h2>Find</h2>
        {modes}
        <SceneSearch seriesId={seriesId} focusToken={props.focusToken} onOpen={open} />
      </div>
    )
  }

  return (
    <div className="search-panel">
      <h2>Find</h2>
      {modes}
      {props.multiVolume && (
        <div className="segmented small" role="radiogroup" aria-label="Where to search">
          <button
            role="radio"
            aria-checked={!story}
            className={story ? '' : 'active'}
            onClick={() => {
              setStory(false)
              setCurrent(-1)
            }}
          >
            This book
          </button>
          <button
            role="radio"
            aria-checked={story}
            className={story ? 'active' : ''}
            onClick={() => {
              setStory(true)
              setCurrent(-1)
            }}
          >
            Whole story
          </button>
        </div>
      )}
      <input
        ref={findField}
        type="search"
        aria-label="Find"
        placeholder="Find"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setCurrent(-1)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            go(current + (e.shiftKey ? -1 : 1))
          }
        }}
      />
      <input
        aria-label="Replace with"
        placeholder="Replace with"
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
      />
      <div className="search-options small">
        <label className="radio">
          <input
            type="checkbox"
            checked={matchCase}
            onChange={(e) => setMatchCase(e.target.checked)}
          />
          Match case
        </label>
        <label className="radio">
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
          />
          Whole words
        </label>
      </div>
      <div className="row small">
        <button
          disabled={!shown?.hits.length}
          onClick={() => go(current - 1)}
          title="Previous (Shift+Enter)"
        >
          ↑
        </button>
        <button disabled={!shown?.hits.length} onClick={() => go(current + 1)} title="Next (Enter)">
          ↓
        </button>
        <button disabled={!shown?.hits.length} onClick={replaceOne}>
          Replace
        </button>
        <button disabled={!shown?.total} onClick={() => void replaceAll()}>
          Replace all
        </button>
      </div>
      {shown && (
        <p className="muted small" role="status">
          {shown.total === 0
            ? 'No matches.'
            : `${current >= 0 ? `${current + 1} of ` : ''}${shown.total} ${shown.total === 1 ? 'match' : 'matches'} in ${shown.chapters.length} ${shown.chapters.length === 1 ? 'chapter' : 'chapters'}${shown.truncated ? ' (first 500 listed)' : ''}`}
        </p>
      )}
      <ol className="search-results">
        {shown?.hits.map((hit, i) => {
          const heading = hit.chapterId !== lastChapter ? titles.get(hit.chapterId) : null
          lastChapter = hit.chapterId
          return (
            <li key={`${hit.volumeId}-${hit.chapterId}-${hit.node}-${hit.start}`}>
              {heading && <div className="search-chapter small">{heading}</div>}
              <button
                className={`search-hit small ${i === current ? 'current' : ''}`}
                onClick={() => {
                  setCurrent(i)
                  open(hit)
                }}
              >
                …{hit.before}
                <mark>{hit.match}</mark>
                {hit.after}…
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const newRequestId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`
/** The last description and what it found, per story (kept while switching chapters). */
const lastScene = new Map<string, { text: string; hits: SceneHit[] | null; unread: number }>()

/** Find a scene by describing it: the AI picks the chapters, then the paragraph. */
function SceneSearch(props: {
  seriesId: string
  focusToken: number
  onOpen: (hit: SearchHit) => void
}) {
  const { seriesId } = props
  const [initial] = useState(() => lastScene.get(seriesId))
  const [text, setText] = useState(initial?.text ?? '')
  const [hits, setHits] = useState<SceneHit[] | null>(initial?.hits ?? null)
  const [unread, setUnread] = useState(initial?.unread ?? 0)
  const [busy, setBusy] = useState<{ id: string; progress: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    field.current?.focus()
  }, [props.focusToken])
  useEffect(() => {
    lastScene.set(seriesId, { text, hits, unread })
  }, [seriesId, text, hits, unread])
  useIpcEvent('ai:progress', ({ requestId, text: progress }) => {
    if (requestId === busy?.id) setBusy({ id: requestId, progress })
  })

  const find = async () => {
    const description = text.trim()
    if (description.length < 3 || busy) return
    const id = newRequestId()
    setBusy({ id, progress: 'Looking…' })
    setError(null)
    try {
      const found = await api.invoke('ai:findScene', { requestId: id, seriesId, description })
      setHits(found.hits)
      setUnread(found.unread)
    } catch (err) {
      const e = describeError(err)
      if (e.code !== 'cancelled') setError(e.message)
    } finally {
      setBusy(null)
    }
  }
  const open = (h: SceneHit) =>
    props.onOpen(
      h.hit ?? {
        volumeId: h.volumeId,
        chapterId: h.chapterId,
        node: 0,
        start: 0,
        end: 0,
        before: '',
        match: '',
        after: '',
      },
    )

  return (
    <>
      <textarea
        ref={field}
        aria-label="Describe the scene"
        rows={3}
        placeholder="Describe the scene, e.g. “where Josh lies to Sara about the van”"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void find()
          }
        }}
      />
      {busy ? (
        <div className="row small">
          <span className="muted">{busy.progress}</span>
          <span className="status-spacer" />
          <button
            className="link"
            onClick={() => void api.invoke('ai:cancel', { requestId: busy.id })}
          >
            Stop
          </button>
        </div>
      ) : (
        <div className="row small">
          <button disabled={text.trim().length < 3} onClick={() => void find()}>
            Find it
          </button>
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {hits && !busy && (
        <p className="muted small" role="status">
          {hits.length ? 'Most likely first.' : 'Nothing found that fits.'}
          {unread > 0 &&
            ` ${unread} ${unread === 1 ? 'chapter hasn’t' : 'chapters haven’t'} been read for the world yet, so ${unread === 1 ? 'it’s' : 'they’re'} only found by their words.`}
        </p>
      )}
      <ol className="search-results">
        {!busy &&
          hits?.map((h) => (
            <li key={`${h.chapterId}-${h.hit?.node ?? 0}`}>
              <div className="search-chapter small">{h.chapterName}</div>
              <button className="search-hit small scene-hit" onClick={() => open(h)}>
                {h.excerpt && <span className="scene-excerpt">“{h.excerpt}”</span>}
                {h.why && <span className="muted">{h.why}</span>}
              </button>
            </li>
          ))}
      </ol>
    </>
  )
}
