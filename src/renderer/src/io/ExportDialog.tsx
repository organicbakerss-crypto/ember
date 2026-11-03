import { useEffect, useState } from 'react'
import type { OutlineView, SeriesSummary, VolumeSummary } from '@shared/ipc'
import type { ExportSettings } from '@shared/settings'
import { api, describeError } from '../api'
import { chapterOrder, toContainers } from '../binder/model'
import { useOverlays } from '../components/overlays'
import { useSettings } from '../useTheme'

type Format = 'docx' | 'pdf' | 'epub' | 'markdown'

const FORMATS: { value: Format; label: string; note: string }[] = [
  { value: 'docx', label: 'Word (.docx)', note: 'For editors, agents and print-on-demand tools.' },
  { value: 'pdf', label: 'PDF', note: 'A book-like copy to read or print.' },
  { value: 'epub', label: 'EPUB', note: 'An e-book for readers and stores.' },
  { value: 'markdown', label: 'Markdown', note: 'Plain text with simple formatting.' },
]

/**
 * Exports a volume, one chapter, or chosen chapters. How it looks (author,
 * headings, scene breaks, paragraphs, paper) is saved in the app settings,
 * so the next export looks the same.
 */
export function ExportDialog(props: {
  series: SeriesSummary
  volume: VolumeSummary
  /** The chapter open in the writing view, if any (offered as "This chapter"). */
  chapterId?: string | null
  /** Start with "This chapter" chosen (from a chapter's menu). */
  startWithChapter?: boolean
  onClose: () => void
}) {
  const { series, volume } = props
  const { settings, update } = useSettings()
  const { toast } = useOverlays()
  const [format, setFormat] = useState<Format>('docx')
  const [scope, setScope] = useState<'volume' | 'chapter' | 'choose'>(
    props.startWithChapter && props.chapterId ? 'chapter' : 'volume',
  )
  const [outline, setOutline] = useState<OutlineView | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // Chapter headings are this book's own choice (a collection of stories wants just
  // titles); everything else is shared by every export.
  const own = volume.settings['headings']
  const [headings, setHeadings] = useState<ExportSettings['headings'] | null>(
    own === 'both' || own === 'number' || own === 'title' ? own : null,
  )
  const style = { ...settings.export, headings: headings ?? settings.export.headings }
  const setStyle = ({ headings: next, ...rest }: Partial<ExportSettings>) => {
    if (next) {
      setHeadings(next)
      void api
        .invoke('volume:update', { seriesId: series.id, volumeId: volume.id, headings: next })
        .catch((err: unknown) => toast(describeError(err).message))
    }
    if (Object.keys(rest).length) {
      update(({ export: current }) => ({ export: { ...current, ...rest } }))
    }
  }

  useEffect(() => {
    void api
      .invoke('outline:get', { seriesId: series.id, volumeId: volume.id })
      .then(setOutline, () => {})
  }, [series.id, volume.id])
  const order = outline ? chapterOrder(toContainers(outline.outline)) : []
  const titleOf = (id: string) => outline?.chapters[id]?.title || 'Untitled chapter'

  const chapterIds =
    scope === 'chapter' && props.chapterId
      ? [props.chapterId]
      : scope === 'choose'
        ? order.filter((id) => chosen.has(id))
        : undefined

  const run = async () => {
    setBusy(true)
    try {
      const result = await api.invoke('export:volume', {
        seriesId: series.id,
        volumeId: volume.id,
        format,
        chapterIds,
      })
      toast(
        `Exported ${result.chapters} ${result.chapters === 1 ? 'chapter' : 'chapters'} to ${result.path}` +
          (result.skipped.length
            ? `. ${result.skipped.length} couldn’t be read and were left out.`
            : ''),
      )
      props.onClose()
    } catch (err) {
      const e = describeError(err)
      if (e.code !== 'cancelled') toast(`Couldn’t export: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card stack dialog export-dialog"
        role="dialog"
        aria-label="Export"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h2>Export “{volume.name}”</h2>
        <fieldset className="plain-fieldset">
          <legend className="small muted">Format</legend>
          {FORMATS.map((f) => (
            <label key={f.value} className="radio">
              <input
                type="radio"
                name="export-format"
                checked={format === f.value}
                onChange={() => setFormat(f.value)}
              />
              <span>
                {f.label} <span className="muted small">{f.note}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="plain-fieldset">
          <legend className="small muted">What</legend>
          <label className="radio">
            <input
              type="radio"
              name="export-scope"
              checked={scope === 'volume'}
              onChange={() => setScope('volume')}
            />
            The whole volume ({order.length} {order.length === 1 ? 'chapter' : 'chapters'})
          </label>
          {props.chapterId && (
            <label className="radio">
              <input
                type="radio"
                name="export-scope"
                checked={scope === 'chapter'}
                onChange={() => setScope('chapter')}
              />
              This chapter: {titleOf(props.chapterId)}
            </label>
          )}
          <label className="radio">
            <input
              type="radio"
              name="export-scope"
              checked={scope === 'choose'}
              onChange={() => setScope('choose')}
            />
            Chosen chapters
          </label>
          {scope === 'choose' && (
            <ul className="export-chapters">
              {order.map((id) => (
                <li key={id}>
                  <label className="radio small">
                    <input
                      type="checkbox"
                      checked={chosen.has(id)}
                      onChange={(e) =>
                        setChosen((s) => {
                          const next = new Set(s)
                          if (e.target.checked) next.add(id)
                          else next.delete(id)
                          return next
                        })
                      }
                    />
                    {titleOf(id)}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <ExportStyleFields
          value={style}
          onChange={setStyle}
          pdf={format === 'pdf'}
          headingsLabel="Chapter headings (this book)"
        />
        <div className="row">
          <span className="status-spacer" />
          <button onClick={props.onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy || (scope === 'choose' && !chosen.size)}
            onClick={() => void run()}
          >
            {busy ? 'Exporting…' : 'Export…'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** How exports look; the same fields appear in Settings → Import & export. */
export function ExportStyleFields(props: {
  value: ExportSettings
  onChange: (patch: Partial<ExportSettings>) => void
  /** Show the PDF paper size. */
  pdf?: boolean
  headingsLabel?: string
}) {
  const { value: s, onChange } = props
  return (
    <div className="export-style">
      <label>
        Author (title page)
        <input
          value={s.author}
          placeholder="Your name or pen name"
          onChange={(e) => onChange({ author: e.target.value })}
        />
      </label>
      <label>
        {props.headingsLabel ?? 'Chapter headings'}
        <select
          value={s.headings}
          onChange={(e) => onChange({ headings: e.target.value as ExportSettings['headings'] })}
        >
          <option value="both">Chapter 1: Arrival</option>
          <option value="number">Chapter 1</option>
          <option value="title">Arrival</option>
        </select>
      </label>
      <label>
        Scene breaks
        <select value={s.sceneBreak} onChange={(e) => onChange({ sceneBreak: e.target.value })}>
          {['* * *', '***', '#', '⁂', '~'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        Paragraphs
        <select
          value={s.paragraphs}
          onChange={(e) => onChange({ paragraphs: e.target.value as ExportSettings['paragraphs'] })}
        >
          <option value="spaced">Spaced (web)</option>
          <option value="indented">Indented (book)</option>
        </select>
      </label>
      {props.pdf !== false && (
        <label>
          PDF paper
          <select
            value={s.paper}
            onChange={(e) => onChange({ paper: e.target.value as ExportSettings['paper'] })}
          >
            <option value="a4">A4</option>
            <option value="letter">US Letter</option>
            <option value="trade">6 × 9 in (paperback)</option>
          </select>
        </label>
      )}
    </div>
  )
}

/** Copies one chapter for pasting into Royal Road, and says so. */
export async function copyChapterForRoyalRoad(
  ref: { seriesId: string; volumeId: string; chapterId: string },
  toast: (message: string) => void,
): Promise<void> {
  try {
    const { title } = await api.invoke('export:royalRoad', ref)
    toast(
      `Copied “${title || 'Untitled chapter'}” for Royal Road. Paste it into the chapter’s text box there; the title goes in its own field.`,
    )
  } catch (err) {
    toast(`Couldn’t copy: ${describeError(err).message}`)
  }
}
