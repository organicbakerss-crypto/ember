import { useEffect, useRef, useState } from 'react'
import { generateJSON } from '@tiptap/core'
import type { SeriesSummary } from '@shared/ipc'
import type { RichTextDoc } from '@shared/schema'
import {
  chapterLine,
  chapterUnits,
  isSceneBreakLine,
  proposeSplits,
  unitsWords,
  type ImportStart,
  type ImportUnit,
  type SplitMode,
} from '@shared/manuscript/importSplit'
import { api, describeError } from '../api'
import { useOverlays } from '../components/overlays'
import { chapterExtensions } from '../editor/extensions'

interface Unit extends ImportUnit {
  html: string
}

interface Proposed extends ImportStart {
  include: boolean
}

/** The top-level pieces of the converted document. */
function unitsOf(html: string): Unit[] {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  return [...body.children].map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: el.textContent ?? '',
    html: el.outerHTML,
  }))
}

/** A piece of front matter that's only a few words (a title page) starts unticked. */
const SHORT_FRONT_MATTER = 40

function proposals(units: Unit[], mode: SplitMode): Proposed[] {
  const starts = proposeSplits(units, mode)
  return starts.map((s, i) => ({
    ...s,
    include:
      i > 0 || s.consumes || unitsWords(chapterUnits(units, starts, i)) >= SHORT_FRONT_MATTER,
  }))
}

/** A chapter's pieces as the editor's document (scene-break lines become scene breaks). */
function contentOf(units: Unit[]): RichTextDoc {
  const html = units
    .map((u) => (u.tag === 'p' && isSceneBreakLine(u.text) ? '<hr>' : u.html))
    .join('')
  return generateJSON(html || '<p></p>', chapterExtensions()) as RichTextDoc
}

const MODES: { value: SplitMode; label: string }[] = [
  { value: 'auto', label: 'Headings and “Chapter …” lines' },
  { value: 'headings', label: 'Headings only' },
  { value: 'lines', label: '“Chapter …” lines only' },
  { value: 'none', label: 'Don’t split (one chapter)' },
]

/**
 * Imports a Word document as chapters. It's read first, and nothing is
 * created until the splits look right: each proposed chapter shows its
 * title, length and first line; chapters can be merged, split at any
 * paragraph, renamed, made interludes, or left out.
 */
