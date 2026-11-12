import { useEffect, useState, type RefObject } from 'react'
import type { CommentInfo } from '../editor/comments'

/** A steady colour for a name (POVs on the strip, people in the cast). */
const COLORS = [
  '#e2733f',
  '#d9b26a',
  '#8fb0c9',
  '#9fbf7f',
  '#c98fb5',
  '#7fc4b8',
  '#d98a7a',
  '#a99be0',
]
export function colorOf(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]!
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')

/**
 * Margins: the book along the bottom. One bar per chapter, as tall as its
 * words, coloured by its POV; chapters with nothing written yet are hatched.
 */
export function ChapterStrip(props: {
  chapters: { id: string; title: string; words: number; pov: string | null }[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** "Book One · 41,280 words · today 340 / 550" */
  summary: string
  /** A chapter's menu (right-click a bar). */
  onMenu: (e: React.MouseEvent, id: string) => void
  /** Adds a chapter at the end. */
  onNew: () => void
}) {
  const max = Math.max(1, ...props.chapters.map((c) => c.words))
  const povs = [...new Set(props.chapters.map((c) => c.pov).filter((p): p is string => !!p))]
  return (
    <nav className="chapter-strip" aria-label="Chapters">
      <div className="strip-legend small">
        {povs.slice(0, 8).map((p) => (
          <span key={p}>
            <i style={{ background: colorOf(p) }} />
            {p}
          </span>
        ))}
        <span className="status-spacer" />
        {(() => {
          const i = props.chapters.findIndex((c) => c.id === props.selectedId)
          const c = props.chapters[i]
          return c ? (
            <span className="strip-current">
              {i + 1} · {c.title || 'Untitled chapter'} · {c.words.toLocaleString()} words
            </span>
          ) : null
        })()}
        <span>{props.summary}</span>
      </div>
      <div className="strip-bars">
        {props.chapters.map((c, i) => {
          const on = c.id === props.selectedId
          return (
            <button
              key={c.id}
              className={`strip-bar ${on ? 'on' : ''} ${c.words ? '' : 'empty'}`}
              title={`${i + 1}. ${c.title || 'Untitled chapter'}${c.pov ? ` · ${c.pov}` : ''} · ${c.words.toLocaleString()} words`}
              aria-label={`Chapter ${i + 1}: ${c.title || 'Untitled'}`}
              aria-current={on}
              onClick={() => props.onSelect(c.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                props.onMenu(e, c.id)
              }}
            >
              <span
                className="strip-fill"
                style={{
                  height: c.words ? `${Math.max(14, (c.words / max) * 100)}%` : undefined,
                  background: c.words ? (c.pov ? colorOf(c.pov) : 'var(--muted)') : undefined,
                }}
              />
              <span className="strip-num">{i + 1}</span>
            </button>
          )
        })}
        <button
          className="strip-new"
          title="New chapter"
          aria-label="New chapter"
          onClick={props.onNew}
        >
          +
        </button>
      </div>
    </nav>
  )
}

/**
 * Margins: comments and AI notes beside the lines they're on (in the space
 * left of the page). Hidden when there isn't room; they're always in the
 * Details → Comments tab too.
 */
export function MarginNotes(props: {
  comments: CommentInfo[]
  /** Where a document position is on screen (null: not laid out). */
  locate: (pos: number) => { top: number } | null
  /** The page area (notes are placed in its left gutter). */
  area: RefObject<HTMLElement | null>
  onOpen: (id: string) => void
}) {
  const { comments, locate, area } = props
  const [placed, setPlaced] = useState<{ c: CommentInfo; top: number }[]>([])
  const [width, setWidth] = useState(0)
  // Measured after drawing, and again on scrolling and resizing.
  useEffect(() => {
    let frame = 0
    const measure = () => {
      const box = area.current
      const page = box?.querySelector('.page-content, .page-sheet')
      if (!box || !page) {
        setPlaced([])
        return
      }
      const a = box.getBoundingClientRect()
      const w = Math.min(260, page.getBoundingClientRect().left - a.left - 48)
      setWidth(w)
      if (w < 150) {
        setPlaced([])
        return
      }
      // In reading order, each below the one before.
      let floor = -Infinity
      const out: { c: CommentInfo; top: number }[] = []
      for (const c of comments) {
        const at = locate(c.from)
        if (!at) continue
        const top = Math.max(at.top - a.top - 4, floor)
        if (top > a.height || top < -200) continue
        out.push({ c, top })
        const lines = Math.ceil((c.note || 'Comment').length / Math.max(18, w / 7.2))
        floor = top + 40 + lines * 18
      }
      setPlaced(out)
    }
    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    schedule()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [comments, locate, area])
  if (!placed.length) return null
  return (
    <div className="margin-notes" aria-label="Notes in the margin" style={{ width }}>
      {placed.map(({ c, top }) => (
        <button
          key={c.id}
          className={`margin-note ${c.by === 'ai' ? 'ai' : ''}`}
          style={{ top }}
          title="Open in Comments"
          onClick={() => props.onOpen(c.id)}
        >
          <small>{c.by === 'ai' ? 'AI note' : 'Your note'}</small>
          {c.note || <span className="muted">(no note yet)</span>}
        </button>
      ))}
    </div>
  )
}

/** Margins: who's in this scene, beside the page (the POV first). */
export function SceneCast(props: {
  people: { id: string; name: string; detail: string; pov: boolean }[]
  onOpen: (entryId: string) => void
}) {
  if (!props.people.length) return null
  return (
    <aside className="scene-cast" aria-label="In this scene">
      <div className="scene-cast-head">In this scene</div>
      {props.people.map((p) => (
        <button key={p.id} className="scene-who" onClick={() => props.onOpen(p.id)}>
          <span className="scene-avatar" style={{ background: colorOf(p.name) }}>
            {initials(p.name)}
          </span>
          <span>
            <b>{p.name}</b>
            <small>{p.pov ? `POV${p.detail ? ` · ${p.detail}` : ''}` : p.detail}</small>
          </span>
        </button>
      ))}
    </aside>
  )
}
