import { useCallback, useEffect, useRef } from 'react'
import { describeError } from '../api'
import { useOverlays } from '../components/overlays'
import { modKey } from '../components/commands'

export interface UndoStep {
  /** What was done, e.g. "Deleted Gullhaven". */
  label: string
  undo: () => Promise<unknown>
}

const MAX_STEPS = 50

function isTextField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  )
}

/**
 * Undo for world actions (deleting, linking, merging, changing facts). Each
 * action shows a notice with Undo; Ctrl/Cmd+Z undoes the latest one when
 * the cursor isn't in a text field (text has its own undo).
 */
export function useUndo() {
  const steps = useRef<UndoStep[]>([])
  const { toast } = useOverlays()

  const runUndo = useCallback(
    async (step: UndoStep) => {
      steps.current = steps.current.filter((s) => s !== step)
      try {
        await step.undo()
        toast(`Undone: ${step.label}`)
      } catch (err) {
        toast(`Couldn’t undo: ${describeError(err).message}`)
      }
    },
    [toast],
  )

  const record = useCallback(
    (step: UndoStep, notify = true) => {
      steps.current = [...steps.current, step].slice(-MAX_STEPS)
      if (notify) toast(step.label, { label: 'Undo', run: () => runUndo(step) })
    },
    [toast, runUndo],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!modKey(e) || e.shiftKey || e.key.toLowerCase() !== 'z' || isTextField(e.target)) return
      const step = steps.current.at(-1)
      if (!step) return
      e.preventDefault()
      void runUndo(step)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runUndo])

  return record
}
