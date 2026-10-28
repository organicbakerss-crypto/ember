import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { describeError } from '../api'
import { registerFlusher } from '../saving'

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'

const PAUSE_MS = 800 // save after this long without typing...
const MAX_WAIT_MS = 5000 // ...or at least this often while typing nonstop
const RETRY_MS = 5000

/**
 * Autosave for one document (a chapter, a world entry). Changes are collected
 * as a patch and saved on a pause in typing; saves run one at a time, in
 * order. Rich text isn't copied on every keystroke: `collect` reads it at save
 * time. A failed save keeps its changes and retries. Pending changes are saved
 * when the document closes or the window is about to close.
 */
export function useAutosave<P extends object>(
  save: (patch: P) => Promise<unknown>,
  /** The current rich text, read when a save starts (null when it can't be read). */
  collect: () => Partial<P> | null,
) {
  const [state, setState] = useState<SaveState>('saved')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<Partial<P>>({})
  const contentDirty = useRef(false)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const firstChangeAt = useRef<number | null>(null)
  const latest = useRef({ save, collect })
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve())
  useLayoutEffect(() => {
    latest.current = { save, collect }
  })

  const isDirty = () => contentDirty.current || Object.keys(pending.current).length > 0

  /** Takes a snapshot of everything pending right now and queues it to be saved. */
  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current)
    firstChangeAt.current = null
    if (!isDirty()) return queue.current
    const collected = contentDirty.current ? latest.current.collect() : null
    const patch = { ...pending.current, ...collected } as P
    pending.current = {}
    contentDirty.current = false
    const { save: send } = latest.current

    queue.current = queue.current.then(async () => {
      setState('saving')
      try {
        await send(patch)
        setError(null)
        setState(isDirty() ? 'unsaved' : 'saved')
      } catch (err) {
        // Put the changes back (newer edits win) and try again shortly.
        const fields = { ...patch } as Partial<P>
        for (const key of Object.keys(collected ?? {})) delete fields[key as keyof P]
        pending.current = { ...fields, ...pending.current }
        if (collected) contentDirty.current = true
        const { code, message } = describeError(err)
        setError(message)
        setState('error')
        clearTimeout(timer.current)
        // Something that no longer exists (trashed elsewhere) can't be saved; don't retry forever.
        if (code !== 'not-found') {
          timer.current = setTimeout(() => void flushRef.current(), RETRY_MS)
        }
      }
    })
    return queue.current
  }, [])

  useEffect(() => {
    flushRef.current = flush
  }, [flush])

  const schedule = useCallback(() => {
    setState('unsaved')
    const now = Date.now()
    firstChangeAt.current ??= now
    const delay = Math.min(PAUSE_MS, Math.max(0, MAX_WAIT_MS - (now - firstChangeAt.current)))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), delay)
  }, [flush])

  /** Plain fields changed (title, name, aliases…). */
  const changeFields = useCallback(
    (fields: Partial<P>) => {
      pending.current = { ...pending.current, ...fields }
      schedule()
    },
    [schedule],
  )

  /** The rich text changed; it is read by `collect` when the save runs. */
  const changeContent = useCallback(() => {
    contentDirty.current = true
    schedule()
  }, [schedule])

  // Save when the document closes, and whenever the window asks before closing.
  useEffect(() => {
    const unregister = registerFlusher(flush)
    return () => {
      unregister()
      void flush()
    }
  }, [flush])

  return { state, error, changeFields, changeContent, flush }
}
