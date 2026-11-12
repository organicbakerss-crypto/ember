import { useEffect, useState } from 'react'
import type { LibrarySnapshot, OutlineView, SeriesSummary, VolumeStats } from '@shared/ipc'
import { api } from '../api'
import { volumeCover, formatWords } from '../covers'
import { toContainers, chapterOrder } from '../binder/model'
import { loadLocal } from '../storage'
import { Cover } from './Cover'
import { CoverStack } from './CoverStack'
import { colorOf } from './MarginsParts'

interface LastOpened {
  seriesId: string
  volumeId: string
  chapterId?: string
  at?: number
}

function lastOpened(): LastOpened | null {
  try {
    const raw = loadLocal('writing.lastOpened')
    return raw ? (JSON.parse(raw) as LastOpened) : null
  } catch {
    return null
  }
}

function ago(at: number | undefined): string {
  if (!at) return ''
  const days = Math.floor((Date.now() - at) / 86_400_000)
  return days <= 0 ? 'open today' : days === 1 ? 'open yesterday' : `open ${days} days ago`
}

/**
 * The bookshelf's "pick up where you left off": the story last written in,
 * its books (for a series), that book's chapters as a strip, and a button
 * straight back to the chapter.
 */
export function ShelfHero(props: {
  snapshot: LibrarySnapshot
  onOpenVolume: (seriesId: string, volumeId: string) => void
}) {
  const last = lastOpened()
  const series =
    props.snapshot.series.find((s) => s.id === last?.seriesId) ??
    props.snapshot.series.find((s) => s.volumes.length > 0)
  const volume =
    series?.volumes.find((v) => v.id === last?.volumeId) ??
    series?.volumes[series.volumes.length - 1]
  const [book, setBook] = useState<{ view: OutlineView; stats: VolumeStats } | null>(null)
  const seriesId = series?.id
  const volumeId = volume?.id
  useEffect(() => {
    if (!seriesId || !volumeId) return
    let live = true
    Promise.all([
      api.invoke('outline:get', { seriesId, volumeId }),
      api.invoke('volume:stats', { seriesId, volumeId }),
    ]).then(
      ([view, stats]) => live && setBook({ view, stats }),
      () => {},
    )
    return () => {
      live = false
    }
  }, [seriesId, volumeId])
  if (!series || !volume) return null

  const order = book
    ? chapterOrder(toContainers(book.view.outline)).filter((id) => id in book.view.chapters)
    : []
  const chapterId =
    last?.volumeId === volume.id && last.chapterId && order.includes(last.chapterId)
      ? last.chapterId
      : order[order.length - 1]
  const at = chapterId ? order.indexOf(chapterId) : -1
  const chapter = chapterId ? book?.view.chapters[chapterId] : undefined
  const words = (id: string) => book?.stats.chapterWords[id] ?? 0
  const max = Math.max(1, ...order.map(words))
  const multi = series.volumes.length > 1
  const seriesWords = series.volumes.reduce((n, v) => n + v.wordCount, 0)

  return (
    <section className="shelf-hero" aria-label="Pick up where you left off">
      <div className="shelf-hero-cover">
        <CoverStack
          sources={[
            volumeCover(series, volume),
            ...series.volumes.filter((v) => v.id !== volume.id).map((v) => volumeCover(series, v)),
          ]}
        />
      </div>
      <div className="shelf-hero-main">
        <div className="shelf-kicker">Pick up where you left off</div>
        <h1 className="shelf-hero-title">{series.name}</h1>
        <div className="shelf-hero-sub">
          {[
            multi ? volume.name : null,
            chapter ? `Chapter ${at + 1}, “${chapter.title || 'Untitled'}”` : null,
            last?.seriesId === series.id ? ago(last.at) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        <button className="shelf-continue" onClick={() => props.onOpenVolume(series.id, volume.id)}>
          Continue writing{chapter && <span> → Ch {at + 1}</span>}
        </button>
        {multi && <Books series={series} current={volume.id} onOpen={props.onOpenVolume} />}
        {order.length > 0 && (
          <div className="shelf-mini" aria-hidden>
            {order.map((id) => {
              const c = book!.view.chapters[id]!
              const pov = c.povs?.[0]?.name ?? c.pov ?? null
              const w = words(id)
              return (
                <i
                  key={id}
                  className={`${id === chapterId ? 'on' : ''} ${w ? '' : 'empty'}`}
                  title={`${c.title || 'Untitled'} · ${w.toLocaleString()} words`}
                  style={{
                    height: w ? `${Math.max(12, (w / max) * 100)}%` : undefined,
                    background: w ? (pov ? colorOf(pov) : 'var(--muted)') : undefined,
                  }}
                />
              )
            })}
          </div>
        )}
        <div className="shelf-hero-meta">
          <span>
            {multi ? `${volume.name}: ` : ''}
            <b>{volume.wordCount.toLocaleString()}</b> words · <b>{order.length}</b> chapters
          </span>
          {multi && (
            <span>
              Series: <b>{seriesWords.toLocaleString()}</b> words
            </span>
          )}
        </div>
      </div>
    </section>
  )
}

function Books(props: {
  series: SeriesSummary
  current: string
  onOpen: (seriesId: string, volumeId: string) => void
}) {
  return (
    <div className="shelf-books">
      {props.series.volumes.map((v) => (
        <button
          key={v.id}
          className={`shelf-book ${v.id === props.current ? 'on' : ''}`}
          onClick={() => props.onOpen(props.series.id, v.id)}
        >
          <span className="shelf-book-cover">
            <Cover source={volumeCover(props.series, v)} />
          </span>
          <span>
            <b>
              {v.name}
              {v.finished ? ' ✓' : ''}
            </b>
            <small>
              {v.wordCount
                ? `${formatWords(v.wordCount)}${v.id === props.current ? ' · writing' : ''}`
                : 'not started'}
            </small>
          </span>
        </button>
      ))}
    </div>
  )
}
