import { useEffect, useId, useRef, useState } from 'react'
import { diffText, type TextChange } from '@shared/ai/diff'
import { api, describeError, useIpcEvent } from '../api'
import type { BlockChange } from '../editor/textBlocks'
import { flushAll } from '../saving'

/** Spaces alone are invisible; show them as ␣. */
const shown = (text: string) => (text.trim() ? text : text.replace(/ /g, '␣'))

interface Item extends TextChange {
  block: number
  on: boolean
}

/**
 * Spelling and grammar with AI, as a preview of the whole chapter: every
 * change the AI made is shown, worked out by the app itself. Fixes start
 * ticked; changed wording (which it shouldn't do) starts unticked. Nothing
 * changes until Apply, and the version before is kept in History.
 */
export function GrammarDialog(props: {
  seriesId: string
  volumeId: string
  chapterId: string
  worldId: string | null
  blocks: () => string[] | null
  apply: (expected: string[], changes: BlockChange[]) => number
  onClose: () => void
  toast: (message: string) => void
}) {
  const [original] = useState(() => props.blocks())
  const [items, setItems] = useState<Item[] | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(`grammar${useId()}`)

  useIpcEvent('ai:progress', (p) => {
    if (p.requestId === requestId.current) setProgress({ done: p.done, total: p.total })
  })

  useEffect(() => {
    if (!original) return
    let live = true
    const id = requestId.current
    api.invoke('ai:grammar', { requestId: id, paragraphs: original, worldId: props.worldId }).then(
      ({ paragraphs }) => {
        if (!live) return
        setItems(
          paragraphs.flatMap((fixed, block) =>
            diffText(original[block]!, fixed).map((c) => ({ ...c, block, on: c.kind === 'fix' })),
          ),
        )
      },
      (err) => {
        const e = describeError(err)
        if (live && e.code !== 'cancelled') setError(e.message)
      },
    )
    return () => {
      live = false
      void api.invoke('ai:cancel', { requestId: id })
    }
  }, [original, props.worldId])

  const toggle = (k: number) =>
    setItems((list) => list && list.map((x, j) => (j === k ? { ...x, on: !x.on } : x)))
  const chosen = items?.filter((x) => x.on) ?? []

  const apply = async () => {
    if (!original || !items) return
    await flushAll()
    await api
      .invoke('history:keep', {
        seriesId: props.seriesId,
        volumeId: props.volumeId,
        chapterId: props.chapterId,
        reason: 'before-ai',
      })
      .catch(() => {})
    const applied = props.apply(
      original,
      chosen.map((c) => ({ block: c.block, start: c.start, end: c.end, text: c.after })),
    )
    props.toast(
      applied === chosen.length
        ? `Applied ${applied} ${applied === 1 ? 'change' : 'changes'}. The version before is in History.`
        : `Applied ${applied} of ${chosen.length} changes (the rest touched text that changed meanwhile). The version before is in History.`,
    )
    props.onClose()
  }

  const blocks = [...new Set(items?.map((x) => x.block))]
  const fixes = items?.filter((x) => x.kind === 'fix').length ?? 0
  const wording = (items?.length ?? 0) - fixes

  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div
        className="card stack dialog grammar-dialog"
        role="dialog"
        aria-label="Spelling and grammar"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h2>Spelling and grammar</h2>
        {!original ? (
          <p>This chapter is being edited in another window or pane. Check it there.</p>
        ) : error ? (
          <p className="error">{error}</p>
        ) : !items ? (
          <div className="stack">
            <p className="muted">
              Checking{progress ? ` ${progress.done} of ${progress.total} paragraphs` : ''}… A long
              chapter can take a minute or two.
            </p>
            <progress max={progress?.total || 1} value={progress?.done ?? 0} />
          </div>
        ) : items.length === 0 ? (
          <p>No changes suggested.</p>
        ) : (
          <>
            <p className="muted small">
              {fixes} {fixes === 1 ? 'fix' : 'fixes'}
              {wording > 0 && (
                <>
                  {' '}
                  and{' '}
                  <span className="grammar-wording-label">
                    {wording} wording {wording === 1 ? 'change' : 'changes'}
                  </span>{' '}
                  (unticked: it shouldn’t change your words; tick any you want)
                </>
              )}
              . Click a change to tick or untick it.
            </p>
            <div className="grammar-preview">
              {blocks.map((b) => {
                const text = original[b]!
                const here = items
                  .map((x, k) => ({ ...x, k }))
                  .filter((x) => x.block === b)
                  .sort((x, y) => x.start - y.start)
                const parts: React.ReactNode[] = []
                let at = 0
                for (const c of here) {
                  parts.push(text.slice(at, c.start))
                  parts.push(
                    <button
                      key={c.k}
                      className={`grammar-change ${c.kind} ${c.on ? 'on' : 'off'}`}
                      aria-pressed={c.on}
                      title={c.on ? 'Click to keep your text' : 'Click to use this change'}
                      onClick={() => toggle(c.k)}
                    >
                      {c.before && <del>{shown(c.before)}</del>}
                      {c.after && <ins>{shown(c.after)}</ins>}
                    </button>,
                  )
                  at = c.end
                }
                parts.push(text.slice(at))
                return (
                  <p key={b} className="grammar-paragraph">
                    {parts}
                  </p>
                )
              })}
            </div>
          </>
        )}
        <div className="row">
          {items && items.length > 0 && (
            <>
              <button
                className="link small"
                onClick={() => setItems(items.map((x) => ({ ...x, on: x.kind === 'fix' })))}
              >
                Just the fixes
              </button>
              <button
                className="link small"
                onClick={() => setItems(items.map((x) => ({ ...x, on: false })))}
              >
                Untick all
              </button>
            </>
          )}
          <span className="status-spacer" />
          <button onClick={props.onClose}>{items ? 'Cancel' : 'Stop'}</button>
          {items && items.length > 0 && (
            <button className="primary" disabled={!chosen.length} onClick={() => void apply()}>
              Apply {chosen.length} {chosen.length === 1 ? 'change' : 'changes'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
