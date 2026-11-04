import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SeriesSummary, VolumeSummary } from '@shared/ipc'
import { docToBlocks, numberChapters, type ExportStyle } from '@shared/manuscript/blocks'
import { chapterBodyHtml } from '@shared/manuscript/html'
import { api, describeError } from '../api'
import { Cover } from '../components/Cover'
import { volumeCover } from '../covers'
import { useSettings } from '../useTheme'
import { lastSpread, leftOf, rightOf, turn, type Face } from './spreads'

const TURN_MS = 450

interface Flip {
  dir: 1 | -1
  /** 0 (flat where it started) to 1 (turned over). */
  progress: number
  /** Animating to the end ('go') or back to the start ('back'); null while dragged. */
  settle: 'go' | 'back' | null
}

/**
 * Book mode: the book (or volume) read as a printed book, two pages side by
 * side. It opens closed, on the cover; a click opens it to the title page and
 * Chapter 1. Pages turn with a click on a bottom corner, a drag, or the arrow
 * keys. Read-only. Each chapter is laid out in book-sized columns (one column
 * is one page), starting on a new page.
 */
export function BookView(props: {
  series: SeriesSummary
  volume: VolumeSummary
  chapterIds: string[]
  style: ExportStyle
  author: string
  onClose: () => void
}) {
  const { series, volume, chapterIds, style } = props
  const { settings } = useSettings()
  const still =
    settings.world.lighter || window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const [chapters, setChapters] = useState<{ title: string; html: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState(() => pageSize())
  const [counts, setCounts] = useState<number[] | null>(null)
  const [spread, setSpread] = useState(-1)
  const [flip, setFlip] = useState<Flip | null>(null)
  const measurer = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    void Promise.all(
      chapterIds.map((chapterId) =>
        api.invoke('chapter:read', { seriesId: series.id, volumeId: volume.id, chapterId }),
      ),
    ).then(
      (files) => {
        if (!live) return
        const numbered = numberChapters(files.map((f) => ({ type: f.type })))
        setChapters(
          files.map((f, i) => ({
            title: f.title,
            html: chapterBodyHtml(
              {
                title: f.title,
                type: f.type,
                number: numbered[i]!.number,
                blocks: docToBlocks(f.content),
              },
              style,
            ),
          })),
        )
      },
      (err: unknown) => live && setError(describeError(err).message),
    )
    return () => {
      live = false
    }
  }, [chapterIds, series.id, volume.id, style])

  useEffect(() => {
    const onResize = () => setSize(pageSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // How many pages each chapter takes at this size (and again once fonts are in).
  const measure = useCallback(() => {
    const box = measurer.current
    if (!box) return
    const next = [...box.querySelectorAll<HTMLElement>('.book-columns')].map((el) =>
      Math.max(1, Math.round((el.scrollWidth + size.gap) / size.width)),
    )
    setCounts((old) => (old && old.join() === next.join() ? old : next))
  }, [size])
  useLayoutEffect(() => {
    if (chapters) measure()
  }, [chapters, measure])
  useEffect(() => {
    void document.fonts?.ready.then(measure)
  }, [measure])

  // Page 0 is the title page; then each chapter's pages.
  const pages: { chapter: number; column: number }[] = []
  counts?.forEach((n, chapter) => {
    for (let column = 0; column < n; column++) pages.push({ chapter, column })
  })
  const total = 1 + pages.length
  const last = lastSpread(total)

  const canTurn = (dir: 1 | -1) => (dir === 1 ? spread < last : spread > -1)
  const go = (dir: 1 | -1) => {
    if (flip || !canTurn(dir)) return
    if (still) {
      setSpread((s) => s + dir)
      return
    }
    setFlip({ dir, progress: 0, settle: null })
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setFlip({ dir, progress: 1, settle: 'go' })),
    )
  }
  const finish = () => {
    if (!flip?.settle) return
    if (flip.settle === 'go') setSpread((s) => s + flip.dir)
    setFlip(null)
  }

  const { onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (['ArrowRight', 'PageDown', ' '].includes(e.key)) go(1)
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) go(-1)
      else if (e.key === 'Home' && !flip) setSpread(-1)
      else if (e.key === 'End' && !flip) setSpread(last)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // Dragging a page across turns it; letting go past a quarter finishes the turn.
  const drag = useRef<{ dir: 1 | -1; x: number; moved: boolean } | null>(null)
  const onDown = (e: React.PointerEvent<HTMLElement>) => {
    const dir = e.currentTarget.dataset['side'] === 'left' ? -1 : 1
    if (flip || !canTurn(dir) || e.button !== 0) return
    drag.current = { dir, x: e.clientX, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const delta = (d.x - e.clientX) * d.dir
    if (!d.moved && delta < 8) return
    d.moved = true
    if (still) return
    const progress = Math.min(1, Math.max(0, delta / (2 * size.width)))
    setFlip({ dir: d.dir, progress, settle: null })
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) {
      // A click: the cover opens; a bottom corner turns the page.
      const box = e.currentTarget.getBoundingClientRect()
      const corner = Math.min(90, size.width * 0.22)
      const inCorner =
        e.clientY > box.bottom - corner &&
        (d.dir === 1 ? e.clientX > box.right - corner : e.clientX < box.left + corner)
      if (spread === -1 || inCorner) go(d.dir)
      return
    }
    if (still) {
      setSpread((s) => s + d.dir)
      return
    }
    const done = (flip?.progress ?? 0) > 0.25
    setFlip({ dir: d.dir, progress: done ? 1 : 0, settle: done ? 'go' : 'back' })
  }

  const face = (f: Face) => {
    if (f === null) return null
    if (f === 'cover') {
      return (
        <div className="book-page book-cover-page">
          <Cover source={volumeCover(series, volume)} />
        </div>
      )
    }
    if (f === 0) {
      return (
        <div className="book-page book-title-page">
          <h1>{volume.name}</h1>
          {series.kind !== 'book' && <p className="book-series">{series.name}</p>}
          {props.author && <p className="book-author">{props.author}</p>}
        </div>
      )
    }
    const page = pages[f - 1]
    if (!page || !chapters) return <div className="book-page" />
    return (
      <div className="book-page">
        <div className="book-viewport">
          <div
            className="book-columns"
            style={{ transform: `translateX(${-page.column * size.width}px)` }}
            // Built from the chapter by our own HTML builder (text escaped).
            dangerouslySetInnerHTML={{ __html: chapters[page.chapter]!.html }}
          />
        </div>
        <span className="book-number">{f}</span>
      </div>
    )
  }

  const shown = flip ? turn(spread, flip.dir) : { left: leftOf(spread), right: rightOf(spread) }
  const closed = spread === -1 && !flip
  const chapterStart = (i: number) => 1 + pages.findIndex((p) => p.chapter === i)
  const where =
    spread < 0
      ? 'Cover'
      : `${spread === 0 ? 'Title page' : `Page ${2 * spread}`} – ${2 * spread + 1 <= total - 1 ? `${2 * spread + 1}` : 'end'} of ${total - 1}`

  return (
    <div
      className="book-mode"
      role="dialog"
      aria-label="Book mode"
      style={
        {
          '--book-w': `${size.width}px`,
          '--book-h': `${size.height}px`,
          '--book-pad': `${size.pad}px`,
          '--book-font': `${size.font}px`,
        } as React.CSSProperties
      }
    >
      <div className="book-bar small">
        <strong>{volume.name}</strong>
        <span className="muted">{where}</span>
        <span className="status-spacer" />
        {chapters && counts && (
          <select
            aria-label="Go to chapter"
            value=""
            onChange={(e) => {
              const i = Number(e.target.value)
              setFlip(null)
              setSpread(Math.floor(chapterStart(i) / 2))
            }}
          >
            <option value="">Go to chapter…</option>
            {chapters.map((c, i) => (
              <option key={i} value={i}>
                {c.title || `Chapter ${i + 1}`}
              </option>
            ))}
          </select>
        )}
        <button className="small" onClick={props.onClose}>
          Close (Esc)
        </button>
      </div>
      {error && <p className="error page-message">{error}</p>}
      {!counts && !error && <p className="muted page-message">Binding the book…</p>}
      {counts && (
        <div className="book-stage">
          <div className={`book ${closed ? 'closed' : ''}`}>
            <div
              className="book-side left"
              data-side="left"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
            >
              {face(shown.left)}
            </div>
            <div
              className="book-side right"
              data-side="right"
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              title={closed ? 'Open the book' : undefined}
            >
              {face(shown.right)}
            </div>
            {flip && 'front' in shown && (
              <div
                className={`book-leaf ${flip.dir === 1 ? 'forward' : 'backward'}`}
                style={{
                  transform: `rotateY(${flip.dir === 1 ? -180 * flip.progress : 180 * flip.progress}deg)`,
                  transition: flip.settle ? `transform ${TURN_MS}ms ease-in-out` : 'none',
                }}
                onTransitionEnd={finish}
              >
                <div className="leaf-face front">{face(shown.front)}</div>
                <div className="leaf-face back">{face(shown.back)}</div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Laid out once, out of sight, to count each chapter's pages. */}
      {chapters && (
        <div className="book-measure" ref={measurer} aria-hidden>
          {chapters.map((c, i) => (
            <div key={i} className="book-viewport">
              <div className="book-columns" dangerouslySetInnerHTML={{ __html: c.html }} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Book-sized pages (2:3) that fit two side by side in the window. */
function pageSize() {
  const height = Math.max(
    320,
    Math.floor(Math.min(window.innerHeight - 110, ((window.innerWidth - 80) / 2) * 1.5)),
  )
  const width = Math.floor(height / 1.5)
  const pad = Math.round(width * 0.1)
  return { width, height, pad, gap: 2 * pad, font: Math.max(11, Math.round(width / 30)) }
}
