import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { IpcInput } from '@shared/ipc'
import type { RichTextDoc } from '@shared/schema'
import { api, describeError } from '../api'
import { registerFlusher } from '../saving'

type ChapterPatch = IpcInput<'chapter:save'>['patch']
export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'

const PAUSE_MS = 800 // save after this long without typing...
const MAX_WAIT_MS = 5000 // ...or at least this often while typing nonstop
const RETRY_MS = 5000

/**
 * Autosave for one chapter. Changes are collected as a patch and saved on a
 * pause in typing; saves run one at a time, in order. A failed save keeps its
 * changes and retries. Pending changes are saved when the chapter closes or
 * the window is about to close.
 */
export function useChapterSaver(
  ref: { seriesId: string; volumeId: string; chapterId: string },
  getContent: () => RichTextDoc | null,
) {
  const [state, setState] = useState<SaveState>('saved')
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<ChapterPatch>({})
  const contentDirty = useRef(false)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const firstChangeAt = useRef<number | null>(null)
  const latest = useRef({ ref, getContent })
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve())
  useLayoutEffect(() => {
    latest.current = { ref, getContent }
  })

  const isDirty = () => contentDirty.current || Object.keys(pending.current).length > 0

  /** Takes a snapshot of everything pending right now and queues it to be saved. */
  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current)
    firstChangeAt.current = null
    if (!isDirty()) return queue.current
    const patch: ChapterPatch = { ...pending.current }
    if (contentDirty.current) {
      const content = latest.current.getContent()
      if (content) patch.content = content
    }
    pending.current = {}
    contentDirty.current = false
    const { seriesId, volumeId, chapterId } = latest.current.ref

    queue.current = queue.current.then(async () => {
      setState('saving')
      try {
        await api.invoke('chapter:save', { seriesId, volumeId, chapterId, patch })
        setError(null)
        setState(isDirty() ? 'unsaved' : 'saved')
      } catch (err) {
        // Put the changes back (newer edits win) and try again shortly.
        const { content, ...fields } = patch
        pending.current = { ...fields, ...pending.current }
        if (content) contentDirty.current = true
        const { code, message } = describeError(err)
        setError(message)
        setState('error')
        clearTimeout(timer.current)
        // A chapter that no longer exists (trashed elsewhere) can't be saved; don't retry forever.
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

  const changeFields = useCallback(
    (fields: Omit<ChapterPatch, 'content'>) => {
      pending.current = { ...pending.current, ...fields }
      schedule()
    },
    [schedule],
  )

  const changeContent = useCallback(() => {
    contentDirty.current = true
    schedule()
  }, [schedule])

  // Save when the chapter closes, and whenever the window asks before closing.
  useEffect(() => {
    const unregister = registerFlusher(flush)
    return () => {
      unregister()
      void flush()
    }
  }, [flush])

  return { state, error, changeFields, changeContent, flush }
}
