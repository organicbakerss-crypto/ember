import { useState, type ReactNode } from 'react'
import type { JSONContent } from '@tiptap/react'
import { assemble, type DocNode, type Pair } from '@shared/ai/chapterEdit'
import { diffText } from '@shared/ai/diff'

export interface EditResult {
  pairs: Pair[]
  oldBlocks: { md: string; node: DocNode }[]
  newBlocks: { md: string; node: DocNode }[]
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/** A block's Markdown as plain text to read (marks shown as they are written). */
const shown = (md: string) => md

/**
 * The AI's edit, already in the chapter, side by side with what was there:
 * the old text on the left, the new on the right with every change marked
 * (worked out here, not reported by the AI; changed wording marked more
 * strongly than spelling and punctuation). Undo a single change, undo all,
 * or keep it.
 */
export function CompareDialog(props: {
  chapterTitle: string
  result: EditResult
  /** Puts this version of the chapter on the page. */
  apply: (doc: JSONContent) => void
  onDone: (outcome: { kept: boolean; undone: number; changes: number }) => void
}) {
  const { pairs, oldBlocks, newBlocks } = props.result
  const [undone, setUndone] = useState<boolean[]>(() => pairs.map(() => false))
  const changed = pairs.map((p, k) => (p.same ? -1 : k)).filter((k) => k >= 0)
  const oldWords = words(oldBlocks.map((b) => b.md).join(' '))
  const newWords = words(newBlocks.map((b) => b.md).join(' '))
  const shrank = newWords < oldWords * 0.7

  const toggle = (k: number) => {
    const next = undone.map((u, j) => (j === k ? !u : u))
    setUndone(next)
    props.apply(assemble(pairs, oldBlocks, newBlocks, next) as JSONContent)
  }
  const undoAll = () => {
    props.apply(
      assemble(
        pairs,
        oldBlocks,
        newBlocks,
        pairs.map(() => true),
      ) as JSONContent,
    )
    props.onDone({ kept: false, undone: changed.length, changes: changed.length })
  }
  const keep = () =>
    props.onDone({ kept: true, undone: undone.filter(Boolean).length, changes: changed.length })

  const sides = (p: Pair): { left: ReactNode; right: ReactNode; kind: string } => {
    const before = p.old !== null ? oldBlocks[p.old]!.md : null
    const after = p.new !== null ? newBlocks[p.new]!.md : null
    if (before === null) return { left: null, right: <ins>{shown(after!)}</ins>, kind: 'added' }
    if (after === null) return { left: <del>{shown(before)}</del>, right: null, kind: 'removed' }
    const changes = diffText(before, after)
    const left: ReactNode[] = []
    const right: ReactNode[] = []
    let a = 0
    changes.forEach((c, i) => {
      left.push(before.slice(a, c.start))
      right.push(before.slice(a, c.start))
      if (c.before)
        left.push(
          <del key={`d${i}`} className={c.kind}>
            {c.before}
          </del>,
        )
      if (c.after)
        right.push(
          <ins key={`i${i}`} className={c.kind}>
            {c.after}
          </ins>,
        )
      a = c.end
    })
    left.push(before.slice(a))
    right.push(before.slice(a))
    const wording = changes.some((c) => c.kind === 'wording')
    return { left, right, kind: wording ? 'wording' : 'fix' }
  }

  return (
    <div className="modal-backdrop">
      <div className="card dialog compare-dialog" role="dialog" aria-label="What the AI changed">
        <header className="compare-head">
          <div>
            <h2>What the AI changed in “{props.chapterTitle || 'Untitled'}”</h2>
            <p className="muted small">
              {changed.length === 0
                ? 'Nothing changed.'
                : `${changed.length} ${changed.length === 1 ? 'place' : 'places'} changed. It’s already in your chapter; the version before is in History. Undo any change, undo them all, or keep it.`}
            </p>
            {shrank && (
              <p className="error small">
                The new version is much shorter ({newWords.toLocaleString()} words, was{' '}
                {oldWords.toLocaleString()}). Check nothing was lost.
              </p>
            )}
          </div>
          <div className="row">
            <button onClick={undoAll} disabled={changed.length === 0}>
              Undo all
            </button>
            <button className="primary" onClick={keep}>
              Keep
            </button>
          </div>
        </header>
        <div className="compare-cols compare-labels small muted">
          <span>Before</span>
          <span>After</span>
        </div>
        <div className="compare-body">
          {pairs.map((p, k) => {
            if (p.same) {
              const md = newBlocks[p.new!]!.md
              return (
                <div key={k} className="compare-row same">
                  <div className="compare-cell">{shown(md)}</div>
                  <div className="compare-cell">{shown(md)}</div>
                </div>
              )
            }
            const { left, right, kind } = sides(p)
            return (
              <div key={k} className={`compare-row changed ${kind} ${undone[k] ? 'undone' : ''}`}>
                <div className="compare-cell">{left}</div>
                <div className="compare-cell">
                  {undone[k] ? (
                    <span className="muted small">Undone: your text is back.</span>
                  ) : (
                    right
                  )}
                  <button className="link small compare-undo" onClick={() => toggle(k)}>
                    {undone[k] ? 'Use the change' : 'Undo this'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
