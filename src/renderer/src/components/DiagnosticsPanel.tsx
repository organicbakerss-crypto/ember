import { useCallback, useEffect, useMemo, useState } from 'react'
import { computeStats, repeatedWords, type AnalysisWordOptions } from '@shared/analysis'
import { api, describeError, useIpcEvent } from '../api'
import { STAT_ROWS, formatWords } from '../analysisFormat'
import { useOverlays } from './overlays'

type Scope = 'selection' | 'chapter' | 'volume'

interface ChapterText {
  id: string
  title: string
  paragraphs: string[]
}

/**
 * Descriptive statistics for the selection, the chapter or the whole
 * volume, all computed on this device. Not quality scores.
 */
export function DiagnosticsPanel(props: {
  seriesId: string
  volumeId: string
  chapterId: string | null
  chapterTitle: string
  /** The open chapter's paragraphs as they are on the page now. */
  chapterParagraphs: string[]
  selectionParagraphs: string[] | null
  words: AnalysisWordOptions
  highlightStem: string | null
  onHighlight: (stem: string | null) => void
  onOpenChapter: (chapterId: string) => void
}) {
  const { seriesId, volumeId } = props
  const [scope, setScope] = useState<Scope>(props.selectionParagraphs ? 'selection' : 'chapter')
  const [volume, setVolume] = useState<ChapterText[] | null>(null)
  const { toast } = useOverlays()

  const loadVolume = useCallback(() => {
    api
      .invoke('volume:texts', { seriesId, volumeId })
      .then(setVolume, (err) => toast(describeError(err).message))
  }, [seriesId, volumeId, toast])
  useEffect(() => {
    if (scope === 'volume') loadVolume()
  }, [scope, loadVolume])
  useIpcEvent('library:changed', (c) => {
    if (scope === 'volume' && c.kind === 'outline' && c.volumeId === volumeId) loadVolume()
  })

  // Volume texts, with the open chapter as it is on the page right now.
  const chapters = useMemo(
    () =>
      volume?.map((c) =>
        c.id === props.chapterId
          ? { ...c, title: props.chapterTitle, paragraphs: props.chapterParagraphs }
          : c,
      ) ?? [],
    [volume, props.chapterId, props.chapterTitle, props.chapterParagraphs],
  )

  const paragraphs = useMemo(() => {
    if (scope === 'selection') return props.selectionParagraphs ?? []
    if (scope === 'chapter') return props.chapterParagraphs
    return chapters.flatMap((c) => c.paragraphs)
  }, [scope, props.selectionParagraphs, props.chapterParagraphs, chapters])

  const stats = useMemo(() => computeStats(paragraphs), [paragraphs])
  const repeated = useMemo(
    () => repeatedWords(paragraphs, props.words, 15),
    [paragraphs, props.words],
  )
  const lengths = useMemo(
    () => chapters.map((c) => ({ ...c, words: computeStats(c.paragraphs).words })),
    [chapters],
  )
  const longest = Math.max(1, ...lengths.map((c) => c.words))
  const median = medianOf(lengths.map((c) => c.words))

  return (
    <div className="diagnostics">
      <h2>Diagnostics</h2>
      <div className="segmented" role="radiogroup" aria-label="Scope">
        {(['selection', 'chapter', 'volume'] as const).map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={scope === s}
            className={scope === s ? 'active' : ''}
            onClick={() => setScope(s)}
          >
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>
      {scope === 'selection' && !props.selectionParagraphs && (
        <p className="muted small">Select some text on the page to see its statistics.</p>
      )}

      <dl className="stat-list">
        {STAT_ROWS.map((row) => (
          <div key={row.key} title={row.hint}>
            <dt>{row.label}</dt>
            <dd>{row.value(stats)}</dd>
          </div>
        ))}
      </dl>

      <h3 className="small">Repeated words</h3>
      {repeated.length === 0 ? (
        <p className="muted small">No content word is used more than once.</p>
      ) : (
        <>
          <p className="muted small">Click a word to highlight it in this chapter.</p>
          <ol className="repeated-words">
            {repeated.map((w) => (
              <li key={w.stem}>
                <button
                  className={`repeated-word ${props.highlightStem === w.stem ? 'active' : ''}`}
                  aria-pressed={props.highlightStem === w.stem}
                  onClick={() => props.onHighlight(props.highlightStem === w.stem ? null : w.stem)}
                >
                  <span>{w.word}</span>
                  <span className="muted">{w.count.toLocaleString()} times</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}

      {scope === 'volume' && lengths.length > 0 && (
        <>
          <h3 className="small">Chapter lengths</h3>
          <p className="muted small">
            Median {formatWords(Math.round(median))}. The line marks the median.
          </p>
          <ol className="chapter-lengths">
            {lengths.map((c) => (
              <li key={c.id}>
                <button
                  className="chapter-length"
                  title={`${c.title || 'Untitled chapter'}: ${formatWords(c.words)}`}
                  onClick={() => props.onOpenChapter(c.id)}
                >
                  <span className="chapter-length-name">{c.title || 'Untitled chapter'}</span>
                  <span className="chapter-length-track">
                    <span
                      className="chapter-length-bar"
                      style={{ width: `${(c.words / longest) * 100}%` }}
                    />
                    <span
                      className="chapter-length-median"
                      style={{ left: `${(median / longest) * 100}%` }}
                    />
                  </span>
                  <span className="muted chapter-length-words">{formatWords(c.words)}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}

      <p className="muted small diagnostics-note">Descriptive signals, not quality scores.</p>
    </div>
  )
}

function medianOf(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
