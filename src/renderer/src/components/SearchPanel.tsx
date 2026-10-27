import { useEffect, useRef, useState } from 'react'
import type { SearchHit, SearchResult } from '@shared/ipc'
import { api, describeError, useIpcEvent } from '../api'
import { flushAll } from '../saving'
import { useOverlays } from './overlays'

/** Find (and replace) across every chapter of the volume. */
export function SearchPanel(props: {
  seriesId: string
  volumeId: string
  /** Bumped to focus the find field again (Ctrl/Cmd+F while the panel is open). */
  focusToken: number
  onOpenHit: (hit: SearchHit) => void
  /** Replaces the current selection in the editor if it matches; returns whether it did. */
  onReplaceSelection: (replacement: string, query: string, matchCase: boolean) => boolean
  onReplacedAll: () => void
}) {
  const { seriesId, volumeId } = props
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [current, setCurrent] = useState<number>(-1)
  const [version, setVersion] = useState(0)
  const findField = useRef<HTMLInputElement>(null)
  const { toast, choose } = useOverlays()

  useEffect(() => {
    findField.current?.focus()
    findField.current?.select()
  }, [props.focusToken])

  // Search as you type (debounced), and again whenever a chapter here is saved.
  useEffect(() => {
    if (!query.trim()) return
    const timer = setTimeout(() => {
      api.invoke('search:volume', { seriesId, volumeId, query, matchCase, wholeWord }).then(
        (r) => setResult(r),
        (err) => toast(describeError(err).message),
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [seriesId, volumeId, query, matchCase, wholeWord, version, toast])
  useIpcEvent('library:changed', (c) => {
    if ((c.kind === 'chapter' || c.kind === 'outline') && c.volumeId === volumeId)
      setVersion((v) => v + 1)
  })
  const shown = query.trim() ? result : null

  const go = (index: number) => {
    const hits = shown?.hits ?? []
    if (!hits.length) return
    const i = (index + hits.length) % hits.length
    setCurrent(i)
    props.onOpenHit(hits[i]!)
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
      })
      props.onReplacedAll()
      toast(
        `Replaced ${done.replacements} in ${done.chapters} ${done.chapters === 1 ? 'chapter' : 'chapters'}.`,
      )
    } catch (err) {
      toast(describeError(err).message)
    }
  }

  const titles = new Map(shown?.chapters.map((c) => [c.id, c.title || 'Untitled chapter']))
  let lastChapter: string | null = null

  return (
    <div className="search-panel">
      <h2>Find in volume</h2>
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
            <li key={`${hit.chapterId}-${hit.node}-${hit.start}`}>
              {heading && <div className="search-chapter small">{heading}</div>}
              <button
                className={`search-hit small ${i === current ? 'current' : ''}`}
                onClick={() => {
                  setCurrent(i)
                  props.onOpenHit(hit)
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
