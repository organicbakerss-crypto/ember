import { useEffect, useState } from 'react'
import type { ChapterSummaryInfo } from '@shared/ipc'
import { api } from '../api'
import { loadLocal, saveLocal } from '../storage'

/** Back after this long away from a story: a short recap is offered. */
const BREAK_MS = 8 * 60 * 60 * 1000
const SEEN_EVERY_MS = 5 * 60 * 1000
/** How many chapters the recap covers (the open one and those before it). */
const RECAP_CHAPTERS = 3

/**
 * "Where you left off": opening a story after a break shows the AI's
 * summaries of the last few chapters up to the open one. Made from the
 * summaries already kept (nothing is sent to the AI); shown only when there
 * are some, and once per return.
 */
export function Recap(props: { seriesId: string; chapterId: string | null }) {
  const { seriesId, chapterId } = props
  const key = `ai.lastSeen.${seriesId}`
  // Read once, before this visit counts as seen.
  const [away] = useState(() => {
    const last = Number(loadLocal(key)) || 0
    return last > 0 && Date.now() - last > BREAK_MS
  })
  const [items, setItems] = useState<ChapterSummaryInfo[] | null>(null)
  const [closed, setClosed] = useState(false)

  useEffect(() => {
    const seen = () => saveLocal(key, String(Date.now()))
    seen()
    const timer = setInterval(seen, SEEN_EVERY_MS)
    return () => clearInterval(timer)
  }, [key])

  useEffect(() => {
    if (!away) return
    api.invoke('ai:summaries', { seriesId }).then(setItems, () => {})
  }, [away, seriesId])

  if (!away || closed || !items || !chapterId) return null
  const at = items.findIndex((i) => i.chapter.id === chapterId)
  if (at < 0) return null
  const recent = items
    .slice(0, at + 1)
    .filter((i) => i.summary)
    .slice(-RECAP_CHAPTERS)
  if (!recent.length) return null
  return (
    <aside className="recap" aria-label="Where you left off">
      <header className="row">
        <strong>Where you left off</strong>
        <span className="status-spacer" />
        <button className="icon" aria-label="Close the recap" onClick={() => setClosed(true)}>
          ✕
        </button>
      </header>
      {recent.map((i) => (
        <p key={i.chapter.id} className="small">
          <span className="muted">
            {i.chapter.label} “{i.chapter.title || 'Untitled'}”{i.current ? '' : ' (changed since)'}
            :
          </span>{' '}
          {i.summary}
        </p>
      ))}
    </aside>
  )
}