export function ImportDialog(props: {
  series: SeriesSummary
  /** Where to add the chapters (a volume of the series); a new volume when left out. */
  volumeId?: string
  onClose: () => void
  onImported: (volumeId: string) => void
}) {
  const { series } = props
  const { toast } = useOverlays()
  const [file, setFile] = useState<{ fileName: string; units: Unit[]; warnings: string[] } | null>(
    null,
  )
  const [mode, setMode] = useState<SplitMode>('auto')
  const [starts, setStarts] = useState<Proposed[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const [target, setTarget] = useState<string>(props.volumeId ?? 'new')
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  // The file is picked once, when the dialog opens (callbacks read through a ref, so a
  // re-render never opens the picker again).
  const latest = useRef({ onClose: props.onClose, toast })
  useEffect(() => {
    latest.current = { onClose: props.onClose, toast }
  })
  useEffect(() => {
    let live = true
    api.invoke('import:docx').then(
      (r) => {
        if (!live) return
        const units = unitsOf(r.html)
        setFile({ fileName: r.fileName, units, warnings: r.warnings })
        setStarts(proposals(units, 'auto'))
        setNewName(r.fileName)
      },
      (err) => {
        const e = describeError(err)
        if (e.code !== 'cancelled') latest.current.toast(`Couldn’t import: ${e.message}`)
        latest.current.onClose()
      },
    )
    return () => {
      live = false
    }
  }, [])

  if (!file) return null
  const { units } = file
  const resplit = (next: SplitMode) => {
    setMode(next)
    setStarts(proposals(units, next))
    setOpen(null)
  }
  const change = (i: number, patch: Partial<Proposed>) =>
    setStarts((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  /** Joins a chapter onto the one before it (its heading stays, as text). */
  const mergeUp = (i: number) => {
    setStarts((s) => s.filter((_, j) => j !== i))
    setOpen(null)
  }
  /** Starts a new chapter at a piece inside chapter i. */
  const splitAt = (at: number) => {
    const line = chapterLine(units[at]!.text)
    const heading = /^h[1-6]$/.test(units[at]!.tag)
    setStarts((s) =>
      [
        ...s,
        {
          at,
          title: line?.title ?? (heading ? units[at]!.text.trim().slice(0, 200) : ''),
          type: line?.type ?? 'chapter',
          consumes: !!line || heading,
          include: true,
        },
      ].sort((a, b) => a.at - b.at),
    )
    setOpen(null)
  }

  const included = starts.filter((s) => s.include)
  const run = async () => {
    setBusy(true)
    try {
      const chapters = starts.flatMap((s, i) =>
        s.include
          ? [
              {
                title: s.title.trim(),
                type: s.type,
                content: contentOf(chapterUnits(units, starts, i) as Unit[]),
              },
            ]
          : [],
      )
      const volumeId =
        target === 'new'
          ? (
              await api.invoke('volume:create', {
                seriesId: series.id,
                name: newName.trim() || file.fileName,
              })
            ).id
          : target
      const { created } = await api.invoke('import:chapters', {
        seriesId: series.id,
        volumeId,
        chapters,
      })
      toast(
        `Imported ${created} ${created === 1 ? 'chapter' : 'chapters'} from “${file.fileName}”.`,
      )
      props.onImported(volumeId)
      props.onClose()
    } catch (err) {
      toast(`Couldn’t import: ${describeError(err).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card stack dialog import-dialog"
        role="dialog"
        aria-label="Import"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h2>Import “{file.fileName}”</h2>
        <p className="muted small">
          Check the chapters below before importing. Nothing is created until you press Import, and
          the Word file isn’t changed.
        </p>
        {file.warnings.length > 0 && (
          <details className="small muted">
            <summary>
              {file.warnings.length} note{file.warnings.length === 1 ? '' : 's'} from reading the
              file
            </summary>
            <ul>
              {file.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="row import-options">
          <label>
            Split at
            <select value={mode} onChange={(e) => resplit(e.target.value as SplitMode)}>
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Into
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="new">A new volume…</option>
              {series.volumes.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} (at the end)
                </option>
              ))}
            </select>
          </label>
          {target === 'new' && (
            <label>
              Volume name
              <input value={newName} onChange={(e) => setNewName(e.target.value)} />
            </label>
          )}
        </div>
        <ol className="import-chapters">
          {starts.map((s, i) => {
            const body = chapterUnits(units, starts, i)
            const first = body.find((u) => u.text.trim())?.text.trim() ?? ''
            const words = unitsWords(body)
            return (
              <li key={s.at} className={`import-chapter ${s.include ? '' : 'skipped'}`}>
                <div className="row">
                  <input
                    type="checkbox"
                    aria-label={`Include chapter ${i + 1}`}
                    checked={s.include}
                    onChange={(e) => change(i, { include: e.target.checked })}
                  />
                  <input
                    className="import-title"
                    aria-label={`Title of chapter ${i + 1}`}
                    placeholder={i === 0 && !s.consumes ? 'Before the first chapter' : 'Untitled'}
                    value={s.title}
                    onChange={(e) => change(i, { title: e.target.value })}
                  />
                  <select
                    aria-label={`Type of chapter ${i + 1}`}
                    value={s.type}
                    onChange={(e) => change(i, { type: e.target.value as Proposed['type'] })}
                  >
                    <option value="chapter">Chapter</option>
                    <option value="interlude">Interlude</option>
                  </select>
                  <span className="muted small">{words.toLocaleString()} words</span>
                  {i > 0 && (
                    <button className="link small" onClick={() => mergeUp(i)}>
                      Join to previous
                    </button>
                  )}
                  <button className="link small" onClick={() => setOpen(open === i ? null : i)}>
                    {open === i ? 'Hide text' : 'Split…'}
                  </button>
                </div>
                {open !== i && first && <p className="muted small import-first">{first}</p>}
                {open === i && (
                  <ul className="import-units">
                    {body.map((u) => {
                      const at = units.indexOf(u as Unit)
                      return (
                        <li key={at} className="small">
                          <button
                            className="link"
                            title="Start a new chapter here"
                            onClick={() => splitAt(at)}
                          >
                            Split here
                          </button>
                          <span className={/^h[1-6]$/.test(u.tag) ? 'import-heading' : ''}>
                            {u.text.trim().slice(0, 140) || '(blank)'}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
        <div className="row">
          <span className="muted small">
            {included.length} {included.length === 1 ? 'chapter' : 'chapters'} to import
          </span>
          <span className="status-spacer" />
          <button onClick={props.onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy || !included.length}
            onClick={() => void run()}
          >
            {busy ? 'Importing…' : `Import ${included.length}`}
          </button>
        </div>
      </div>
    </div>
  )
}
